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

function fmtDur(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000) % 60, m = Math.floor(ms / 60000) % 60, h = Math.floor(ms / 3600000);
  return h ? `${h}h${m}m` : m ? `${m}m${s}s` : `${s}s`;
}

// ----- Generate -----
let lastGenerated = [];
function syncGenMode() {
  const mode = $('genMode').value;
  $('patternWrap').style.display = mode === 'pattern' ? '' : 'none';
}
$('genMode').onchange = syncGenMode; syncGenMode();
$('genBtn').onclick = async () => {
  const opts = {
    mode: $('genMode').value,
    length: Number($('genLen').value),
    charset: $('genCharset').value,
    count: Number($('genCount').value),
    pattern: $('genPattern').value.trim(),
    filters: { og: $('filterOg').checked, noRepeat: $('filterNoRepeat').checked },
    exhaustive: $('genExhaustive').checked,
  };
  const r = await window.api.generate(opts);
  if (!r.ok) { $('genInfo').innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; }
  lastGenerated = r.names;
  $('bulkNames').value = r.names.join('\n');
  updateBulkCount();
  $('genInfo').innerHTML = `<span class="ok">${r.names.length}</span> générés (${esc(opts.mode)}) → BULK`;
  cprint('info', `Généré ${r.names.length} pseudos (${opts.mode}) → BULK`);
};
$('genToBulkBtn').onclick = () => {
  if (!lastGenerated.length) { cprint('warn', 'Rien de généré pour l\'instant.'); return; }
  $('bulkNames').value = lastGenerated.join('\n');
  updateBulkCount();
};

// ----- Bulk check -----
let freeList = [];
let allResults = new Map(); // name.toLowerCase() -> { name, state, detail }
let lastNames = [];
function bulkNamesArray() { return $('bulkNames').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
function proxiesArray() { return $('proxies').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
function updateBulkCount() {
  const n = bulkNamesArray().length;
  $('bulkCount').textContent = n ? `${n} pseudos · ~${fmtDur(n * 56)} estimé` : '0 pseudo';
}
$('bulkNames').addEventListener('input', updateBulkCount);
$('proxies').addEventListener('input', () => { $('proxyCount').textContent = `${proxiesArray().length} proxies`; });

$('loadTxtBtn').onclick = async () => {
  const r = await window.api.pickTxt();
  if (r.canceled) return;
  if (!r.ok) { cprint('err', 'Fichier: ' + r.error); return; }
  $('bulkNames').value = r.names.join('\n'); updateBulkCount();
  cprint('info', `Chargé ${r.names.length} pseudos depuis ${r.path}`);
};
$('loadProxyBtn').onclick = async () => {
  const r = await window.api.pickTxt();
  if (r.canceled) return;
  if (!r.ok) { cprint('err', 'Proxies: ' + r.error); return; }
  $('proxies').value = r.names.join('\n');
  $('proxyCount').textContent = `${r.names.length} proxies`;
};

async function runBulk(names) {
  if (!names.length) { cprint('warn', 'Liste vide.'); return; }
  lastNames = names;
  setBulkRunning(true);
  $('bulkBar').style.width = '0%';
  $('bulkProgress').classList.remove('hidden');
  const proxies = proxiesArray();
  cprint('step', `BULK CHECK — ${names.length} pseudos${proxies.length ? ` · ${proxies.length} proxies` : ''}`);
  const r = await window.api.bulkCheck({ names, delayMs: Number($('delay').value), useToken: $('useToken').checked, proxies });
  setBulkRunning(false);
  $('bulkEta').textContent = '';
  if (!r.ok) { cprint('err', 'Bulk: ' + r.error); return; }
  const s = r.summary;
  cprint('ok', `Terminé en ${(s.elapsedMs / 1000).toFixed(1)}s — libres:${s.free} pris:${s.taken} inval:${s.invalid} err:${s.errors}${s.throttleEvents ? ` · ${s.throttleEvents} throttles gérés` : ''}`);
  $('bulkStats').innerHTML = `<span class="ok">${s.free} libres</span> · ${s.taken} pris · ${s.invalid} inval. · ${s.errors} err.`;
  saveCheckpoint();
  await exportFree({ auto: true });
}

$('bulkBtn').onclick = () => { freeList = []; allResults = new Map(); runBulk(bulkNamesArray()); };
$('bulkStopBtn').onclick = async () => { await window.api.bulkStop(); cprint('warn', 'Arrêt demandé…'); $('resumeBtn').classList.remove('hidden'); };
$('resumeBtn').onclick = () => {
  const remaining = lastNames.filter((n) => !allResults.has(n.toLowerCase()));
  if (!remaining.length) { cprint('info', 'Rien à reprendre.'); $('resumeBtn').classList.add('hidden'); return; }
  $('resumeBtn').classList.add('hidden');
  cprint('step', `Reprise : ${remaining.length} pseudos restants`);
  runBulk(remaining);
};

$('exportFreeBtn').onclick = () => exportFree({ auto: false });
$('exportCsvBtn').onclick = async () => {
  if (!allResults.size) { cprint('warn', 'Aucun résultat à exporter (lance un check).'); return; }
  const rows = ['pseudo,statut,detail'];
  for (const v of allResults.values()) rows.push(`${v.name},${v.state},"${(v.detail || '').replace(/"/g, '""')}"`);
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await window.api.saveTxt({ suggested: `resultats-${allResults.size}-${stamp}.csv`, content: rows.join('\n') + '\n' });
  if (r.canceled) return;
  if (r.ok) cprint('ok', `${allResults.size} résultats (CSV) → ${r.path}`);
};

async function exportFree({ auto } = {}) {
  if (!freeList.length) {
    if (!auto) cprint('warn', 'Aucun pseudo libre à exporter.');
    else cprint('info', 'Aucun pseudo libre trouvé — pas de fichier à proposer.');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await window.api.saveTxt({ suggested: `pseudos-libres-${freeList.length}-${stamp}.txt`, content: freeList.join('\n') + '\n' });
  if (r.canceled) { cprint('info', `Enregistrement annulé (${freeList.length} libres gardés — bouton EXPORT LIBRES dispo).`); return; }
  if (r.ok) cprint('ok', `${freeList.length} pseudos libres → ${r.path}`);
  else cprint('err', 'Export: ' + (r.error || 'échec'));
}

window.api.onBulkResult((r) => {
  const cls = { free: 'free', taken: 'taken', error: 'err' }[r.state] || 'info';
  const tag = { free: '[LIBRE]', taken: '[PRIS] ', error: '[ERR]  ' }[r.state] || '';
  cprint(cls, `${tag} ${r.name.padEnd(16)} ${r.detail || ''}`);
  allResults.set(r.name.toLowerCase(), { name: r.name, state: r.state, detail: r.detail || '' });
  if (r.state === 'free') freeList.push(r.name);
  if (r.total) $('bulkBar').style.width = Math.round((r.done / r.total) * 100) + '%';
  if (allResults.size % 25 === 0) saveCheckpoint();
});
window.api.onBulkStats((s) => {
  const eta = s.etaMs != null ? fmtDur(s.etaMs) : '—';
  const rate = s.rate ? s.rate.toFixed(1) : '0';
  $('bulkEta').innerHTML = `${s.done}/${s.total} · ${rate}/s · ETA ${eta} · cadence ~${Math.round(1000 / Math.max(1, s.intervalMs))}/s${s.throttled ? ' · <span class="warn">↓ throttle</span>' : ''}`;
});

function saveCheckpoint() {
  try { localStorage.setItem('bulkCheckpoint', JSON.stringify({ names: lastNames, results: [...allResults.values()], ts: Date.now() })); } catch { /* quota */ }
}
function loadCheckpoint() {
  try {
    const d = JSON.parse(localStorage.getItem('bulkCheckpoint') || 'null');
    if (!d || !Array.isArray(d.names) || !d.names.length) return;
    lastNames = d.names;
    allResults = new Map((d.results || []).map((v) => [v.name.toLowerCase(), v]));
    freeList = (d.results || []).filter((v) => v.state === 'free').map((v) => v.name);
    const remaining = lastNames.filter((n) => !allResults.has(n.toLowerCase()));
    if (remaining.length && remaining.length < lastNames.length) {
      $('resumeBtn').classList.remove('hidden');
      cprint('info', `Check précédent interrompu : ${remaining.length}/${lastNames.length} restants — bouton REPRENDRE dispo.`);
    }
  } catch { /* ignore */ }
}

function setBulkRunning(on) {
  $('bulkBtn').classList.toggle('hidden', on);
  $('bulkStopBtn').classList.toggle('hidden', !on);
  if (on) $('resumeBtn').classList.add('hidden');
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
  else if (r.public?.free === false) { html = '<span class="bad">PRIS</span>'; logmsg = `${name} : PRIS`; }
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
    allAccounts: $('allAccounts').checked,
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
  else if (r.multi) cprint(r.winner ? 'ok' : 'warn', r.winner ? `🎯 ${r.winner} a obtenu ${name} !` : `Aucun des ${r.count} comptes n'a eu ${name}.`);
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

// ----- Comptes (multi) -----
async function refreshAccounts() {
  const r = await window.api.accountsList();
  if (!r.ok) return;
  const sel = $('acctSelect');
  sel.innerHTML = '<option value="">— comptes —</option>' +
    r.accounts.map((a) => `<option value="${a.id}"${a.active ? ' selected' : ''}>${esc(a.label)}${a.name ? ` (${esc(a.name)})` : ''}</option>`).join('');
}
$('acctSaveBtn').onclick = async () => {
  const r = await window.api.accountSave($('acctLabel').value.trim());
  if (!r.ok) { cprint('err', 'Compte: ' + r.error); return; }
  $('acctLabel').value = ''; cprint('ok', 'Compte enregistré.'); refreshAccounts();
};
$('acctUseBtn').onclick = async () => {
  const id = $('acctSelect').value; if (!id) return;
  cprint('step', 'Bascule de compte…');
  const r = await window.api.accountActivate(id);
  if (!r.ok) { cprint('err', 'Switch: ' + r.error); return; }
  cprint('ok', 'Compte actif changé.'); refreshAccount(); refreshAccounts();
};
$('acctDelBtn').onclick = async () => {
  const id = $('acctSelect').value; if (!id) return;
  const r = await window.api.accountRemove(id);
  if (r.ok) { cprint('info', 'Compte supprimé.'); refreshAccounts(); }
};

// ----- Cooldown de renommage -----
$('cooldownBtn').onclick = async () => {
  $('cooldownInfo').textContent = 'lecture…';
  const r = await window.api.nameChangeInfo();
  if (!r.ok) { $('cooldownInfo').innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; }
  if (r.allowed) { $('cooldownInfo').innerHTML = '<span class="ok">✔ changement autorisé maintenant</span>'; }
  else if (r.availableAt) {
    $('cooldownInfo').innerHTML = `<span class="warn">✗ prochain dans ${esc(fmtDur(r.availableAt - Date.now()))}</span> (${new Date(r.availableAt).toLocaleDateString('fr-FR')})`;
  } else { $('cooldownInfo').innerHTML = '<span class="muted">statut indéterminé</span>'; }
};

// ----- Init -----
refreshAccount();
refreshAccounts();
updateBulkCount();
loadCheckpoint();
cprint('step', 'Minecraft Sniper prêt. Colle un token ou connecte-toi (MS).');
