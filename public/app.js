/**
 * NexBank ATM — Frontend Application Logic
 */

const API = '/api';

// Colours for registered account avatars
const AVATAR_COLORS = [
  'linear-gradient(135deg,#8b5cf6,#6366f1)',
  'linear-gradient(135deg,#0ea5e9,#06b6d4)',
  'linear-gradient(135deg,#f59e0b,#ef4444)',
  'linear-gradient(135deg,#22c55e,#0ea5e9)',
  'linear-gradient(135deg,#ec4899,#8b5cf6)',
  'linear-gradient(135deg,#f97316,#f59e0b)',
];
let authToken = null;
let currentAccount = null;
let sessionTimer = null;
let sessionSecondsLeft = 30 * 60;
let txOffset = 0;
const TX_PAGE_SIZE = 10;

// ─── Utility ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = iso => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const capitalize = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

async function apiFetch(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(API + endpoint, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Tab switch ──────────────────────────────────────────────────────────────
function switchTab(tab) {
  $('tab-login').classList.toggle('active', tab === 'login');
  $('tab-register').classList.toggle('active', tab === 'register');
  $('login-form').style.display    = tab === 'login' ? 'flex' : 'none';
  $('register-form').style.display = tab === 'register' ? 'flex' : 'none';
  hideMsg('login-error');
  hideMsg('reg-error');
}
window.switchTab = switchTab; // expose to onclick

// ─── Screen / Panel ──────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function showPanel(panelId) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  $('panel-' + panelId).classList.add('active');
  const nav = $('nav-' + panelId);
  if (nav) nav.classList.add('active');
  closeSidebar();
  if (panelId === 'overview') { loadBalance(); loadMiniStatement(); }
  if (panelId === 'history')  { txOffset = 0; loadHistory(); }
}

// ─── Clock ───────────────────────────────────────────────────────────────────
function startClock() {
  const tick = () => {
    const el = $('current-time');
    if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  };
  tick(); setInterval(tick, 1000);
}

function updateGreeting() {
  const h = new Date().getHours();
  $('topbar-greeting').textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ─── Session Timer ────────────────────────────────────────────────────────────
function startSessionTimer() {
  sessionSecondsLeft = 30 * 60;
  clearInterval(sessionTimer);
  sessionTimer = setInterval(() => {
    sessionSecondsLeft--;
    const m = String(Math.floor(sessionSecondsLeft / 60)).padStart(2, '0');
    const s = String(sessionSecondsLeft % 60).padStart(2, '0');
    const el = $('session-timer');
    if (el) {
      el.textContent = `${m}:${s}`;
      el.className = 'timer-val';
      if (sessionSecondsLeft <= 300) el.classList.add('warn');
      if (sessionSecondsLeft <= 60)  el.classList.add('danger');
    }
    if (sessionSecondsLeft <= 0) { clearInterval(sessionTimer); logout(true); }
  }, 1000);
}

// ─── Card formatting ─────────────────────────────────────────────────────────
function fmtCard(v) { return v.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim().slice(0, 19); }

$('card-input').addEventListener('input', e => { e.target.value = fmtCard(e.target.value); });
$('transfer-card').addEventListener('input', e => { e.target.value = fmtCard(e.target.value); });

// ─── PIN toggle ───────────────────────────────────────────────────────────────
$('pin-toggle').addEventListener('click', () => {
  const inp = $('pin-input');
  const isPass = inp.type === 'password';
  inp.type = isPass ? 'text' : 'password';
  $('eye-show').style.display = isPass ? 'none' : '';
  $('eye-hide').style.display = isPass ? ''    : 'none';
});

// ─── Demo card buttons ────────────────────────────────────────────────────────
document.querySelectorAll('.demo-item').forEach(btn => {
  btn.addEventListener('click', () => {
    $('card-input').value = btn.dataset.card;
    $('pin-input').value  = btn.dataset.pin;
  });
});

// ─── Msg helpers ─────────────────────────────────────────────────────────────
function showMsg(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? '' : 'none';
}
function hideMsg(id) { showMsg(id, ''); }

// ─── Btn loading ─────────────────────────────────────────────────────────────
function setBtnLoading(btnId, on) {
  const btn = $(btnId);
  if (!btn) return;
  const label   = btn.querySelector('.btn-label');
  const spinner = btn.querySelector('.spinner');
  if (label)   label.style.display   = on ? 'none' : '';
  if (spinner) spinner.style.display = on ? ''     : 'none';
  btn.disabled = on;
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideMsg('login-error');
  const card = $('card-input').value.trim();
  const pin  = $('pin-input').value.trim();
  if (!card || !pin) return showMsg('login-error', 'Please enter your card number and PIN.');
  if (pin.length !== 4) return showMsg('login-error', 'PIN must be exactly 4 digits.');

  setBtnLoading('login-btn', true);
  try {
    const data = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ cardNumber: card, pin }) });
    authToken = data.token;
    currentAccount = data.account;
    onLoginSuccess();
  } catch (err) {
    showMsg('login-error', err.message);
  } finally {
    setBtnLoading('login-btn', false);
  }
});

function onLoginSuccess() {
  const initials = currentAccount.fullName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  $('user-avatar').textContent     = initials;
  $('sidebar-name').textContent    = currentAccount.fullName;
  $('sidebar-card').textContent    = '•••• ' + currentAccount.cardNumber.slice(-4);
  $('sidebar-type').textContent    = capitalize(currentAccount.accountType);
  $('topbar-name').textContent     = currentAccount.fullName.split(' ')[0];
  $('ov-account-type').textContent    = capitalize(currentAccount.accountType) + ' Account';
  $('ov-card-number-full').textContent = currentAccount.cardNumber;
  updateGreeting();
  startClock();
  startSessionTimer();
  showScreen('screen-dashboard');
  showPanel('overview');
}

// ─── REGISTER ─────────────────────────────────────────────────────────────────
$('register-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideMsg('reg-error');
  const fullName    = $('reg-name').value.trim();
  const accountType = $('reg-type').value;
  const pin         = $('reg-pin').value.trim();
  const confirmPin  = $('reg-confirm').value.trim();

  if (!fullName) return showMsg('reg-error', 'Please enter your full name.');
  if (fullName.split(' ').length < 2) return showMsg('reg-error', 'Please enter both first and last name.');
  if (pin.length !== 4 || isNaN(pin)) return showMsg('reg-error', 'PIN must be exactly 4 digits.');
  if (pin !== confirmPin) return showMsg('reg-error', 'PINs do not match.');

  setBtnLoading('register-btn', true);
  try {
    const data = await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ fullName, pin, confirmPin, accountType })
    });
    // Clear form
    $('reg-name').value = '';
    $('reg-pin').value  = '';
    $('reg-confirm').value = '';
    // Show success modal with card number
    $('new-card-number').textContent = data.cardNumber;
    $('reg-modal-meta').textContent = `${capitalize(data.accountType)} Account · ${data.fullName}`;
    $('reg-success-modal').style.display = 'flex';
    loadRegisteredAccounts(); // refresh the list
  } catch (err) {
    showMsg('reg-error', err.message);
  } finally {
    setBtnLoading('register-btn', false);
  }
});

// Copy card number (registration modal)
$('copy-card-btn').addEventListener('click', () => {
  const num = $('new-card-number').textContent;
  navigator.clipboard.writeText(num).then(() => {
    $('copy-card-btn').textContent = '✓ Copied!';
    setTimeout(() => { $('copy-card-btn').textContent = '📋 Copy'; }, 2000);
  });
});

// Copy MY card number (dashboard overview)
$('copy-my-card').addEventListener('click', () => {
  if (!currentAccount) return;
  navigator.clipboard.writeText(currentAccount.cardNumber).then(() => {
    const btn = $('copy-my-card');
    const label = $('copy-my-card-label');
    btn.classList.add('copied');
    label.textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      label.textContent = 'Copy';
    }, 2000);
  });
});

// After registration — go to login tab
$('reg-success-close').addEventListener('click', () => {
  $('reg-success-modal').style.display = 'none';
  switchTab('login');
  // Pre-fill card number
  $('card-input').value = $('new-card-number').textContent;
  $('pin-input').focus();
});

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
async function logout(expired = false) {
  clearInterval(sessionTimer);
  try { if (authToken) await apiFetch('/auth/logout', { method: 'POST' }); } catch {}
  authToken = null; currentAccount = null;
  $('card-input').value = '';
  $('pin-input').value  = '';
  showScreen('screen-login');
  switchTab('login');
  if (expired) showMsg('login-error', 'Session expired. Please log in again.');
}
$('logout-btn').addEventListener('click', () => logout());

// ─── Navigation ───────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn, .quick-btn, .link-btn').forEach(el => {
  el.addEventListener('click', () => { if (el.dataset.panel) showPanel(el.dataset.panel); });
});

// Sidebar mobile
function openSidebar()  { $('sidebar').classList.add('open'); $('sidebar-overlay').classList.add('active'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-overlay').classList.remove('active'); }
$('hamburger').addEventListener('click', openSidebar);
$('sidebar-close').addEventListener('click', closeSidebar);
$('sidebar-overlay').addEventListener('click', closeSidebar);

// ─── Balance ─────────────────────────────────────────────────────────────────
async function loadBalance() {
  try {
    const data = await apiFetch('/account/balance');
    const el = $('balance-amount');
    animateNum(el, parseFloat(el.dataset.raw || 0), data.balance);
    el.dataset.raw = data.balance;
    $('balance-time').textContent = new Date(data.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { $('balance-amount').textContent = 'Error'; }
}

function animateNum(el, from, to) {
  const dur = 700; const start = performance.now();
  const run = now => {
    const p = Math.min((now - start) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(run);
    else el.textContent = fmt(to);
  };
  requestAnimationFrame(run);
}

$('refresh-balance').addEventListener('click', () => loadBalance());

// ─── Mini Statement ───────────────────────────────────────────────────────────
async function loadMiniStatement() {
  const c = $('mini-statement');
  c.innerHTML = '<div class="skel-wrap"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
  try {
    const data = await apiFetch('/account/mini-statement');
    if (!data.transactions.length) { c.innerHTML = '<div class="tx-empty">No transactions yet.</div>'; return; }
    c.innerHTML = data.transactions.map(renderTx).join('');
  } catch { c.innerHTML = '<div class="tx-empty">Could not load.</div>'; }
}

// ─── Transaction History ──────────────────────────────────────────────────────
async function loadHistory(append = false) {
  const c = $('tx-list');
  if (!append) { txOffset = 0; c.innerHTML = '<div class="loading-state"><div class="spin-circle"></div><p>Loading...</p></div>'; }
  try {
    const data = await apiFetch(`/transactions/history?limit=${TX_PAGE_SIZE}&offset=${txOffset}`);
    $('stat-total').textContent = data.total;
    if (!data.transactions.length && !append) { c.innerHTML = '<div class="tx-empty">No transactions found.</div>'; return; }
    const html = data.transactions.map(renderTx).join('');
    append ? c.insertAdjacentHTML('beforeend', html) : (c.innerHTML = html);
    txOffset += data.transactions.length;
    $('load-more-btn').style.display = txOffset < data.total ? '' : 'none';
  } catch { c.innerHTML = '<div class="tx-empty">Error loading history.</div>'; }
}
$('load-more-btn').addEventListener('click', () => loadHistory(true));

// ─── Render TX ────────────────────────────────────────────────────────────────
function renderTx(tx) {
  const icons = { withdrawal: '💸', deposit: '💰', transfer_out: '📤', transfer_in: '📥' };
  const labels = { withdrawal: 'Cash Withdrawal', deposit: 'Cash Deposit', transfer_out: 'Transfer Sent', transfer_in: 'Transfer Received' };
  const isCredit = ['deposit', 'transfer_in'].includes(tx.type);
  const amtClass = isCredit ? 'cr' : 'dr';
  const sign = isCredit ? '+' : '-';
  const amount = tx.amount != null ? `${sign}₹${fmt(tx.amount)}` : '—';
  const ref = tx.reference_id ? `<span class="tx-ref">${tx.reference_id}</span>` : '';
  return `<div class="tx-item">
    <div class="tx-ico ${tx.type}">${icons[tx.type] || '🔄'}</div>
    <div class="tx-info">
      <div class="tx-desc">${tx.description || labels[tx.type] || tx.type}</div>
      <div class="tx-meta">${fmtDate(tx.created_at)} ${ref}</div>
    </div>
    <div>
      <div class="tx-amt ${amtClass}">${amount}</div>
      <div class="tx-bal">Bal: ₹${fmt(tx.balance_after)}</div>
    </div>
  </div>`;
}

// ─── Amount Chips ─────────────────────────────────────────────────────────────
function setupChips(inputId) {
  const input = $(inputId);
  if (!input) return;
  const panel = input.closest('.panel, .form-card');
  const chips = panel ? panel.querySelectorAll('.amt-chip') : [];
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      input.value = chip.dataset.amount;
    });
  });
  input.addEventListener('input', () => {
    chips.forEach(c => {
      c.classList.toggle('selected', c.dataset.amount === input.value);
    });
  });
}
setupChips('withdraw-amount');
setupChips('deposit-amount');

// ─── Modals ───────────────────────────────────────────────────────────────────
function showSuccessModal(msg, details = {}) {
  $('modal-message').textContent = msg;
  const el = $('modal-details');
  el.innerHTML = Object.entries(details).map(([k, v]) =>
    `<div class="dr"><span class="dl">${k}</span><span class="dv ${k === 'New Balance' ? 'green' : ''}">${v}</span></div>`
  ).join('');
  el.style.display = Object.keys(details).length ? '' : 'none';
  $('success-modal').style.display = 'flex';
}
function showErrorModal(msg) {
  $('error-modal-message').textContent = msg;
  $('error-modal').style.display = 'flex';
}

$('modal-close').addEventListener('click', () => {
  $('success-modal').style.display = 'none';
  loadBalance(); loadMiniStatement();
});
$('error-modal-close').addEventListener('click', () => { $('error-modal').style.display = 'none'; });
[$('success-modal'), $('error-modal'), $('reg-success-modal')].forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.style.display = 'none'; });
});

// ─── WITHDRAW ─────────────────────────────────────────────────────────────────
$('withdraw-btn').addEventListener('click', async () => {
  const amount = parseFloat($('withdraw-amount').value);
  hideMsg('withdraw-error');
  if (!amount || amount <= 0) return showMsg('withdraw-error', 'Please enter a valid amount.');
  if (amount % 100 !== 0)   return showMsg('withdraw-error', 'Amount must be in multiples of ₹100.');
  if (amount > 50000)        return showMsg('withdraw-error', 'Maximum withdrawal is ₹50,000.');
  setBtnLoading('withdraw-btn', true);
  try {
    const data = await apiFetch('/transaction/withdraw', { method: 'POST', body: JSON.stringify({ amount }) });
    $('withdraw-amount').value = '';
    document.querySelectorAll('#panel-withdraw .amt-chip').forEach(c => c.classList.remove('selected'));
    showSuccessModal(data.message, { 'Dispensed': `₹${fmt(data.amountDispensed)}`, 'New Balance': `₹${fmt(data.newBalance)}`, 'Reference': data.referenceId });
  } catch (err) { showErrorModal(err.message); }
  finally { setBtnLoading('withdraw-btn', false); }
});

// ─── DEPOSIT ──────────────────────────────────────────────────────────────────
$('deposit-btn').addEventListener('click', async () => {
  const amount = parseFloat($('deposit-amount').value);
  hideMsg('deposit-error');
  if (!amount || amount <= 0) return showMsg('deposit-error', 'Please enter a valid amount.');
  if (amount > 200000)        return showMsg('deposit-error', 'Maximum deposit is ₹2,00,000.');
  setBtnLoading('deposit-btn', true);
  try {
    const data = await apiFetch('/transaction/deposit', { method: 'POST', body: JSON.stringify({ amount }) });
    $('deposit-amount').value = '';
    document.querySelectorAll('#panel-deposit .amt-chip').forEach(c => c.classList.remove('selected'));
    showSuccessModal(data.message, { 'Deposited': `₹${fmt(amount)}`, 'New Balance': `₹${fmt(data.newBalance)}`, 'Reference': data.referenceId });
  } catch (err) { showErrorModal(err.message); }
  finally { setBtnLoading('deposit-btn', false); }
});

// ─── TRANSFER ─────────────────────────────────────────────────────────────────
$('transfer-btn').addEventListener('click', async () => {
  const toCard = $('transfer-card').value.trim();
  const amount = parseFloat($('transfer-amount').value);
  hideMsg('transfer-error');
  if (!toCard) return showMsg('transfer-error', 'Please enter recipient card number.');
  if (!amount || amount <= 0) return showMsg('transfer-error', 'Please enter a valid amount.');
  if (amount > 100000)        return showMsg('transfer-error', 'Maximum transfer is ₹1,00,000.');
  setBtnLoading('transfer-btn', true);
  try {
    const data = await apiFetch('/transaction/transfer', { method: 'POST', body: JSON.stringify({ toCardNumber: toCard, amount }) });
    $('transfer-card').value = '';
    $('transfer-amount').value = '';
    showSuccessModal(data.message, { 'Transferred': `₹${fmt(amount)}`, 'New Balance': `₹${fmt(data.newBalance)}`, 'Reference': data.referenceId });
  } catch (err) { showErrorModal(err.message); }
  finally { setBtnLoading('transfer-btn', false); }
});

// ─── Keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    $('success-modal').style.display = 'none';
    $('error-modal').style.display   = 'none';
    $('reg-success-modal').style.display = 'none';
    closeSidebar();
  }
});

// ─── Registered Accounts Quick-Fill ─────────────────────────────────────────
async function loadRegisteredAccounts() {
  try {
    const data = await apiFetch('/accounts/list');
    const section = $('registered-section');
    const list    = $('registered-list');
    const badge   = $('reg-count');
    if (!data.accounts || data.accounts.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    badge.textContent = data.accounts.length;
    list.innerHTML = data.accounts.map((acc, i) => {
      const initials = acc.full_name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
      const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
      const masked = '•••• ' + acc.card_number.slice(-4);
      return `<button type="button" class="demo-item reg-item"
        data-card="${acc.card_number}"
        style="--reg-color:x">
        <div class="demo-avatar" style="background:${color}">${initials}</div>
        <div>
          <p class="demo-name">${acc.full_name}</p>
          <p class="demo-card">${acc.card_number.replace(/(\d{4})/g,'$1 ').trim().slice(0,19)} · ${acc.account_type}</p>
        </div>
        <span class="reg-arrow">→</span>
      </button>`;
    }).join('');
    // bind click — fills card only (user enters their own PIN)
    list.querySelectorAll('.reg-item').forEach(btn => {
      btn.addEventListener('click', () => {
        $('card-input').value = btn.dataset.card;
        $('pin-input').value  = '';
        $('pin-input').focus();
      });
    });
  } catch { /* silently ignore */ }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
startClock();
loadRegisteredAccounts();
