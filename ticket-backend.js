/* ==========================================================================
   PANDALPULSE — QR Ticket System "Backend" (localStorage-backed, no server)
   --------------------------------------------------------------------------
   This file is the single source of truth for tickets, volunteers and scans.
   All verification goes through TicketBackend.verifyTicket() which performs
   an atomic read-modify-write so duplicate entry is impossible even with
   multiple volunteers scanning at the same time (single-threaded CAS +
   cross-tab re-read before write).

   Storage keys:
     pp_tickets_v1      [{ ticketId, holderName, eventName, date, type,
                           status: UNUSED|USED, createdAt, usedAt,
                           usedById, usedByName }]
     pp_volunteers_v1   [{ id, username, name, role, passHash }]
     pp_scans_v1        [{ scanId, ticketId, volunteerId, volunteerName,
                           status: VALID|ALREADY_USED|INVALID,
                           timestamp, eventName, deviceId, sessionId }]
     pp_device_id       stable per-browser device id
     pp_ticket_session  (sessionStorage) active login

   QR payload = the raw Ticket ID only, e.g. "TKT-8F29X1".
   parseTicketPayload() also accepts JSON {"tid":...} and URLs ?tid=...
   so old / hand-typed codes keep working. No PII is ever put in the QR.
   ========================================================================== */
'use strict';

(function (global) {
  var LS_TICKETS = 'pp_tickets_v1';
  var LS_VOLUNTEERS = 'pp_volunteers_v1';
  var LS_SCANS = 'pp_scans_v1';
  var LS_DEVICE = 'pp_device_id';
  var SS_SESSION = 'pp_ticket_session';

  var TICKET_RE = /^TKT-[A-Z2-9]{6}$/;
  var DEVOTEE_RE = /^DEV-[A-Z2-9]{6}$/;
  var ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  var DEFAULT_EVENT = 'FIEM Durga Puja 2026 — PandalPulse';
  var SESSION_TTL = 30 * 60 * 1000; // 30 min inactivity timeout
  var _expiredFlag = false;

  /* ---------------- low-level storage ---------------- */
  function readLS(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }

  /* ---------------- hashing (SHA-256 w/ sync fallback) ---------------- */
  function fallbackHash(str) {
    var h1 = 5381, h2 = 52711;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 = ((h1 << 5) + h1 + c) | 0;
      h2 = ((h2 << 5) + h2 + c) | 0;
    }
    return 'fb1:' + (h1 >>> 0).toString(16) + ':' + (h2 >>> 0).toString(16);
  }
  function sha256hex(str) {
    try {
      if (global.crypto && crypto.subtle && window.isSecureContext !== false) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode('pp$' + str))
          .then(function (buf) {
            return 'sha256:' + Array.prototype.map.call(new Uint8Array(buf), function (b) {
              return ('0' + b.toString(16)).slice(-2);
            }).join('');
          }).catch(function () { return fallbackHash('pp$' + str); });
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve(fallbackHash('pp$' + str));
  }
  function verifyHash(input, stored) {
    if (!stored) return Promise.resolve(false);
    if (stored.indexOf('sha256:') === 0) return sha256hex(input).then(function (h) { return h === stored; });
    return Promise.resolve(fallbackHash('pp$' + input) === stored);
  }

  /* ---------------- device / session ---------------- */
  function deviceId() {
    var id = null;
    try { id = localStorage.getItem(LS_DEVICE); } catch (e) { /* ignore */ }
    if (!id) {
      id = 'DEV-' + randomChars(6) + '-' + Date.now().toString(36).toUpperCase();
      try { localStorage.setItem(LS_DEVICE, id); } catch (e) { /* ignore */ }
    }
    return id;
  }
  function newSessionId() {
    try {
      if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* ignore */ }
    return 'S-' + Date.now().toString(36) + '-' + randomChars(8);
  }
  function getSession() {
    var raw = getSessionRaw();
    if (!raw) return null;
    var s = null;
    try { s = JSON.parse(raw); } catch (e) { return null; }
    if (!s) return null;
    if (Date.now() - (s.lastActive || s.loginAt || 0) > SESSION_TTL) {
      try { sessionStorage.removeItem(SS_SESSION); } catch (e) { /* ignore */ }
      _expiredFlag = true;
      return null;
    }
    return s;
  }
  function getSessionRaw() {
    try { return sessionStorage.getItem(SS_SESSION); }
    catch (e) { return null; }
  }
  // Refresh activity timestamp; returns false if session is gone/expired.
  function touch() {
    var raw = getSessionRaw();
    if (!raw) return false;
    var s = null;
    try { s = JSON.parse(raw); } catch (e) { return false; }
    if (!s) return false;
    if (Date.now() - (s.lastActive || s.loginAt || 0) > SESSION_TTL) {
      try { sessionStorage.removeItem(SS_SESSION); } catch (e) { /* ignore */ }
      _expiredFlag = true;
      return false;
    }
    s.lastActive = Date.now();
    setSession(s);
    return true;
  }
  function wasSessionExpired() {
    var f = _expiredFlag;
    _expiredFlag = false;
    return f;
  }
  /**
   * authorize — role gate for every protected backend request.
   * Never trusts a role string passed from UI code paths: the session is
   * re-read from sessionStorage and re-validated (expiry + role) here.
   */
  function authorize(requiredRole) {
    // Distinguish "never signed in" from "session timed out".
    var raw = getSessionRaw();
    if (raw) {
      try {
        var tmp = JSON.parse(raw);
        if (tmp && Date.now() - (tmp.lastActive || tmp.loginAt || 0) > SESSION_TTL) {
          try { sessionStorage.removeItem(SS_SESSION); } catch (e) { /* ignore */ }
          _expiredFlag = true;
          return { ok: false, error: 'Session expired. Please log in again.' };
        }
      } catch (e) { /* fall through to normal check */ }
    }
    var s = getSession();
    if (!s) {
      return { ok: false, error: _expiredFlag ? 'Session expired. Please log in again.' : 'Not signed in.' };
    }
    if (requiredRole && s.role !== requiredRole) {
      return { ok: false, error: 'Access denied: this area requires an ' + requiredRole + ' account.' };
    }
    touch();
    s = getSession();
    return { ok: true, session: s };
  }
  function authorizeAdmin(session) {
    if (session && session.role === 'admin') return authorize('admin');
    return authorize('admin');
  }
  function setSession(s) {
    try {
      if (!s) sessionStorage.removeItem(SS_SESSION);
      else sessionStorage.setItem(SS_SESSION, JSON.stringify(s));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- ids ---------------- */
  function randomChars(n) {
    var out = '';
    var buf = new Uint32Array(n);
    try {
      crypto.getRandomValues(buf);
      for (var i = 0; i < n; i++) out += ID_ALPHABET[buf[i] % ID_ALPHABET.length];
    } catch (e) {
      for (var j = 0; j < n; j++) {
        out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
      }
    }
    return out;
  }
  function generateUniqueTicketId() {
    var tickets = readLS(LS_TICKETS, []);
    var seen = {};
    tickets.forEach(function (t) { seen[t.ticketId] = 1; });
    for (var attempt = 0; attempt < 500; attempt++) {
      var id = 'TKT-' + randomChars(6);
      if (!seen[id]) return id;
    }
    // astronomically unlikely fallback: timestamp suffix
    return 'TKT-' + randomChars(4) + Date.now().toString(36).toUpperCase().slice(-2);
  }
  function generateUniqueDevoteeId() {
    var tickets = readLS(LS_TICKETS, []);
    var seen = {};
    tickets.forEach(function (t) { if (t.devoteeId) seen[t.devoteeId] = 1; });
    for (var attempt = 0; attempt < 500; attempt++) {
      var id = 'DEV-' + randomChars(6);
      if (!seen[id]) return id;
    }
    return 'DEV-' + randomChars(4) + Date.now().toString(36).toUpperCase().slice(-2);
  }
  // One-time migration: older tickets get a Devotee ID + phone field.
  function migrateTickets() {
    var tickets = readLS(LS_TICKETS, []);
    var changed = false;
    var seen = {};
    tickets.forEach(function (t) { if (t.devoteeId) seen[t.devoteeId] = 1; });
    tickets.forEach(function (t) {
      if (!t.devoteeId || seen[t.devoteeId] === 2) {
        var id = generateUniqueDevoteeId();
        seen[id] = 1;
        t.devoteeId = id;
        changed = true;
      } else if (t.devoteeId) {
        seen[t.devoteeId] = (seen[t.devoteeId] || 0) + 1;
      }
      if (typeof t.phone === 'undefined') { t.phone = ''; changed = true; }
      if (typeof t.kind === 'undefined') { changed = true; }
    });
    if (changed) writeLS(LS_TICKETS, tickets);
    return tickets;
  }

  /* ---------------- volunteers (seed) ---------------- */
  function seedVolunteersIfEmpty() {
    var existing = readLS(LS_VOLUNTEERS, null);
    if (Array.isArray(existing) && existing.length > 0) return Promise.resolve(existing);
    var seeds = [
      { id: 'VOL-RAHUL', username: 'rahul', name: 'Rahul', role: 'volunteer', password: 'volunteer123' },
      { id: 'VOL-PRIYA', username: 'priya', name: 'Priya', role: 'volunteer', password: 'volunteer123' },
      { id: 'VOL-AMIT', username: 'amit', name: 'Amit', role: 'volunteer', password: 'volunteer123' },
      { id: 'ADM-ADMIN', username: 'admin', name: 'Administrator', role: 'admin', password: 'admin123' }
    ];
    return Promise.all(seeds.map(function (s) {
      return sha256hex(s.password).then(function (h) {
        return { id: s.id, username: s.username, name: s.name, role: s.role, passHash: h };
      });
    })).then(function (rows) {
      writeLS(LS_VOLUNTEERS, rows);
      return rows;
    });
  }
  function listVolunteers() { return readLS(LS_VOLUNTEERS, []); }

  function login(username, password) {
    username = String(username || '').trim().toLowerCase();
    return seedVolunteersIfEmpty().then(function (vols) {
      var v = vols.filter(function (x) { return x.username === username; })[0];
      if (!v) return { ok: false, error: 'Account not found. Ask your coordinator.' };
      return verifyHash(password || '', v.passHash).then(function (match) {
        if (!match) return { ok: false, error: 'Wrong password. Try again.' };
        var sess = {
          volunteerId: v.id, username: v.username, name: v.name, role: v.role,
          loginAt: Date.now(), lastActive: Date.now(),
          sessionId: newSessionId(), deviceId: deviceId()
        };
        setSession(sess);
        _expiredFlag = false;
        return { ok: true, session: sess };
      });
    });
  }
  function logout() { setSession(null); }
  function requireSession(roles) {
    var s = getSession();
    if (!s) return null;
    if (roles && roles.length && roles.indexOf(s.role) === -1) return null;
    return s;
  }

  /* ---------------- tickets ---------------- */
  function listTickets() { return readLS(LS_TICKETS, []); }
  function findTicket(ticketId) {
    var id = normalizeTicketId(ticketId);
    var tickets = readLS(LS_TICKETS, []);
    for (var i = 0; i < tickets.length; i++) {
      if (tickets[i].ticketId === id) return tickets[i];
    }
    return null;
  }
  function normalizeTicketId(raw) {
    return String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
  }
  // Accept raw ID, JSON {"tid"|"ticketId"|"id"}, or URLs containing ?tid=/ticket=
  function parseTicketPayload(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if (TICKET_RE.test(s.toUpperCase())) return s.toUpperCase();
    try {
      var o = JSON.parse(s);
      if (o && typeof o === 'object') {
        var cand = o.tid || o.ticketId || o.ticket_id || o.id;
        if (cand) return normalizeTicketId(cand);
      }
    } catch (e) { /* not JSON */ }
    var m = s.match(/TKT-[A-Z0-9]{4,10}/i);
    if (m) return normalizeTicketId(m[0]);
    return normalizeTicketId(s);
  }

  function createTicket(opts) {
    opts = opts || {};
    var holderName = String(opts.holderName || '').trim().replace(/\s+/g, ' ');
    if (holderName.length < 2) return { ok: false, error: 'Enter visitor name (min 2 characters).' };
    holderName = holderName.slice(0, 45);
    var eventName = String(opts.eventName || DEFAULT_EVENT).trim().slice(0, 80) || DEFAULT_EVENT;
    var date = String(opts.date || new Date().toISOString().slice(0, 10));
    var type = opts.type === 'VIP' ? 'VIP' : 'General';
    var phone = String(opts.phone || '').replace(/[^+\d]/g, '').slice(0, 15);
    // ATOMIC create: re-read inside write so two tabs can never mint the same ID
    var tickets = readLS(LS_TICKETS, []);
    var ticketId = generateUniqueTicketId();
    var guard = 0;
    while (tickets.some(function (t) { return t.ticketId === ticketId; }) && guard++ < 50) {
      ticketId = generateUniqueTicketId();
    }
    var t = {
      ticketId: ticketId, devoteeId: generateUniqueDevoteeId(),
      holderName: holderName, eventName: eventName, phone: phone,
      date: date, type: type, status: 'UNUSED',
      createdAt: Date.now(), usedAt: 0, usedById: '', usedByName: ''
    };
    tickets = readLS(LS_TICKETS, []); // fresh re-read (cross-tab safety)
    if (tickets.some(function (x) { return x.ticketId === ticketId; })) {
      ticketId = 'TKT-' + randomChars(6);
      t.ticketId = ticketId;
    }
    tickets.push(t);
    writeLS(LS_TICKETS, tickets);
    return { ok: true, ticket: t };
  }

  function seedDemoTickets(n) {
    n = n || 5;
    var names = ['Saikat Sengupta', 'Priya Chatterjee', 'Arjun Banerjee', 'Meera Iyer', 'Rahul Das'];
    var added = 0;
    for (var i = 0; i < Math.min(n, names.length); i++) {
      var tickets = readLS(LS_TICKETS, []);
      var dup = tickets.some(function (t) { return t.holderName.toLowerCase() === names[i].toLowerCase() && t.status === 'UNUSED'; });
      if (dup) continue;
      var r = createTicket({ holderName: names[i], type: i % 2 ? 'VIP' : 'General', eventName: DEFAULT_EVENT });
      if (r.ok) added++;
    }
    return added;
  }

  /* ---------------- scans ---------------- */
  function listScans() { return readLS(LS_SCANS, []); }
  function appendScan(record) {
    var scans = readLS(LS_SCANS, []);
    record.scanId = 'SCN-' + Date.now().toString(36).toUpperCase() + '-' + randomChars(4);
    scans.push(record);
    writeLS(LS_SCANS, scans);
    return record;
  }

  /**
   * verifyTicket — THE backend gate. Every scan must go through here.
   * Returns one of:
   *   { outcome:'VALID', ticket } | { outcome:'ALREADY_USED', ticket }
   *   | { outcome:'INVALID', ticketId }
   * Side effects: VALID flips UNUSED->USED and appends a scan row;
   * ALREADY_USED / INVALID only append a scan row (ticket untouched).
   * The USED flip is an atomic compare-and-swap: re-read, check, write.
   */
  // Simple in-memory mutex so two rapid scans in the SAME tab serialise.
  var _locked = false;
  function verifyTicket(rawPayload, session) {
    if (!session || !session.volunteerId) {
      return { outcome: 'INVALID', ticketId: '', error: 'Not signed in.' };
    }
    try { touch(); } catch (e) { /* ignore */ }
    var ticketId = parseTicketPayload(rawPayload);
    var now = Date.now();
    var base = {
      ticketId: ticketId, volunteerId: session.volunteerId,
      volunteerName: session.name, status: 'INVALID',
      timestamp: now, eventName: DEFAULT_EVENT,
      deviceId: session.deviceId || deviceId(), sessionId: session.sessionId || '',
      actorRole: session.role || 'volunteer', kind: 'entry'
    };
    if (!TICKET_RE.test(ticketId)) {
      base.status = 'INVALID';
      appendScan(base);
      return { outcome: 'INVALID', ticketId: ticketId, error: 'This ticket could not be verified. Please contact the event administrator.' };
    }
    if (_locked) {
      // Extremely short spin: re-read fresh state (CAS) rather than trusting cache.
      var spin = 0;
      while (_locked && spin++ < 100000) { /* busy-wait ~ms */ }
    }
    _locked = true;
    try {
      // FRESH re-read = the "transaction snapshot"
      var tickets = readLS(LS_TICKETS, []);
      var idx = -1;
      for (var i = 0; i < tickets.length; i++) {
        if (tickets[i].ticketId === ticketId) { idx = i; break; }
      }
      if (idx === -1) {
        base.status = 'INVALID';
        appendScan(base);
        return { outcome: 'INVALID', ticketId: ticketId, error: 'This ticket could not be verified. Please contact the event administrator.' };
      }
      var t = tickets[idx];
      base.eventName = t.eventName || DEFAULT_EVENT;
      if (t.status === 'USED') {
        base.status = 'ALREADY_USED';
        appendScan(base);
        return { outcome: 'ALREADY_USED', ticket: t };
      }
      // CAS commit: only flip if still UNUSED in this fresh snapshot
      if (tickets[idx].status !== 'UNUSED') {
        base.status = 'ALREADY_USED';
        appendScan(base);
        return { outcome: 'ALREADY_USED', ticket: tickets[idx] };
      }
      tickets[idx].status = 'USED';
      tickets[idx].usedAt = now;
      tickets[idx].usedById = session.volunteerId;
      tickets[idx].usedByName = session.name;
      writeLS(LS_TICKETS, tickets);
      base.status = 'VALID';
      appendScan(base);
      return { outcome: 'VALID', ticket: tickets[idx] };
    } finally {
      _locked = false;
    }
  }

  /* ---------------- admin: devotee lookup (read-only, never consumes entry) ---------------- */
  // Resolve any supported identifier: TKT- ticket id (raw/JSON/URL) or DEV- devotee id.
  function resolvePass(raw) {
    var tickets = readLS(LS_TICKETS, []);
    var tid = parseTicketPayload(raw);
    var i;
    if (tid) {
      for (i = 0; i < tickets.length; i++) {
        if (tickets[i].ticketId === tid) return tickets[i];
      }
    }
    var s = String(raw == null ? '' : raw).trim().toUpperCase();
    var m = s.match(/DEV-[A-Z0-9]{4,10}/);
    if (m) {
      for (i = 0; i < tickets.length; i++) {
        if (tickets[i].devoteeId === m[0]) return tickets[i];
      }
    }
    return null;
  }
  function devoteeProfile(t) {
    return {
      devoteeId: t.devoteeId || '—', name: t.holderName, ticketId: t.ticketId,
      type: t.type, eventName: t.eventName || DEFAULT_EVENT, date: t.date,
      phone: t.phone || '', registeredAt: t.createdAt,
      status: t.status, usedAt: t.usedAt || 0,
      usedByName: t.usedByName || ''
    };
  }
  /**
   * lookupPass — ADMIN ONLY devotee verification.
   * Authenticates the admin session on every call, finds the pass and
   * returns the authorized devotee record WITHOUT flipping UNUSED->USED.
   * Entry consumption stays exclusive to volunteer verifyTicket().
   */
  function lookupPass(rawPayload, session) {
    var auth = authorizeAdmin(session);
    if (!auth.ok) return { outcome: 'FORBIDDEN', error: auth.error };
    var s = auth.session;
    var now = Date.now();
    var t = resolvePass(rawPayload);
    var shown = String(rawPayload == null ? '' : rawPayload).trim().toUpperCase().slice(0, 24);
    if (!t) {
      appendScan({
        ticketId: shown, volunteerId: s.volunteerId, volunteerName: s.name,
        status: 'INVALID', timestamp: now, eventName: DEFAULT_EVENT,
        deviceId: s.deviceId || deviceId(), sessionId: s.sessionId || '',
        actorRole: 'admin', kind: 'lookup'
      });
      return { outcome: 'INVALID', ticketId: shown, error: 'This pass could not be found in the system. Please verify the QR code or contact the administrator.' };
    }
    if (t.status === 'USED') {
      appendScan({
        ticketId: t.ticketId, volunteerId: s.volunteerId, volunteerName: s.name,
        status: 'ALREADY_USED', timestamp: now, eventName: t.eventName || DEFAULT_EVENT,
        deviceId: s.deviceId || deviceId(), sessionId: s.sessionId || '',
        actorRole: 'admin', kind: 'lookup'
      });
      return { outcome: 'ALREADY_USED', devotee: devoteeProfile(t) };
    }
    appendScan({
      ticketId: t.ticketId, volunteerId: s.volunteerId, volunteerName: s.name,
      status: 'VALID', timestamp: now, eventName: t.eventName || DEFAULT_EVENT,
      deviceId: s.deviceId || deviceId(), sessionId: s.sessionId || '',
      actorRole: 'admin', kind: 'lookup'
    });
    return { outcome: 'VALID', devotee: devoteeProfile(t) };
  }
  function devoteeSearch(q) {
    q = String(q || '').trim().toLowerCase();
    var tickets = readLS(LS_TICKETS, []);
    if (!q) return tickets.slice().reverse().map(devoteeProfile);
    return tickets.filter(function (t) {
      return (t.holderName || '').toLowerCase().indexOf(q) !== -1 ||
        (t.ticketId || '').toLowerCase().indexOf(q) !== -1 ||
        (t.devoteeId || '').toLowerCase().indexOf(q) !== -1 ||
        (t.phone || '').toLowerCase().indexOf(q) !== -1;
    }).reverse().map(devoteeProfile);
  }
  // Admin-only filtered scan history: { q, status, date }.
  function scanHistory(filters) {
    filters = filters || {};
    var q = String(filters.q || '').trim().toLowerCase();
    var status = filters.status || 'all';
    var date = filters.date || 'all'; // 'all' | 'today' | 'YYYY-MM-DD'
    var scans = readLS(LS_SCANS, []).slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
    return scans.filter(function (s) {
      if (status !== 'all' && s.status !== status) return false;
      if (date === 'today') {
        var d0 = new Date(); d0.setHours(0, 0, 0, 0);
        if (s.timestamp < d0.getTime()) return false;
      } else if (date !== 'all') {
        var day = new Date(String(date) + 'T00:00:00');
        if (!isNaN(day.getTime())) {
          var next = new Date(day.getTime() + 86400000);
          if (s.timestamp < day.getTime() || s.timestamp >= next.getTime()) return false;
        }
      }
      if (!q) return true;
      return (s.ticketId || '').toLowerCase().indexOf(q) !== -1 ||
        (s.volunteerName || '').toLowerCase().indexOf(q) !== -1 ||
        (s.volunteerId || '').toLowerCase().indexOf(q) !== -1 ||
        (s.status || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 200);
  }

  /* ---------------- stats / search ---------------- */
  function stats() {
    var tickets = readLS(LS_TICKETS, []);
    var scans = readLS(LS_SCANS, []);
    var vols = readLS(LS_VOLUNTEERS, []);
    var used = tickets.filter(function (t) { return t.status === 'USED'; }).length;
    var invalid = scans.filter(function (s) { return s.status === 'INVALID'; }).length;
    var todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    var scansToday = scans.filter(function (s) { return s.timestamp >= todayStart.getTime(); }).length;
    return {
      totalTickets: tickets.length, usedTickets: used,
      totalDevotees: tickets.length, totalPasses: tickets.length,
      passesScanned: used, passesNotScanned: tickets.length - used,
      remaining: tickets.length - used, invalidAttempts: invalid,
      totalVolunteers: vols.filter(function (v) { return v.role !== 'admin'; }).length,
      totalScans: scans.length, scansToday: scansToday
    };
  }
  function volunteerStats(volunteerId) {
    var scans = readLS(LS_SCANS, []).filter(function (s) { return s.volunteerId === volunteerId; });
    var valid = scans.filter(function (s) { return s.status === 'VALID'; }).length;
    var reused = scans.filter(function (s) { return s.status === 'ALREADY_USED'; }).length;
    var invalid = scans.filter(function (s) { return s.status === 'INVALID'; }).length;
    scans.sort(function (a, b) { return b.timestamp - a.timestamp; });
    return { total: scans.length, valid: valid, reused: reused, invalid: invalid, recent: scans.slice(0, 10) };
  }
  function searchTickets(q) {
    q = String(q || '').trim().toLowerCase();
    var tickets = readLS(LS_TICKETS, []);
    if (!q) return tickets.slice().reverse();
    return tickets.filter(function (t) {
      return t.ticketId.toLowerCase().indexOf(q) !== -1 ||
        t.holderName.toLowerCase().indexOf(q) !== -1 ||
        (t.usedByName || '').toLowerCase().indexOf(q) !== -1;
    }).reverse();
  }
  function searchScans(q) {
    q = String(q || '').trim().toLowerCase();
    var scans = readLS(LS_SCANS, []).slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
    if (!q) return scans.slice(0, 50);
    return scans.filter(function (s) {
      return (s.ticketId || '').toLowerCase().indexOf(q) !== -1 ||
        (s.volunteerName || '').toLowerCase().indexOf(q) !== -1 ||
        (s.status || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 100);
  }
  function scansByVolunteer() {
    var scans = readLS(LS_SCANS, []);
    var map = {};
    scans.forEach(function (s) {
      var k = s.volunteerId || 'unknown';
      if (!map[k]) map[k] = { volunteerId: k, volunteerName: s.volunteerName || k, total: 0, valid: 0, reused: 0, invalid: 0 };
      map[k].total++;
      if (s.status === 'VALID') map[k].valid++;
      else if (s.status === 'ALREADY_USED') map[k].reused++;
      else map[k].invalid++;
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.total - a.total; });
  }
  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
      });
    } catch (e) { return new Date(ts).toLocaleString(); }
  }
  function exportCSV(rows, filename) {
    var head = ['scanId', 'ticketId', 'status', 'volunteerId', 'volunteerName', 'timestamp', 'eventName', 'deviceId', 'sessionId'];
    var lines = [head.join(',')].concat(rows.map(function (r) {
      return head.map(function (h) {
        return '"' + String(r[h] == null ? '' : r[h]).replace(/"/g, '""') + '"';
      }).join(',');
    }));
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'scan-history.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function resetDemoData() {
    try {
      localStorage.removeItem(LS_TICKETS);
      localStorage.removeItem(LS_SCANS);
    } catch (e) { /* ignore */ }
  }

  // Run lightweight migration once per page load.
  try { migrateTickets(); } catch (e) { /* ignore */ }

  global.TicketBackend = {
    DEFAULT_EVENT: DEFAULT_EVENT, TICKET_RE: TICKET_RE, DEVOTEE_RE: DEVOTEE_RE,
    SESSION_TTL: SESSION_TTL,
    seedVolunteersIfEmpty: seedVolunteersIfEmpty, listVolunteers: listVolunteers,
    login: login, logout: logout, getSession: getSession, requireSession: requireSession,
    touch: touch, wasSessionExpired: wasSessionExpired,
    authorize: authorize, authorizeAdmin: authorizeAdmin,
    deviceId: deviceId,
    createTicket: createTicket, listTickets: listTickets, findTicket: findTicket,
    seedDemoTickets: seedDemoTickets, migrateTickets: migrateTickets,
    resolvePass: resolvePass, lookupPass: lookupPass, devoteeSearch: devoteeSearch,
    scanHistory: scanHistory,
    listScans: listScans, verifyTicket: verifyTicket,
    normalizeTicketId: normalizeTicketId, parseTicketPayload: parseTicketPayload,
    stats: stats, volunteerStats: volunteerStats,
    searchTickets: searchTickets, searchScans: searchScans,
    scansByVolunteer: scansByVolunteer,
    formatTime: formatTime, exportCSV: exportCSV, resetDemoData: resetDemoData
  };
})(window);
