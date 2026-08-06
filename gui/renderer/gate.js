// Écran d'accès (gate d'abonnement). Parle au main via window.subgate (preload).
const $ = (id) => document.getElementById(id);
function show(w) { for (const k of ['login', 'signup', 'pay']) $(k).classList.toggle('hide', k !== w); }

async function after(r) {
  if (r && r.entitled) { await window.subgate.enter(); return; }
  if (r && r.needLogin) { show('login'); return; }
  show('pay');
  if (r && r.offline) $('e2').textContent = 'Backend injoignable — réessaie dans un instant.';
  else if (r && r.status && r.status !== 'none') $('e2').textContent = 'Statut : ' + r.status;
  else $('e2').textContent = '';
}
function guard(btn, fn) { // évite les clics concurrents (B6)
  return async () => { const b = $(btn); if (b.disabled) return; b.disabled = true; try { await fn(); } finally { b.disabled = false; } };
}

(async () => {
  const st = await window.subgate.state();
  if (st.priceLabel) { const p = $('payTitle'); if (p) p.textContent = 'Abonne-toi — ' + st.priceLabel; }
  if (st.hasSession) after(await window.subgate.access());
  else show('login');
})();

$('btnLogin').onclick = guard('btnLogin', async () => {
  $('e1').textContent = 'Connexion…';
  const r = await window.subgate.login($('email').value.trim(), $('pass').value);
  if (r && r.error) $('e1').textContent = r.error;
  await after(r);
});
$('btnToSignup').onclick = () => show('signup');
$('btnToLogin').onclick = () => show('login');
$('btnSignup').onclick = guard('btnSignup', async () => {
  $('e3').textContent = 'Création…';
  const r = await window.subgate.signup($('semail').value.trim(), $('spass').value);
  if (!r.ok) { $('e3').textContent = r.error; return; }
  $('e3').textContent = r.needConfirm ? 'Compte créé — confirme ton email puis connecte-toi.' : 'Compte créé, connecte-toi.';
  show('login');
});
$('btnPay').onclick = () => window.subgate.openCheckout();
$('btnRecheck').onclick = guard('btnRecheck', async () => { $('e2').textContent = 'Vérification…'; await after(await window.subgate.refresh()); });
$('btnLogout').onclick = async () => { await window.subgate.logout(); show('login'); };
