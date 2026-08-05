// Écran d'accès (gate d'abonnement). Parle au main via window.subgate (preload).
const $ = (id) => document.getElementById(id);
function show(w) { for (const k of ['login', 'signup', 'pay']) $(k).classList.toggle('hide', k !== w); }

async function after(r) {
  if (r && r.ok && r.entitled) { await window.subgate.enter(); return; }
  if (r && r.needLogin) { show('login'); $('e1').textContent = 'Session expirée, reconnecte-toi.'; return; }
  show('pay');
  if (r && r.offline) $('e2').textContent = 'Backend injoignable, réessaie dans un instant.';
  else if (r && r.status && r.status !== 'none') $('e2').textContent = 'Statut : ' + r.status;
  else $('e2').textContent = '';
}

(async () => {
  const st = await window.subgate.state();
  if (st.hasSession) after(await window.subgate.refresh());
  else show('login');
})();

$('btnLogin').onclick = async () => { $('e1').textContent = '…'; after(await window.subgate.login($('email').value.trim(), $('pass').value)); };
$('btnToSignup').onclick = () => show('signup');
$('btnToLogin').onclick = () => show('login');
$('btnSignup').onclick = async () => {
  $('e3').textContent = '…';
  const r = await window.subgate.signup($('semail').value.trim(), $('spass').value);
  if (!r.ok) { $('e3').textContent = r.error; return; }
  $('e3').textContent = r.needConfirm ? 'Compte créé — confirme ton email puis connecte-toi.' : 'Compte créé, connecte-toi.';
  show('login');
};
$('btnPay').onclick = () => window.subgate.openCheckout();
$('btnRecheck').onclick = async () => { $('e2').textContent = 'Vérification…'; after(await window.subgate.refresh()); };
$('btnLogout').onclick = async () => { await window.subgate.logout(); show('login'); };
