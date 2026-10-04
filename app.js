/* ==========================================================================
   PANDALPULSE — Queue State Engine (vanilla JS, no dependencies)
   - In-memory reactive array `queue` mirrored to localStorage on every change
   - Telemetry: Total / VIP / General headcounts + empirical wait-time formula
     Estimated Minutes = Math.ceil(((GeneralCount * 2.0) + (VipCount * 1.0)) / 5)
   - Web Audio API ceremonial chimes (no MP3 files), toasts, modal, filters
   ========================================================================== */

'use strict';

/* ---------- Constants ---------- */
var STORAGE_KEY = 'pandalpulse_queue_v1';
var COUNTER_KEY = 'pandalpulse_token_counter_v1';
var TOKEN_PREFIX = '#DP-';
var TOKEN_START = 1042;
var MAX_NAME_LEN = 45;

/* ---------- State ---------- */
var queue = [];          // [{ id, name, passType, groupSize, entryTime, status }]
var activeFilter = 'all'; // 'all' | 'VIP' | 'General'
var searchTerm = '';
var modalVisitorId = null;

/* ---------- DOM refs ---------- */
var $ = function (id) { return document.getElementById(id); };
var els = {};

function cacheDom() {
  els.form = $('visitorForm');
  els.nameInput = $('visitorName');
  els.groupInput = $('groupSize');
  els.grid = $('queueGrid');
  els.emptyState = $('emptyQueueState');
  els.search = $('queueSearch');
  els.statTotal = $('statTotalVisitors');
  els.statVip = $('statVipVisitors');
  els.statGen = $('statGeneralVisitors');
  els.statWait = $('statWaitTime');
  els.countAll = $('countAll');
  els.countVip = $('countVip');
  els.countGen = $('countGen');
  els.sampleBtn = $('sampleDataBtn');
  els.clearBtn = $('clearAllBtn');
  els.emptyAddBtn = $('emptyAddBtn');
  els.quickAddBtn = $('quickAddBtn');
  els.modal = $('passModal');
  els.closeModal = $('closeModalBtn');
  els.modalPassType = $('modalPassType');
  els.modalPassId = $('modalPassId');
  els.modalName = $('modalVisitorName');
  els.modalGroup = $('modalGroupSize');
  els.modalTime = $('modalTimestamp');
  els.printBtn = $('printPassBtn');
  els.admitFromModal = $('admitFromModalBtn');
  els.modalQr = $('modalQr');
  els.toast = $('toast');
  els.filterTabs = Array.prototype.slice.call(document.querySelectorAll('.filter-tab'));
}

/* ---------- Persistence ---------- */
function loadQueue() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sanitize entries so corrupt rows can't break rendering
    return parsed.filter(function (v) {
      return v && typeof v.id === 'string' && typeof v.name === 'string';
    }).map(function (v) {
      return {
        id: String(v.id),
        name: String(v.name).slice(0, MAX_NAME_LEN),
        passType: v.passType === 'VIP' ? 'VIP' : 'General',
        groupSize: clampGroup(v.groupSize),
        entryTime: Number(v.entryTime) || Date.now(),
        status: 'waiting'
      };
    });
  } catch (e) {
    return [];
  }
}

function saveQueue() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (e) { /* storage full / private mode — queue still works in memory */ }
}

function nextTokenId() {
  var n = TOKEN_START;
  try {
    var stored = parseInt(localStorage.getItem(COUNTER_KEY), 10);
    n = Number.isFinite(stored) && stored >= TOKEN_START ? stored : TOKEN_START;
  } catch (e) { /* ignore */ }
  var id = TOKEN_PREFIX + n;
  // Guarantee uniqueness even if sample data or manual edits collide
  var taken = queue.some(function (v) { return v.id === id; });
  while (taken) {
    n += 1;
    id = TOKEN_PREFIX + n;
    taken = queue.some(function (v) { return v.id === id; });
  }
  try { localStorage.setItem(COUNTER_KEY, String(n + 1)); } catch (e) { /* ignore */ }
  return id;
}

/* ---------- Helpers ---------- */
function clampGroup(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, n));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
  } catch (e) {
    return new Date(ts).toLocaleString();
  }
}

/* ---------- Telemetry (spec algorithm) ---------- */
function computeTelemetry() {
  var vip = 0, general = 0;
  queue.forEach(function (v) {
    if (v.passType === 'VIP') vip += v.groupSize;
    else general += v.groupSize;
  });
  var total = vip + general;
  var wait = Math.ceil(((general * 2.0) + (vip * 1.0)) / 5);
  if (total === 0) wait = 0;
  return { total: total, vip: vip, general: general, wait: wait };
}

/* ---------- Audio: synthesized temple chimes (Web Audio API) ---------- */
var audioCtx = null;

function getAudioCtx() {
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) {
    try { audioCtx = new AC(); } catch (e) { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Soft bell: sine + harmonic, exponential decay (temple-bell feel)
function strikeBell(freq, startAt, duration, volume) {
  var ctx = getAudioCtx();
  if (!ctx) return;
  var t = ctx.currentTime + startAt;
  [[1, 1], [2.01, 0.35], [2.98, 0.18]].forEach(function (p) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * p[0];
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume * p[1], t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  });
}

function chimeIssue() {
  // Bright ascending blessing: Sa -> Pa
  strikeBell(880, 0, 1.4, 0.22);    // A5
  strikeBell(1318.5, 0.16, 1.6, 0.18); // E6
}

function chimeAdmit() {
  // Deep gong resolution: low Pa -> Sa
  strikeBell(392, 0, 1.8, 0.22);    // G4
  strikeBell(523.25, 0.14, 2.0, 0.2); // C5
}

function chimeError() {
  strikeBell(220, 0, 0.5, 0.15);
}

/* ---------- Toast ---------- */
var toastTimer = null;
function toast(msg) {
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    els.toast.classList.remove('show');
  }, 2600);
}

/* ---------- Core mutations ---------- */
function addVisitor(name, passType, groupSize) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) {
    toast('Please enter a devotee name (min 2 characters).');
    chimeError();
    return null;
  }
  if (name.length > MAX_NAME_LEN) {
    toast('Name trimmed to ' + MAX_NAME_LEN + ' characters.');
    name = name.slice(0, MAX_NAME_LEN);
  }
  passType = passType === 'VIP' ? 'VIP' : 'General';
  var visitor = {
    id: nextTokenId(),
    name: name,
    passType: passType,
    groupSize: clampGroup(groupSize),
    entryTime: Date.now(),
    status: 'waiting'
  };
  // VIP fast-track entries go to the front of the array; General appends
  if (passType === 'VIP') queue.unshift(visitor);
  else queue.push(visitor);
  saveQueue();
  render();
  chimeIssue();
  toast('Pass ' + visitor.id + ' issued for ' + visitor.name + '.');
  return visitor;
}

function admitVisitor(id) {
  var idx = queue.findIndex(function (v) { return v.id === id; });
  if (idx === -1) return;
  var removed = queue.splice(idx, 1)[0];
  saveQueue();
  render();
  chimeAdmit();
  toast(removed.name + ' (' + removed.id + ') admitted to sanctum.');
  if (modalVisitorId === id) closeModal();
}

function removeVisitor(id) {
  var idx = queue.findIndex(function (v) { return v.id === id; });
  if (idx === -1) return;
  var removed = queue.splice(idx, 1)[0];
  saveQueue();
  render();
  toast('Entry ' + removed.id + ' removed from queue.');
  if (modalVisitorId === id) closeModal();
}

function clearQueue() {
  if (queue.length === 0) {
    toast('Queue is already clear.');
    return;
  }
  if (!window.confirm('Remove all ' + queue.length + ' queued entries? This cannot be undone.')) return;
  queue = [];
  saveQueue();
  render();
  toast('Queue cleared. Shubho Sharadiya!');
}

function loadSampleDevotees() {
  var samples = [
    { name: 'Saikat Sengupta', passType: 'General', groupSize: 4 },
    { name: 'Priya Chatterjee', passType: 'VIP', groupSize: 2 },
    { name: 'Arjun Banerjee', passType: 'General', groupSize: 3 },
    { name: 'Meera Iyer', passType: 'VIP', groupSize: 1 },
    { name: 'Rahul Das', passType: 'General', groupSize: 5 }
  ];
  var added = 0;
  samples.forEach(function (s) {
    // Skip exact duplicate names already waiting
    var dup = queue.some(function (v) { return v.name.toLowerCase() === s.name.toLowerCase(); });
    if (dup) return;
    var v = {
      id: nextTokenId(),
      name: s.name,
      passType: s.passType,
      groupSize: s.groupSize,
      entryTime: Date.now() - added * 60000,
      status: 'waiting'
    };
    if (s.passType === 'VIP') queue.unshift(v);
    else queue.push(v);
    added += 1;
  });
  saveQueue();
  render();
  chimeIssue();
  toast(added > 0 ? added + ' sample devotees loaded.' : 'Sample devotees already in queue.');
}

/* ---------- Filtering ---------- */
function getVisibleQueue() {
  var term = searchTerm.trim().toLowerCase();
  return queue.filter(function (v) {
    if (activeFilter !== 'all' && v.passType !== activeFilter) return false;
    if (!term) return true;
    return v.name.toLowerCase().indexOf(term) !== -1 ||
           v.id.toLowerCase().indexOf(term) !== -1;
  });
}

/* ---------- Rendering ---------- */
function cardHtml(v) {
  var isVip = v.passType === 'VIP';
  return (
    '<article class="devotee-card glass-panel ' + (isVip ? 'devotee-card-vip' : 'devotee-card-general') + '" ' +
      'data-id="' + escapeHtml(v.id) + '" tabindex="0" role="button" ' +
      'aria-label="View pass for ' + escapeHtml(v.name) + ' ' + escapeHtml(v.id) + '">' +
      '<div class="card-micro-loop" aria-hidden="true"></div>' +
      '<div class="card-top-row">' +
        '<span class="token-pill">' + escapeHtml(v.id) + '</span>' +
        '<span class="pass-pill-badge ' + (isVip ? 'badge-vip' : 'badge-gen') + '">' +
          (isVip ? '⚜ VIP' : '🌸 General') +
        '</span>' +
      '</div>' +
      '<h3 class="devotee-name">' + escapeHtml(v.name) + '</h3>' +
      '<div class="devotee-meta-row">' +
        '<span>👥 ' + v.groupSize + ' member' + (v.groupSize > 1 ? 's' : '') + '</span>' +
        '<span>🕒 ' + escapeHtml(formatTime(v.entryTime)) + '</span>' +
      '</div>' +
      '<div class="card-actions-row">' +
        '<button class="btn-card-admit" data-action="admit" data-id="' + escapeHtml(v.id) + '">Admit to Sanctum →</button>' +
        '<button class="btn-card-remove" data-action="remove" data-id="' + escapeHtml(v.id) + '" aria-label="Remove ' + escapeHtml(v.name) + '">✕ Remove</button>' +
      '</div>' +
    '</article>'
  );
}

function render() {
  var t = computeTelemetry();

  // HUD counters with a subtle pop animation on change
  setNumber(els.statTotal, t.total);
  setNumber(els.statVip, t.vip);
  setNumber(els.statGen, t.general);
  setNumber(els.statWait, t.wait);

  // Filter tab counts (entry counts, not headcounts)
  if (els.countAll) els.countAll.textContent = queue.length;
  if (els.countVip) els.countVip.textContent = queue.filter(function (v) { return v.passType === 'VIP'; }).length;
  if (els.countGen) els.countGen.textContent = queue.filter(function (v) { return v.passType === 'General'; }).length;

  // Grid
  var visible = getVisibleQueue();
  els.grid.innerHTML = visible.map(cardHtml).join('');

  var isEmpty = visible.length === 0;
  els.grid.style.display = isEmpty ? 'none' : '';
  els.emptyState.style.display = isEmpty ? 'block' : 'none';
  if (isEmpty) {
    var emptyTitle = els.emptyState.querySelector('.empty-title');
    var emptyDesc = els.emptyState.querySelector('.empty-desc');
    if (queue.length === 0) {
      if (emptyTitle) emptyTitle.textContent = 'Queue is Currently Clear';
      if (emptyDesc) emptyDesc.textContent = 'No devotees waiting in line. Issue new passes using the Volunteer Desk above or load sample devotees to preview.';
    } else {
      if (emptyTitle) emptyTitle.textContent = 'No Matches Found';
      if (emptyDesc) emptyDesc.textContent = 'No devotees match your current search or filter. Try a different name, token ID, or tab.';
    }
  }
}

function setNumber(el, value) {
  if (!el) return;
  if (el.textContent !== String(value)) {
    el.textContent = value;
    // Re-trigger pop animation
    el.classList.remove('num-pop');
    void el.offsetWidth;
    el.classList.add('num-pop');
  }
}

/* ---------- Modal ---------- */
var modalPass = null; // { id, name, groupSize, time, passType } for PNG export

function renderModalQr(id) {
  if (!els.modalQr) return;
  els.modalQr.innerHTML = '';
  try {
    if (typeof QRCode !== 'undefined') {
      // Real QR, unique per pass — encodes this pass's token id only
      new QRCode(els.modalQr, {
        text: String(id),
        width: 132,
        height: 132,
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      els.modalQr.innerHTML = '<span style="font-family:monospace;color:#000;font-size:12px">' + escapeHtml(id) + '</span>';
    }
  } catch (e) { /* QR lib failed — id text remains readable */ }
}

function openModal(id) {
  var v = queue.find(function (x) { return x.id === id; });
  if (!v) return;
  modalVisitorId = id;
  var isVip = v.passType === 'VIP';
  var groupLabel = v.groupSize + (v.groupSize > 1 ? ' Persons' : ' Person');
  var timeLabel = formatTime(v.entryTime);
  modalPass = { id: v.id, name: v.name, groupSize: groupLabel, time: timeLabel, passType: v.passType };
  els.modalPassId.textContent = v.id;
  els.modalName.textContent = v.name;
  els.modalGroup.textContent = groupLabel;
  els.modalTime.textContent = timeLabel;
  els.modalPassType.textContent = isVip ? '⚜ VIP PASS' : '🌸 GENERAL PASS';
  els.modalPassType.classList.toggle('badge-pill-vip', isVip);
  els.modalPassType.classList.toggle('badge-pill-gen', !isVip);
  renderModalQr(v.id);
  els.modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalVisitorId = null;
  if (els.modal) els.modal.classList.remove('active');
  document.body.style.overflow = '';
}

/* ---------- Pass PNG export (exactly what the modal card shows) ---------- */
function rrPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function downloadPassPng() {
  if (!modalPass) { toast('Open a pass first.'); return; }
  var p = modalPass;
  var isVip = p.passType === 'VIP';
  var qrImg = document.querySelector('#modalQr img');
  var qrCanvas = document.querySelector('#modalQr canvas');
  var qrSrc = qrImg ? qrImg.src : (qrCanvas ? qrCanvas.toDataURL('image/png') : null);
  function finish(qr) {
    var W = 720, H = 1020;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    var bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#17171f'); bg.addColorStop(1, '#0c0c14');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 5;
    rrPath(ctx, 16, 16, W - 32, H - 32, 30); ctx.stroke();
    var y = 104;
    // header
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f59e0b'; ctx.font = '700 30px Georgia, serif';
    ctx.fillText('⚜ PANDALPULSE 2026', 60, y);
    var pill = isVip ? '⚜ VIP PASS' : '🌸 GENERAL PASS';
    ctx.font = '700 24px monospace, monospace';
    var pw = ctx.measureText(pill).width + 56;
    ctx.fillStyle = isVip ? '#f59e0b' : '#06b6d4';
    rrPath(ctx, W - 60 - pw, y - 34, pw, 48, 12); ctx.fill();
    ctx.fillStyle = '#07070b'; ctx.textAlign = 'center';
    ctx.fillText(pill, W - 60 - pw / 2, y); ctx.textAlign = 'left';
    y += 84;
    // token identifier
    ctx.fillStyle = '#64748b'; ctx.font = '700 22px monospace, monospace';
    ctx.fillText('TOKEN IDENTIFIER', 60, y); y += 74;
    ctx.fillStyle = '#ffffff'; ctx.font = '700 76px monospace, monospace';
    ctx.fillText(p.id, 60, y); y += 100;
    // devotee name + group size
    ctx.fillStyle = '#64748b'; ctx.font = '700 22px monospace, monospace';
    ctx.fillText('DEVOTEE NAME', 60, y);
    ctx.fillText('GROUP SIZE', W / 2 + 10, y); y += 52;
    ctx.fillStyle = '#ffffff'; ctx.font = '700 40px Manrope, Arial, sans-serif';
    var nm = String(p.name);
    if (ctx.measureText(nm).width > W / 2 - 40) ctx.font = '700 32px Manrope, Arial, sans-serif';
    ctx.fillText(nm, 60, y);
    ctx.fillText(String(p.groupSize), W / 2 + 10, y); y += 56;
    // dashed divider
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 2;
    ctx.setLineDash([12, 10]);
    ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(W - 60, y); ctx.stroke();
    ctx.setLineDash([]); y += 70;
    // QR + issued at
    var qs = 300;
    ctx.fillStyle = '#ffffff';
    rrPath(ctx, 60, y, qs + 32, qs + 32, 18); ctx.fill();
    if (qr) ctx.drawImage(qr, 76, y + 16, qs, qs);
    ctx.fillStyle = '#64748b'; ctx.font = '700 22px monospace, monospace';
    ctx.fillText('ISSUED AT', W / 2 + 10, y + 120);
    ctx.fillStyle = '#94a3b8'; ctx.font = '400 30px Manrope, Arial, sans-serif';
    ctx.fillText(String(p.time), W / 2 + 10, y + 168);
    var qBottom = y + qs + 32;
    ctx.fillStyle = '#64748b'; ctx.font = '700 20px monospace, monospace';
    ctx.fillText('S C A N   A T   G A T E', 60, qBottom + 48);
    var a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = String(p.id).replace('#', '') + '-pass.png';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Pass ' + p.id + ' downloaded as PNG.');
  }
  if (!qrSrc) { finish(null); return; }
  var im = new Image();
  im.onload = function () { finish(im); };
  im.onerror = function () { finish(null); };
  im.src = qrSrc;
}

/* ---------- 3D tilt (springy, pointer-only, respects reduced motion) ---------- */
function initTilt() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.matchMedia('(pointer: coarse)').matches) return;
  document.querySelectorAll('[data-tilt]').forEach(function (card) {
    var raf = null;
    card.addEventListener('mousemove', function (e) {
      var r = card.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () {
        card.style.transform =
          'translateY(-4px) rotateX(' + (-py * 4).toFixed(2) + 'deg) rotateY(' + (px * 6).toFixed(2) + 'deg)';
      });
    });
    card.addEventListener('mouseleave', function () {
      if (raf) cancelAnimationFrame(raf);
      card.style.transform = '';
    });
  });
}

/* ---------- Events ---------- */
function bindEvents() {
  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var checked = document.querySelector('input[name="passType"]:checked');
    var created = addVisitor(els.nameInput.value, checked ? checked.value : 'General', els.groupInput.value);
    if (created) {
      els.form.reset();
      els.groupInput.value = '1';
      els.nameInput.focus();
    } else {
      els.nameInput.focus();
      els.nameInput.select();
    }
  });

  // Live character-limit feedback
  els.nameInput.addEventListener('input', function () {
    if (els.nameInput.value.length >= MAX_NAME_LEN) {
      els.nameInput.value = els.nameInput.value.slice(0, MAX_NAME_LEN);
      toast('Name limit: ' + MAX_NAME_LEN + ' characters.');
    }
  });

  els.groupInput.addEventListener('change', function () {
    els.groupInput.value = clampGroup(els.groupInput.value);
  });

  els.search.addEventListener('input', function () {
    searchTerm = els.search.value;
    render();
  });

  els.filterTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      els.filterTabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      activeFilter = tab.getAttribute('data-filter') || 'all';
      render();
    });
  });

  // Delegated card actions: admit / remove / open modal
  els.grid.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      var id = btn.getAttribute('data-id');
      if (btn.getAttribute('data-action') === 'admit') admitVisitor(id);
      else removeVisitor(id);
      return;
    }
    var card = e.target.closest('.devotee-card');
    if (card) openModal(card.getAttribute('data-id'));
  });

  els.grid.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('devotee-card')) {
      e.preventDefault();
      openModal(e.target.getAttribute('data-id'));
    }
  });

  els.sampleBtn.addEventListener('click', loadSampleDevotees);
  els.clearBtn.addEventListener('click', clearQueue);

  function scrollToDesk() {
    document.getElementById('entry-form-section').scrollIntoView({ behavior: 'smooth' });
    setTimeout(function () { els.nameInput.focus({ preventScroll: true }); }, 600);
  }
  if (els.emptyAddBtn) els.emptyAddBtn.addEventListener('click', scrollToDesk);
  if (els.quickAddBtn) els.quickAddBtn.addEventListener('click', scrollToDesk);

  els.closeModal.addEventListener('click', closeModal);
  els.modal.addEventListener('click', function (e) {
    if (e.target === els.modal) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && els.modal.classList.contains('active')) closeModal();
  });

  els.printBtn.addEventListener('click', downloadPassPng);
  els.admitFromModal.addEventListener('click', function () {
    if (modalVisitorId) admitVisitor(modalVisitorId);
  });
}

/* ---------- Boot ---------- */
function init() {
  cacheDom();
  queue = loadQueue();
  bindEvents();
  render();
  initTilt();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
