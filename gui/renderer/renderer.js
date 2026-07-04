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
let tally = { free: 0, taken: 0, error: 0 }; // cumul (multi-batch / reprise / illimité)
function bulkNamesArray() { return $('bulkNames').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
function proxiesArray() { return $('proxies').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
function updateBulkCount() {
  const n = bulkNamesArray().length;
  $('bulkCount').textContent = n ? `${n} pseudos` : '0 pseudo';
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
$('fetchProxyBtn').onclick = async () => {
  $('fetchProxyBtn').disabled = true;
  $('proxyCount').textContent = 'récupération…';
  const r = await window.api.fetchProxies();
  $('fetchProxyBtn').disabled = false;
  if (!r.ok) { cprint('err', 'Proxies: ' + r.error); $('proxyCount').textContent = ''; return; }
  const merged = [...new Set([...proxiesArray(), ...r.proxies])];
  $('proxies').value = merged.join('\n');
  $('proxyCount').textContent = `${merged.length} proxies (gratuits)`;
  cprint('info', `${r.proxies.length} proxies gratuits récupérés — filtrage auto des morts…`);
  await runProxyTest(); // ne garde que les vivants
};

$('testProxyBtn').onclick = () => runProxyTest();
async function runProxyTest() {
  const list = proxiesArray();
  if (!list.length) { cprint('warn', 'Aucun proxy à tester.'); return; }
  $('testProxyBtn').disabled = true; $('fetchProxyBtn').disabled = true;
  cprint('step', `Test de ${list.length} proxies (garde les vivants)…`);
  const r = await window.api.testProxies(list);
  $('testProxyBtn').disabled = false; $('fetchProxyBtn').disabled = false;
  if (!r.ok) { cprint('err', 'Test proxies: ' + r.error); return; }
  $('proxies').value = r.alive.join('\n');
  $('proxyCount').textContent = `${r.aliveCount}/${r.tested} vivants`;
  cprint(r.aliveCount ? 'ok' : 'warn', `${r.aliveCount}/${r.tested} proxies vivants gardés (${r.tested - r.aliveCount} morts retirés).`);
}
window.api.onProxyTestProgress((p) => { $('proxyCount').textContent = `test ${p.done}/${p.total} · ${p.alive} vivants`; });

// names = pseudos à traiter ce run (peut être un sous-ensemble en cas de reprise).
// lastNames (la liste complète suivie) est géré par les appelants, PAS ici.
// opts.silent : batch d'un scan illimité -> pas de résumé/export/boutons bulk.
async function runBulk(names, { silent = false, recheck = false } = {}) {
  if (!names.length) { if (!silent) cprint('warn', 'Liste vide.'); return; }
  if (!silent) setBulkRunning(true);
  $('bulkBar').style.width = '0%';
  $('bulkProgress').classList.remove('hidden');
  const proxies = proxiesArray();
  if (!silent) cprint('step', `${recheck ? 'RE-CHECK' : 'BULK CHECK'} — ${names.length} pseudos${proxies.length ? ` · ${proxies.length} proxies` : ''}`);
  const r = await window.api.bulkCheck({ names, delayMs: Number($('delay').value), useToken: $('useToken').checked, proxies });
  if (!silent) { setBulkRunning(false); $('bulkEta').textContent = ''; }
  if (!r.ok) { if (!silent) cprint('err', 'Bulk: ' + r.error); return; }
  const s = r.summary;
  if (silent) return;  // scan illimité : géré globalement
  if (recheck) { cprint('ok', `Re-check terminé — ${s.free} récupérés libres, ${s.errors} encore en échec.`); return; }
  cprint('ok', `Terminé en ${(s.elapsedMs / 1000).toFixed(1)}s — libres:${s.free} pris:${s.taken} inval:${s.invalid} err:${s.errors}${s.throttleEvents ? ` · ${s.throttleEvents} throttles gérés` : ''}`);
  $('bulkStats').innerHTML = `<span class="ok">${s.free} libres</span> · ${s.taken} pris · ${s.invalid} inval. · ${s.errors} err.`;
  // Re-check auto des échecs (réseau/proxy) UNE fois, avant de finaliser.
  const errs = [...allResults.values()].filter((v) => v.state === 'error').map((v) => v.name);
  if (errs.length) await runBulk(errs, { recheck: true });
  await saveCheckpointNow();
  await showTopFree();
  await exportFree({ auto: true });
  refreshHistStats();
}

$('bulkBtn').onclick = () => {
  freeList = []; allResults = new Map(); tally = { free: 0, taken: 0, error: 0 };
  resumeUnlimited = false;            // nouvelle session bulk (pas une reprise ∞)
  lastNames = bulkNamesArray();       // nouvelle liste complète suivie
  runBulk(lastNames);
};
$('bulkStopBtn').onclick = async () => { await window.api.bulkStop(); cprint('warn', 'Arrêt demandé…'); $('resumeBtn').classList.remove('hidden'); };
let resumeUnlimited = false; // la dernière session rechargée était un scan illimité
$('resumeBtn').onclick = () => {
  $('resumeBtn').classList.add('hidden');
  // Reprise d'un scan ILLIMITÉ : on relance en conservant les résultats accumulés
  // (le dédoublonnage évite de re-checker ce qui l'a déjà été).
  if (resumeUnlimited) {
    resumeUnlimited = false;
    cprint('step', `Reprise du scan illimité (${allResults.size} déjà checkés conservés)…`);
    startUnlimited(false);
    return;
  }
  // Reprise d'un BULK.
  $('bulkNames').value = lastNames.join('\n');
  updateBulkCount();
  const remaining = lastNames.filter((n) => !allResults.has(n.toLowerCase()));
  if (remaining.length) {
    cprint('step', `Reprise : ${remaining.length} restants sur ${lastNames.length}`);
    runBulk(remaining);
  } else {
    // Session déjà terminée -> on RELANCE la liste complète (nouvelle passe).
    cprint('step', `Relance de la dernière liste (${lastNames.length} pseudos)…`);
    freeList = []; allResults = new Map(); tally = { free: 0, taken: 0, error: 0 };
    runBulk(lastNames);
  }
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

// Classe les libres par désirabilité (meilleurs d'abord) ; repli si l'IPC échoue.
async function rankedFree() {
  const r = await window.api.rankNames(freeList);
  return (r && r.ok) ? r.ranked : freeList.map((name) => ({ name, tier: '?' }));
}
let rankedFreeCache = [];
async function showTopFree() {
  if (!freeList.length) { $('freeChips').innerHTML = ''; $('claimBestBtn').classList.add('hidden'); return; }
  const ranked = await rankedFree();
  rankedFreeCache = ranked;
  const top = ranked.slice(0, 8).map((x) => `${x.name}(${x.tier})`).join('  ');
  cprint('free', `★ meilleurs libres : ${top}`);
  renderFreeChips(ranked);
}
// Chips cliquables : clic = réclamer (change username) le pseudo sur le token actif.
function renderFreeChips(ranked) {
  const box = $('freeChips');
  box.innerHTML = ranked.slice(0, 60).map((x) =>
    `<span class="chip" data-name="${esc(x.name)}"><span class="tier">${x.tier}</span> ${esc(x.name)}</span>`).join('');
  $('claimBestBtn').classList.toggle('hidden', !ranked.length);
}
$('freeChips').onclick = (e) => {
  const chip = e.target.closest('.chip');
  if (chip) claimName(chip.dataset.name);
};
$('claimBestBtn').onclick = () => { if (rankedFreeCache[0]) claimName(rankedFreeCache[0].name); };
async function claimName(name) {
  if (!name) return;
  if (!window.confirm(`Réclamer « ${name} » ? Ça change le pseudo du compte du token actif (cooldown 30 j).`)) return;
  cprint('step', `Réclamation de ${name}…`);
  const r = await window.api.changeUsername(name);
  if (r.ok) { cprint('ok', `🎯 Pseudo changé en ${r.name} !`); refreshAccount(); }
  else cprint('err', `Échec claim ${name} : ${r.reason || r.error || 'erreur'}`);
}

// Auto-claim (scan illimité) : réclame le 1er libre qui matche tier/longueur.
let autoClaimDone = false;
const TIERS = ['S', 'A', 'B', 'C', 'D'];
async function maybeAutoClaim(name) {
  if (autoClaimDone) return;
  const rk = await window.api.rankNames([name]);
  const item = rk.ok && rk.ranked[0];
  if (!item) return;
  const maxLen = Number($('autoClaimLen').value) || 16;
  if (TIERS.indexOf(item.tier) <= TIERS.indexOf($('autoClaimTier').value) && name.length <= maxLen) {
    autoClaimDone = true;
    unlimited = false; window.api.bulkStop();
    cprint('step', `Auto-claim de ${name} (${item.tier})…`);
    const r = await window.api.changeUsername(name);
    if (r.ok) cprint('ok', `🎯 Auto-claim réussi : pseudo changé en ${r.name} !`);
    else cprint('err', `Auto-claim ${name} échoué : ${r.reason || r.error}`);
    refreshAccount();
  }
}

async function exportFree({ auto } = {}) {
  if (!freeList.length) {
    if (!auto) cprint('warn', 'Aucun pseudo libre à exporter.');
    else cprint('info', 'Aucun pseudo libre trouvé — pas de fichier à proposer.');
    return;
  }
  const ranked = await rankedFree();               // meilleurs pseudos d'abord
  const lines = ranked.map((x) => x.name);
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await window.api.saveTxt({ suggested: `pseudos-libres-${freeList.length}-${stamp}.txt`, content: lines.join('\n') + '\n' });
  if (r.canceled) { cprint('info', `Enregistrement annulé (${freeList.length} libres gardés — bouton EXPORT LIBRES dispo).`); return; }
  if (r.ok) cprint('ok', `${freeList.length} pseudos libres → ${r.path}`);
  else cprint('err', 'Export: ' + (r.error || 'échec'));
}

window.api.onBulkResult((r) => {
  const cls = { free: 'free', taken: 'taken', error: 'err', invalid: 'warn' }[r.state] || 'info';
  const tag = { free: '[LIBRE]', taken: '[PRIS] ', error: '[ERR]  ', invalid: '[INVAL]' }[r.state] || '';
  cprint(cls, `${tag} ${r.name.padEnd(16)} ${r.detail || ''}`);
  allResults.set(r.name.toLowerCase(), { name: r.name, state: r.state, detail: r.detail || '' });
  if (tally[r.state] != null) tally[r.state]++;
  if (r.state === 'free') {
    freeList.push(r.name);
    // Auto-claim pendant le scan illimité : réclame le 1er libre qui matche.
    if (unlimited && $('autoClaim').checked) maybeAutoClaim(r.name);
    // Scan illimité : coupe le batch dès que le seuil de libres est atteint.
    if (unlimited && unlimitedThreshold && freeList.length >= unlimitedThreshold) {
      unlimited = false;
      window.api.bulkStop();
    }
  }
  if (r.total) $('bulkBar').style.width = Math.round((r.done / r.total) * 100) + '%';
  // Pas de checkpoint pendant un scan illimité (uniTimer actif jusqu'au nettoyage) :
  // lastNames y est vide et allResults peut être énorme.
  if (!uniTimer && allResults.size % 25 === 0) saveCheckpoint();
});
function uniLine() {
  const secs = (Date.now() - uniStart) / 1000;
  // Débit = checkés DEPUIS le (re)démarrage / temps (sinon absurde après reprise).
  const rate = secs > 0 ? ((allResults.size - uniBaseCount) / secs).toFixed(1) : '0';
  return `∞ ${allResults.size} checkés · <span class="free">${tally.free} libres</span> · ` +
    `<span class="taken">${tally.taken} pris</span> · <span class="err">${tally.error} échecs</span> · ${rate}/s · ${fmtDur(secs * 1000)}`;
}
function proxyBadge(s) {
  if (s.proxiesTotal == null) return '';
  const cls = s.proxiesAlive === 0 ? 'err' : 'muted';
  return ` · <span class="${cls}">proxies ${s.proxiesAlive}/${s.proxiesTotal}</span>`;
}
window.api.onBulkStats((s) => {
  const extra = (s.throttled ? ' · <span class="warn">↓ throttle</span>' : '') + proxyBadge(s);
  // En illimité (détecté via uniTimer, fiable), on affiche le CUMUL (les
  // compteurs backend sont par-batch). Sinon : progression du run courant.
  if (uniTimer) { $('bulkEta').innerHTML = uniLine() + extra; return; }
  const eta = s.etaMs != null ? fmtDur(s.etaMs) : '—';
  const rate = s.rate ? s.rate.toFixed(1) : '0';
  $('bulkEta').innerHTML = `${s.done}/${s.total} · ${rate}/s · ETA ${eta}` +
    ` · <span class="free">${tally.free} libres</span> · <span class="taken">${tally.taken} pris</span> · <span class="err">${tally.error} échecs</span>` +
    extra;
});

// Checkpoint persistant (fichier userData via main). Sauvegarde débouncée pour
// ne pas spammer l'IPC pendant un gros scan.
let checkpointTimer = null;
function saveCheckpoint() {
  if (checkpointTimer) return;
  checkpointTimer = setTimeout(() => {
    checkpointTimer = null;
    window.api.checkpointSave({ names: lastNames, results: [...allResults.values()], tally, ts: Date.now() });
  }, 2000);
}
function saveCheckpointNow() {
  if (checkpointTimer) { clearTimeout(checkpointTimer); checkpointTimer = null; }
  return window.api.checkpointSave({ names: lastNames, results: [...allResults.values()], tally, ts: Date.now() });
}
async function loadCheckpoint() {
  try {
    const r = await window.api.checkpointLoad();
    const d = r && r.ok ? r.data : null;
    if (!d) return;
    allResults = new Map((d.results || []).map((v) => [v.name.toLowerCase(), v]));
    freeList = (d.results || []).filter((v) => v.state === 'free').map((v) => v.name);
    if (d.tally) tally = { free: d.tally.free || 0, taken: d.tally.taken || 0, error: d.tally.error || 0 };

    // Dernière session = SCAN ILLIMITÉ -> propose de reprendre (résultats conservés).
    if (d.unlimited) {
      const o = d.genOpts || {};
      if (o.mode) { $('genMode').value = o.mode; syncGenMode(); }
      if (o.length) $('genLen').value = o.length;
      if (o.charset) $('genCharset').value = o.charset;
      if (o.pattern != null) $('genPattern').value = o.pattern;
      if (o.filters) { $('filterOg').checked = !!o.filters.og; $('filterNoRepeat').checked = !!o.filters.noRepeat; }
      $('unlimitedInfo').innerHTML = `∞ ${allResults.size} checkés · <span class="free">${tally.free} libres</span> (session précédente)`;
      resumeUnlimited = true;
      $('resumeBtn').classList.remove('hidden');
      cprint('info', `Scan illimité précédent rechargé : ${allResults.size} checkés, ${freeList.length} libres — REPRENDRE pour continuer.`);
      return;
    }

    // Sinon : BULK CHECK.
    if (!Array.isArray(d.names) || !d.names.length) return;
    lastNames = d.names;
    $('bulkNames').value = lastNames.join('\n');
    updateBulkCount();
    const remaining = lastNames.filter((n) => !allResults.has(n.toLowerCase()));
    // Le bouton REPRENDRE est TOUJOURS proposé quand une session existe :
    // reprend les restants, ou relance la liste si la session était terminée.
    $('resumeBtn').classList.remove('hidden');
    if (remaining.length) {
      cprint('info', `Dernière session rechargée : ${remaining.length}/${lastNames.length} restants — REPRENDRE pour continuer.`);
    } else {
      cprint('info', `Dernière session rechargée (${lastNames.length} pseudos, terminée) — REPRENDRE pour relancer.`);
    }
  } catch { /* ignore */ }
}

function setBulkRunning(on) {
  $('bulkBtn').classList.toggle('hidden', on);
  $('bulkStopBtn').classList.toggle('hidden', !on);
  if (on) $('resumeBtn').classList.add('hidden');
  $('genUnlimitedBtn').disabled = on;
}

// ----- Scan illimité (génère + check en boucle jusqu'au stop ou au seuil) -----
let unlimited = false;
let unlimitedThreshold = 0;
let uniStart = 0, uniTimer = null, uniBaseCount = 0;

function currentGenOpts(count) {
  return {
    mode: $('genMode').value,
    length: Number($('genLen').value),
    charset: $('genCharset').value,
    count,
    pattern: $('genPattern').value.trim(),
    filters: { og: $('filterOg').checked, noRepeat: $('filterNoRepeat').checked },
  };
}
function setUnlimitedRunning(on) {
  $('genUnlimitedBtn').classList.toggle('hidden', on);
  $('genUnlimitedStopBtn').classList.toggle('hidden', !on);
  $('bulkBtn').disabled = on;
  $('genBtn').disabled = on;
}
function updateUniInfo() {
  const html = uniLine();
  $('unlimitedInfo').innerHTML = html;
  $('bulkEta').innerHTML = html; // même info cumulée dans le module BULK
}
// Checkpoint du scan illimité (débouncé) : conserve résultats + réglages pour reprise.
let uniCkptTimer = null;
function saveUnlimitedCheckpoint() {
  if (uniCkptTimer) return;
  uniCkptTimer = setTimeout(() => {
    uniCkptTimer = null;
    window.api.checkpointSave({ unlimited: true, genOpts: currentGenOpts(300), results: [...allResults.values()], tally, ts: Date.now() });
  }, 5000);
}
function saveUnlimitedCheckpointNow() {
  if (uniCkptTimer) { clearTimeout(uniCkptTimer); uniCkptTimer = null; }
  return window.api.checkpointSave({ unlimited: true, genOpts: currentGenOpts(300), results: [...allResults.values()], tally, ts: Date.now() });
}
$('genUnlimitedStopBtn').onclick = () => { unlimited = false; window.api.bulkStop(); cprint('warn', 'Arrêt du scan illimité…'); };
$('genUnlimitedBtn').onclick = () => startUnlimited(true);
async function startUnlimited(fresh) {
  if (unlimited) return;
  unlimited = true;
  autoClaimDone = false;
  resumeUnlimited = false; // on lance/reprend : plus une proposition en attente
  unlimitedThreshold = Number($('unlimitedThreshold').value) || 0;
  if (fresh) { freeList = []; allResults = new Map(); tally = { free: 0, taken: 0, error: 0 }; }
  lastNames = [];
  uniStart = Date.now();
  uniBaseCount = allResults.size; // pour un débit correct (checkés SINCE reprise)
  setUnlimitedRunning(true);
  $('bulkProgress').classList.remove('hidden');
  cprint('step', `SCAN ILLIMITÉ (${$('genMode').value})${fresh ? '' : ' · reprise'}${unlimitedThreshold ? ` · stop à ${unlimitedThreshold} libres` : ' · stop manuel'}`);
  clearInterval(uniTimer); uniTimer = setInterval(updateUniInfo, 500);

  let emptyStreak = 0;
  while (unlimited) {
    const gr = await window.api.generate(currentGenOpts(300));
    if (!gr.ok) { cprint('err', 'Gen: ' + gr.error); break; }
    const names = gr.names.filter((n) => !allResults.has(n.toLowerCase()));
    if (!names.length) {
      if (++emptyStreak >= 8) { cprint('warn', 'Espace de génération épuisé — arrêt du scan illimité.'); break; }
      continue;
    }
    emptyStreak = 0;
    await runBulk(names, { silent: true });
    saveUnlimitedCheckpoint(); // persiste la progression (reprise possible)
    if (!unlimited) break; // stoppé (manuel ou seuil) pendant le batch
    if (unlimitedThreshold && freeList.length >= unlimitedThreshold) { cprint('ok', `Seuil de ${unlimitedThreshold} libres atteint.`); break; }
    // Garde-fou mémoire : le scan illimité retient tout (dédup + CSV).
    if (allResults.size >= 500000) { cprint('warn', 'Limite mémoire (500k checkés) atteinte — arrêt du scan illimité.'); break; }
  }
  unlimited = false;
  clearInterval(uniTimer); uniTimer = null;
  await saveUnlimitedCheckpointNow(); // état final persistant pour reprise
  $('unlimitedInfo').innerHTML = uniLine(); // résumé final (cumulé)
  setUnlimitedRunning(false);
  $('bulkEta').textContent = '';
  cprint('ok', `Scan illimité terminé — ${allResults.size} checkés, ${freeList.length} libres.`);
  // Propose de reprendre dans la même session (résultats conservés).
  if (allResults.size) { resumeUnlimited = true; $('resumeBtn').classList.remove('hidden'); }
  await showTopFree();
  await exportFree({ auto: true });
};

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
  if (r.seen) {
    const d = new Date(r.seen.ts).toLocaleDateString('fr-FR');
    html += ` <span class="muted">· déjà vu ${esc(r.seen.state)} le ${d}</span>`;
  }
  $('checkResult').innerHTML = html;
  cprint(r.public?.free ? 'free' : 'taken', `[CHECK] ${logmsg}${r.account ? ' · ' + r.account : ''}`);
  refreshHistStats();
};

// ----- Historique -----
async function refreshHistStats() {
  const r = await window.api.historyStats();
  if (!r.ok) return;
  $('histStats').textContent = `${r.total} connus · ${r.free} libres`;
  const cell = (v, l) => `<div class="cell"><b>${v}</b><span>${l}</span></div>`;
  $('histStatsPanel').innerHTML =
    cell(r.total.toLocaleString('fr-FR'), 'checkés') +
    cell(r.free.toLocaleString('fr-FR'), 'libres') +
    cell(r.taken.toLocaleString('fr-FR'), 'pris') +
    cell(r.rate.toFixed(1) + '%', 'taux libre') +
    cell(r.free24, 'libres 24h') +
    cell(r.free7, 'libres 7j');
}
$('histSearchBtn').onclick = async () => {
  const q = $('histSearch').value.trim();
  const [lk, sr] = await Promise.all([window.api.historyLookup(q), window.api.historySearch(q)]);
  let html = '';
  if (q && lk.ok && lk.entry) {
    const d = new Date(lk.entry.ts).toLocaleDateString('fr-FR');
    const st = { free: '<span class="free">LIBRE</span>', taken: '<span class="bad">PRIS</span>' }[lk.entry.state] || esc(lk.entry.state);
    html += `${esc(q)} : ${st} (vu le ${d}) &nbsp; ·&nbsp; `;
  }
  const names = (sr.ok && sr.names) ? sr.names : [];
  html += `${names.length} libres connus${q ? ` contenant « ${esc(q)} »` : ''}`;
  $('histResult').innerHTML = html;
  if (names.length) cprint('free', `Libres connus: ${names.slice(0, 40).join('  ')}${names.length > 40 ? ' …' : ''}`);
};
$('histSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('histSearchBtn').click(); });
$('histExportBtn').onclick = async () => {
  const sr = await window.api.historyFreeAll();
  const names = (sr.ok && sr.names) ? sr.names : [];
  if (!names.length) { cprint('warn', 'Aucun libre connu à exporter.'); return; }
  const rk = await window.api.rankNames(names);
  const lines = (rk.ok ? rk.ranked.map((x) => x.name) : names);
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await window.api.saveTxt({ suggested: `libres-connus-${names.length}-${stamp}.txt`, content: lines.join('\n') + '\n' });
  if (r.ok) cprint('ok', `${names.length} libres connus (triés) → ${r.path}`);
};
$('histClearBtn').onclick = async () => {
  await window.api.historyClear();
  $('histResult').textContent = 'historique vidé';
  cprint('info', 'Historique vidé.');
  refreshHistStats();
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

// ----- Planification du drop (#4) -----
$('dropCalcBtn').onclick = () => {
  const v = $('dropLastChange').value;
  if (!v) { $('dropInfo').textContent = 'indique la date du dernier changement'; return; }
  const drop = new Date(new Date(v).getTime() + 37 * 86400000);
  // remplit le champ « planifié » (datetime-local, heure locale).
  const p = (n) => String(n).padStart(2, '0');
  $('snipeAt').value = `${drop.getFullYear()}-${p(drop.getMonth() + 1)}-${p(drop.getDate())}T${p(drop.getHours())}:${p(drop.getMinutes())}:00`;
  document.querySelector('input[name="smode"][value="at"]').checked = true;
  $('snipeAt').disabled = false; $('snipeIn').disabled = true;
  const soon = drop.getTime() - Date.now();
  $('dropInfo').innerHTML = `drop ≈ <span class="free">${drop.toLocaleString('fr-FR')}</span> (${soon > 0 ? 'dans ' + fmtDur(soon) : 'déjà passé'}) → mode planifié réglé`;
};

// ----- Export / import config (#7) -----
$('cfgExportBtn').onclick = async () => {
  const r = await window.api.configExport({ proxies: proxiesArray(), gen: currentGenOpts(50) });
  if (r.canceled) return;
  if (r.ok) cprint('ok', `Config exportée → ${r.path}`); else cprint('err', 'Export config: ' + r.error);
};
$('cfgImportBtn').onclick = async () => {
  const r = await window.api.configImport();
  if (r.canceled) return;
  if (!r.ok) { cprint('err', 'Import config: ' + r.error); return; }
  if (r.data.proxies?.length) { $('proxies').value = r.data.proxies.join('\n'); $('proxyCount').textContent = `${r.data.proxies.length} proxies`; }
  const g = r.data.gen || {};
  if (g.mode) { $('genMode').value = g.mode; syncGenMode(); }
  if (g.length) $('genLen').value = g.length;
  if (g.charset) $('genCharset').value = g.charset;
  cprint('ok', 'Config importée (proxies, réglages, watchlist).');
  refreshWatch();
};

// ----- Watchlist + surveillance (#3) -----
async function refreshWatch() {
  const r = await window.api.watchGet();
  if (!r.ok) return;
  $('watchList').innerHTML = r.names.map((n) =>
    `<span class="chip" data-w="${esc(n)}">${esc(n)} <span class="x" data-del="${esc(n)}">✕</span></span>`).join('');
}
$('watchAddBtn').onclick = async () => {
  const names = $('watchInput').value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;
  await window.api.watchAdd(names);
  $('watchInput').value = '';
  refreshWatch();
};
$('watchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('watchAddBtn').click(); });
$('watchList').onclick = async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { await window.api.watchRemove(del.dataset.del); refreshWatch(); return; }
  const chip = e.target.closest('.chip');
  if (chip && chip.dataset.w) { $('checkName').value = chip.dataset.w; $('checkBtn').click(); }
};
$('watchAutoclaim').onchange = () => window.api.monitorAutoclaim($('watchAutoclaim').checked);
$('monitorToggleBtn').onclick = async () => {
  const st = await window.api.monitorStatus();
  if (st.on) await window.api.monitorStop(); else await window.api.monitorStart();
};
function setMonitorUI(on) {
  $('monitorState').textContent = on ? '● surveillance active' : '○ arrêtée';
  $('monitorState').className = on ? 'free' : 'muted';
  $('monitorToggleBtn').textContent = on ? 'arrêter surveillance' : 'démarrer surveillance';
}
window.api.onMonitorStatus((s) => setMonitorUI(s.on));
window.api.onWatchFree(({ name }) => { cprint('free', `★ WATCHLIST : ${name} est LIBRE !`); });

// ----- Init -----
refreshAccount();
refreshAccounts();
refreshHistStats();
refreshWatch();
window.api.monitorStatus().then((s) => { if (s.ok) { setMonitorUI(s.on); $('watchAutoclaim').checked = !!s.autoclaim; } });
updateBulkCount();
loadCheckpoint();
cprint('step', 'Minecraft Sniper prêt. Colle un token ou connecte-toi (MS).');
