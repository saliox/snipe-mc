// UI terminal. Aucune logique réseau ici : tout passe par window.api (preload).
const $ = (id) => document.getElementById(id);

// ----- Banner ASCII (police bloc 5 lignes) -----
const FONT = {
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  F: ['█████', '█    ', '████ ', '█    ', '█    '],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  P: ['████ ', '█   █', '████ ', '█    ', '█    '],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};
function renderBanner(text) {
  const rows = ['', '', '', '', ''];
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let i = 0; i < 5; i++) rows[i] += g[i] + ' ';
  }
  return rows.join('\n');
}
$('banner').textContent = renderBanner('MINECRAFT SNIPER');

// ----- Console -----
const logBox = $('log');
function cprint(level, msg) {
  const line = document.createElement('div');
  line.className = 'l';
  const time = new Date().toLocaleTimeString('fr-FR');
  line.innerHTML = `<span class="t">${time}</span><span class="${level}">${esc(msg)}</span>`;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
window.api.onLog((e) => cprint(e.level, e.msg));
$('clearLogs').onclick = () => { logBox.innerHTML = ''; };

// ----- Version + compte -----
window.api.appVersion().then((v) => { $('appVer').textContent = 'v' + v; });

async function refreshAccount() {
  const cfg = await window.api.configStatus();
  $('configWarn').classList.toggle('hidden', cfg.hasClientId);
  const r = await window.api.whoami();
  const line = $('userLine');
  if (r.profile) {
    const src = r.source === 'token' ? 'token' : 'MS';
    line.innerHTML = `whoami :: <span class="free">${esc(r.profile.name)}</span> <span class="muted">[${src}]</span>`;
    $('tokenStatus').innerHTML = `<span class="ok">✔ ${esc(r.profile.name)}</span>`;
  } else {
    line.innerHTML = 'whoami :: <span class="muted">non connecté</span>';
  }
}

// ----- Token -----
$('tokenSetBtn').onclick = async () => {
  const tok = $('token').value.trim();
  if (!tok) { $('tokenStatus').innerHTML = '<span class="bad">token vide</span>'; return; }
  $('tokenStatus').textContent = 'validation…';
  const r = await window.api.tokenSet(tok);
  if (r.ok) {
    cprint('ok', `Token valide → ${r.profile.name}`);
    $('token').value = '';
    refreshAccount();
  } else {
    $('tokenStatus').innerHTML = `<span class="bad">✗ ${esc(r.error)}</span>`;
    cprint('err', 'Token: ' + r.error);
  }
};
$('tokenClearBtn').onclick = async () => { await window.api.tokenClear(); $('tokenStatus').textContent = 'token retiré'; refreshAccount(); };

$('loginBtn').onclick = async () => {
  cprint('step', 'Connexion Microsoft…');
  const r = await window.api.login();
  $('deviceModal').classList.add('hidden');
  cprint(r.ok ? 'ok' : 'err', r.ok ? `Connecté : ${r.profile ? r.profile.name : '(sans profil)'}` : r.error);
  refreshAccount();
};
window.api.onDeviceCode(({ verificationUri, userCode }) => {
  $('userCode').textContent = userCode;
  $('verifUri').textContent = verificationUri;
  $('deviceModal').classList.remove('hidden');
});

// ----- Change username -----
$('changeBtn').onclick = async () => {
  const name = $('newName').value.trim();
  if (!name) return;
  $('changeResult').textContent = 'envoi…';
  cprint('step', `PUT change name → ${name}`);
  const r = await window.api.changeUsername(name);
  if (r.ok) {
    $('changeResult').innerHTML = `<span class="ok">✔ pseudo changé en ${esc(r.name)}</span>`;
    cprint('ok', `Pseudo changé en ${r.name} !`);
    refreshAccount();
  } else {
    const m = r.reason || r.error || 'échec';
    $('changeResult').innerHTML = `<span class="bad">✗ ${esc(m)}</span>`;
    cprint('err', 'Change name: ' + m);
  }
};

// ----- Generate -----
let lastGenerated = [];
$('genBtn').onclick = async () => {
  const opts = {
    length: Number($('genLen').value),
    charset: $('genCharset').value,
    count: Number($('genCount').value),
    exhaustive: $('genExhaustive').checked,
  };
  const r = await window.api.generate(opts);
  if (!r.ok) { $('genInfo').innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; }
  lastGenerated = r.names;
  $('bulkNames').value = r.names.join('\n');
  updateBulkCount();
  $('genInfo').innerHTML = `<span class="ok">${r.names.length}</span> générés · espace ${r.space.toLocaleString('fr-FR')}`;
  cprint('info', `Généré ${r.names.length} pseudos de ${opts.length} car. → BULK`);
};
$('genToBulkBtn').onclick = () => {
  if (!lastGenerated.length) { cprint('warn', 'Rien de généré pour l\'instant.'); return; }
  $('bulkNames').value = lastGenerated.join('\n');
  updateBulkCount();
};

// ----- Bulk check -----
let freeList = [];
function bulkNamesArray() { return $('bulkNames').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
function updateBulkCount() { $('bulkCount').textContent = `${bulkNamesArray().length} pseudos`; }
$('bulkNames').addEventListener('input', updateBulkCount);

$('loadTxtBtn').onclick = async () => {
  const r = await window.api.pickTxt();
  if (r.canceled) return;
  if (!r.ok) { cprint('err', 'Fichier: ' + r.error); return; }
  $('bulkNames').value = r.names.join('\n');
  updateBulkCount();
  cprint('info', `Chargé ${r.names.length} pseudos depuis ${r.path}`);
};

$('bulkBtn').onclick = async () => {
  const names = bulkNamesArray();
  if (!names.length) { cprint('warn', 'Liste vide.'); return; }
  freeList = [];
  setBulkRunning(true);
  $('bulkBar').style.width = '0%';
  $('bulkProgress').classList.remove('hidden');
  cprint('step', `BULK CHECK — ${names.length} pseudos (delay ${$('delay').value}ms)`);
  const r = await window.api.bulkCheck({
    names,
    delayMs: Number($('delay').value),
    useToken: $('useToken').checked,
  });
  setBulkRunning(false);
  if (!r.ok) { cprint('err', 'Bulk: ' + r.error); return; }
  const s = r.summary;
  cprint('ok', `Terminé — libres:${s.free} pris:${s.taken} invalides:${s.invalid} erreurs:${s.errors}`);
  $('bulkStats').innerHTML = `<span class="ok">${s.free} libres</span> · ${s.taken} pris · ${s.invalid} inval. · ${s.errors} err.`;
};
$('bulkStopBtn').onclick = async () => { await window.api.bulkStop(); cprint('warn', 'Arrêt demandé…'); };

$('exportFreeBtn').onclick = async () => {
  if (!freeList.length) { cprint('warn', 'Aucun pseudo libre à exporter.'); return; }
  const r = await window.api.saveTxt({ suggested: 'pseudos-libres.txt', content: freeList.join('\n') });
  if (r.ok) cprint('ok', `${freeList.length} pseudos libres → ${r.path}`);
};

window.api.onBulkResult((r) => {
  const map = { free: 'free', taken: 'taken', invalid: 'invalid', error: 'err' };
  const tag = { free: '[LIBRE]', taken: '[PRIS] ', invalid: '[INVAL]', error: '[ERR]  ' }[r.state] || '';
  cprint(map[r.state] || 'info', `${tag} ${r.name.padEnd(16)} ${r.detail || ''}`);
  if (r.state === 'free') freeList.push(r.name);
  const pct = r.total ? Math.round(((r.index + 1) / r.total) * 100) : 0;
  $('bulkBar').style.width = pct + '%';
});

function setBulkRunning(on) {
  $('bulkBtn').classList.toggle('hidden', on);
  $('bulkStopBtn').classList.toggle('hidden', !on);
}

// ----- Check 1 pseudo -----
$('checkBtn').onclick = async () => {
  const name = $('checkName').value.trim();
  if (!name) return;
  $('checkResult').textContent = 'vérif…';
  const r = await window.api.check(name);
  if (!r.ok) { $('checkResult').innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; }
  let html = '', logmsg = '';
  if (r.public?.free === true) { html = '<span class="ok">LIBRE</span>'; logmsg = `${name} : LIBRE`; }
  else if (r.public?.free === false) { html = `<span class="bad">PRIS</span> par ${esc(r.public.name)}`; logmsg = `${name} : PRIS par ${r.public.name}`; }
  else if (r.public?.rateLimited) { html = '<span class="warn">Mojang rate-limité</span>'; logmsg = `${name} : rate-limité`; }
  if (r.account) {
    const lbl = { AVAILABLE: '<span class="ok">réclamable</span>', DUPLICATE: '<span class="bad">pris</span>', NOT_ALLOWED: '<span class="warn">bloqué</span>' }[r.account] || r.account;
    html += ` · compte: ${lbl}`;
  }
  if (!r.valid) html += ' <span class="warn">(format invalide)</span>';
  $('checkResult').innerHTML = html;
  cprint(r.public?.free ? 'free' : 'taken', `[CHECK] ${logmsg}${r.account ? ' · ' + r.account : ''}`);
};

// ----- NTP -----
$('ntpBtn').onclick = async () => {
  $('ntpInfo').textContent = 'mesure…';
  cprint('step', 'Mesure NTP…');
  const r = await window.api.ntp();
  if (r.ok) {
    const txt = `offset ${r.offset >= 0 ? '+' : ''}${r.offset.toFixed(1)}ms (${r.server}, rtt ${r.rtt.toFixed(0)}ms)`;
    $('ntpInfo').textContent = txt;
    cprint('ok', txt);
  } else { $('ntpInfo').textContent = ''; cprint('err', 'NTP: ' + r.error); }
};

// ----- Snipe -----
let countdownTimer = null;
document.querySelectorAll('input[name="smode"]').forEach((rd) => {
  rd.onchange = () => {
    const mode = document.querySelector('input[name="smode"]:checked').value;
    $('snipeAt').disabled = mode !== 'at';
    $('snipeIn').disabled = mode !== 'in';
  };
});
$('snipeBtn').onclick = async () => {
  const name = $('snipeName').value.trim();
  if (!name) { cprint('warn', 'Indique un pseudo à sniper.'); return; }
  const mode = document.querySelector('input[name="smode"]:checked').value;
  const opts = {
    name,
    monitor: mode === 'monitor',
    burst: Number($('burst').value),
    spacingMs: Number($('spacing').value),
    leadMs: Number($('lead').value),
    connections: Number($('connections').value),
    skipNtp: $('skipNtp').checked,
  };
  if (mode === 'at') {
    const ms = new Date($('snipeAt').value).getTime();
    if (Number.isNaN(ms)) { cprint('err', 'Date de drop invalide.'); return; }
    opts.dropAt = ms;
    startCountdown(ms);
  } else if (mode === 'in') {
    const ms = parseDuration($('snipeIn').value);
    if (ms == null) { cprint('err', `Durée invalide : ${$('snipeIn').value} (ex. 45s, 15m, 2h).`); return; }
    opts.dropAt = Date.now() + ms;
    startCountdown(opts.dropAt);
  }
  setSnipeRunning(true);
  const r = await window.api.snipe(opts);
  setSnipeRunning(false);
  clearInterval(countdownTimer); $('countdown').textContent = '';
  if (!r.ok) cprint('err', 'Snipe: ' + r.error);
  refreshAccount();
};
function parseDuration(s) {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 's']);
}
$('snipeStopBtn').onclick = async () => { await window.api.stop(); };
function setSnipeRunning(on) {
  $('snipeBtn').classList.toggle('hidden', on);
  $('snipeStopBtn').classList.toggle('hidden', !on);
}
function startCountdown(dropAt) {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const left = dropAt - Date.now();
    if (left <= 0) { $('countdown').textContent = '⏱ tir…'; clearInterval(countdownTimer); return; }
    const s = Math.floor(left / 1000) % 60, m = Math.floor(left / 60000) % 60, h = Math.floor(left / 3600000);
    $('countdown').textContent = `T- ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, 250);
}

// ----- Mises à jour -----
$('checkUpdateLink').onclick = async (e) => { e.preventDefault(); $('updateText').textContent = 'vérification…'; $('updateBanner').classList.remove('hidden'); await window.api.updateCheck(); };
$('updateBtn').onclick = async () => { $('updateBtn').disabled = true; const r = await window.api.updateApply(); if (!r.ok) { $('updateBtn').disabled = false; $('updateText').textContent = 'échec: ' + r.error; } };
window.api.onUpdateStatus((s) => {
  const b = $('updateBanner'), btn = $('updateBtn');
  const show = (t, showBtn) => { $('updateText').textContent = t; b.classList.remove('hidden'); btn.classList.toggle('hidden', !showBtn); };
  if (s.state === 'available') { show(`Nouvelle version ${s.version} dispo (tu as ${s.current}).`, true); btn.disabled = false; $('updateProgress').classList.add('hidden'); }
  else if (s.state === 'downloading') { show('téléchargement…', false); $('updateProgress').classList.remove('hidden'); }
  else if (s.state === 'installing') { show('installation… redémarrage imminent.', false); }
  else if (s.state === 'uptodate') { show(`à jour (v${s.current}).`, false); setTimeout(() => b.classList.add('hidden'), 4000); }
  else if (s.state === 'disabled') { show('MAJ non configurées (UPDATE_URL absent).', false); setTimeout(() => b.classList.add('hidden'), 5000); }
  else if (s.state === 'error') { show('MAJ indispo: ' + s.error, false); setTimeout(() => b.classList.add('hidden'), 6000); }
});
window.api.onUpdateProgress((p) => { $('updateProgress').classList.remove('hidden'); $('updateBar').style.width = (p.pct || 0) + '%'; });

// ----- Init -----
refreshAccount();
updateBulkCount();
cprint('step', 'Minecraft Sniper prêt. Colle un token ou connecte-toi (MS).');
