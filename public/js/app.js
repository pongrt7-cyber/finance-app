let categories = [];
let trendChart = null;
let currentTxnTab = 'expense';
let currentStatsRange = 'today';
let currentPayment = 'เงินสด';
let editingExpenseId = null;

function fmt(n) {
  const num = Number(n || 0);
  const sign = num < 0 ? '-' : '';
  return sign + '฿' + Math.abs(num).toLocaleString('th-TH', { maximumFractionDigits: 0 });
}
function firstOfMonth() {
  return new Date().toISOString().slice(0, 7) + '-01';
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------------- Navigation ---------------- */
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${view}`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));

  if (view === 'dashboard') loadDashboard();
  if (view === 'stats') loadStats(currentStatsRange);
  if (view === 'settings') loadSettings();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.getElementById('btnHeaderSettings').addEventListener('click', () => switchView('settings'));

/* ---------------- Dashboard ---------------- */
async function loadDashboard() {
  try {
    const d = await API.get('/stats/dashboard');
    document.getElementById('dashRemaining').textContent = fmt(d.remaining);
    document.getElementById('dashSalary').textContent = fmt(d.salary);
    document.getElementById('dashUsedPct').textContent = `ใช้ไป ${d.usedPct}%`;
    document.getElementById('dashUsedBar').style.width = Math.min(Math.max(d.usedPct, 0), 100) + '%';
    document.getElementById('dashDailyBudget').textContent = fmt(d.dailyBudget);

    renderCategoryBars(d.byCategory);
    renderRecentList(d.recent);
    loadTctWidget();
    loadBudgetWidget();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function renderCategoryBars(data) {
  const wrap = document.getElementById('categoryBars');
  const empty = document.getElementById('categoryEmpty');
  if (!data.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const max = Math.max(...data.map(c => c.total));
  wrap.innerHTML = data.map(c => `
    <div class="cat-bar-row">
      <span class="cat-bar-name">${c.name}</span>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${(c.total / max * 100).toFixed(0)}%"></div></div>
      <span class="cat-bar-amt mono">${fmt(c.total)}</span>
    </div>
  `).join('');
}

function renderRecentList(items) {
  const ul = document.getElementById('recentList');
  if (!items.length) {
    ul.innerHTML = '<li class="plain empty-note">ยังไม่มีรายการ</li>';
    return;
  }
  ul.innerHTML = items.map(e => `
    <li class="ledger-item">
      <div class="swipe-actions">
        <button class="swipe-btn edit" onclick="openEditExpense(${e.id})">แก้ไข</button>
        <button class="swipe-btn delete" onclick="deleteExpense(${e.id})">ลบ</button>
      </div>
      <div class="swipe-content" data-id="${e.id}">
        <div class="ledger-main">
          <p class="ledger-title">${e.merchant || e.category_name || 'ไม่ระบุ'}</p>
          <p class="ledger-sub">${e.category_name} · ${e.expense_date}</p>
        </div>
        <span class="ledger-amt neg mono">-${fmt(e.amount)}</span>
      </div>
    </li>
  `).join('');
  attachSwipeHandlers(ul);
}

/* ---------------- Swipe to reveal edit/delete ---------------- */
function attachSwipeHandlers(container) {
  container.querySelectorAll('.swipe-content').forEach(el => {
    let startX = 0, currentX = 0, dragging = false;
    const OPEN = -140;

    const onStart = (x) => { startX = x; dragging = true; el.style.transition = 'none'; };
    const onMove = (x) => {
      if (!dragging) return;
      const delta = x - startX;
      const base = el.dataset.open === '1' ? OPEN : 0;
      currentX = Math.min(0, Math.max(OPEN, base + delta));
      el.style.transform = `translateX(${currentX}px)`;
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      el.style.transition = 'transform .2s ease';
      const shouldOpen = currentX < OPEN / 2;
      el.style.transform = `translateX(${shouldOpen ? OPEN : 0}px)`;
      el.dataset.open = shouldOpen ? '1' : '0';
      // ปิดแถวอื่นที่เปิดค้างไว้
      if (shouldOpen) {
        container.querySelectorAll('.swipe-content').forEach(other => {
          if (other !== el && other.dataset.open === '1') {
            other.style.transform = 'translateX(0px)';
            other.dataset.open = '0';
          }
        });
      }
    };

    el.addEventListener('touchstart', (e) => onStart(e.touches[0].clientX), { passive: true });
    el.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX), { passive: true });
    el.addEventListener('touchend', onEnd);
  });
}

async function loadTctWidget() {
  try {
    const settings = await API.get('/settings');
    const limit = parseFloat(settings.tct_limit || 0);
    const widget = document.getElementById('tctWidget');
    if (!limit || limit <= 0) { widget.classList.add('hidden'); return; }
    widget.classList.remove('hidden');

    const rows = await API.get(`/expenses?from=${firstOfMonth()}&to=${todayStr()}&payment_method=${encodeURIComponent('ไทยช่วยไทย')}`);
    const used = rows.reduce((s, r) => s + r.amount, 0);
    const remain = Math.max(limit - used, 0);

    document.getElementById('tctUsed').textContent = `ใช้ไป ${fmt(used)}`;
    document.getElementById('tctRemain').textContent = fmt(remain);
    document.getElementById('tctBar').style.width = Math.min((used / limit) * 100, 100) + '%';
  } catch {
    document.getElementById('tctWidget').classList.add('hidden');
  }
}

async function loadBudgetWidget() {
  try {
    const budgets = await API.get('/budgets');
    const near = budgets.filter(b => b.monthly_limit > 0 && (b.spent / b.monthly_limit) >= 0.7);
    const widget = document.getElementById('budgetWidget');
    if (!near.length) { widget.classList.add('hidden'); return; }
    widget.classList.remove('hidden');

    document.getElementById('budgetList').innerHTML = near.map(b => {
      const pct = Math.min((b.spent / b.monthly_limit) * 100, 100);
      const cls = b.spent >= b.monthly_limit ? 'over' : pct >= 90 ? 'over' : pct >= 70 ? 'warn' : 'ok';
      return `
        <div class="budget-row">
          <div class="budget-row-top">
            <span>${b.category_name}</span>
            <b class="mono">${fmt(b.spent)} / ${fmt(b.monthly_limit)}</b>
          </div>
          <div class="budget-track"><div class="budget-fill ${cls}" style="width:${pct.toFixed(0)}%"></div></div>
        </div>
      `;
    }).join('');
  } catch {
    document.getElementById('budgetWidget').classList.add('hidden');
  }
}

/* ---------------- Edit / delete expense ---------------- */
async function openEditExpense(id) {
  try {
    const rows = await API.get('/expenses');
    const row = rows.find(r => r.id === id);
    if (!row) return showToast('ไม่พบรายการ', 'error');

    editingExpenseId = id;
    openTxnModal('expense');
    document.getElementById('expAmount').value = row.amount;
    document.getElementById('expCategory').value = row.category_id;
    document.getElementById('expMerchant').value = row.merchant || '';
    selectPayment(row.payment_method || 'เงินสด');
    document.querySelector('#formExpense .btn-primary').textContent = 'บันทึกการแก้ไข';
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteExpense(id) {
  if (!confirm('ลบรายการนี้?')) return;
  try {
    await API.del(`/expenses/${id}`);
    showToast('ลบรายการแล้ว', 'success');
    loadDashboard();
  } catch (e) { showToast(e.message, 'error'); }
}

function selectPayment(method) {
  currentPayment = method;
  document.querySelectorAll('#paymentTags .tag-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.payment === method);
  });
}

async function loadCategories() {
  categories = await API.get('/categories');
  const sel = document.getElementById('expCategory');
  sel.innerHTML = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

  const quickNames = ['ค่ากิน', 'ค่าน้ำมัน', 'ค่าห้อง', 'ค่าเน็ต'];
  const quickWrap = document.getElementById('quickCategoryTags');
  quickWrap.innerHTML = categories
    .filter(c => quickNames.includes(c.name))
    .map(c => `<button type="button" class="tag-btn" data-id="${c.id}" onclick="selectQuickTag(${c.id})">${c.name}</button>`)
    .join('');
}

function selectQuickTag(categoryId) {
  document.getElementById('expCategory').value = categoryId;
  document.querySelectorAll('.tag-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.id) === categoryId);
  });
}

/* ---------------- Modal: add transaction ---------------- */
function openTxnModal(tab) {
  document.getElementById('modalTxn').classList.remove('hidden');
  switchTxnTab(tab);
}
function openAddTxn(tab) {
  editingExpenseId = null;
  openTxnModal(tab);
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  editingExpenseId = null;
}

function switchTxnTab(tab) {
  currentTxnTab = tab;
  document.getElementById('tabExpense').classList.toggle('active', tab === 'expense');
  document.getElementById('tabIncome').classList.toggle('active', tab === 'income');
  document.getElementById('formExpense').classList.toggle('hidden', tab !== 'expense');
  document.getElementById('formIncome').classList.toggle('hidden', tab !== 'income');

  if (tab === 'expense') {
    document.getElementById('aiTextInput').value = '';
    document.getElementById('expAmount').value = '';
    document.getElementById('expMerchant').value = '';
    document.querySelectorAll('.tag-btn[data-id]').forEach(b => b.classList.remove('active'));
    if (!editingExpenseId) {
      selectPayment('เงินสด');
      document.querySelector('#formExpense .btn-primary').textContent = 'บันทึกรายจ่าย';
    }
  } else {
    prefillIncome();
  }
}

async function prefillIncome() {
  try {
    const current = await API.get('/income/current');
    document.getElementById('incomeUnlockBox').classList.toggle('hidden', !current.locked);
    document.getElementById('incAmount').value = current.amount || '';
  } catch { /* ignore */ }
}

/* ---------------- Save expense ---------------- */
async function saveExpense() {
  const amount = parseFloat(document.getElementById('expAmount').value);
  const category_id = document.getElementById('expCategory').value;
  const merchant = document.getElementById('expMerchant').value.trim();
  const payment_method = currentPayment;
  if (!amount || amount <= 0) return showToast('กรุณาระบุจำนวนเงิน', 'error');
  if (!category_id) return showToast('กรุณาเลือกหมวดหมู่', 'error');

  const now = new Date();
  try {
    if (editingExpenseId) {
      await API.put(`/expenses/${editingExpenseId}`, {
        amount, category_id, merchant: merchant || null,
        payment_method,
        is_state_welfare: payment_method === 'ไทยช่วยไทย' ? 1 : 0,
        expense_date: now.toISOString().slice(0, 10),
        expense_time: now.toTimeString().slice(0, 5)
      });
      showToast('แก้ไขรายการแล้ว', 'success');
    } else {
      await API.post('/expenses', {
        amount, category_id, merchant: merchant || null,
        payment_method,
        is_state_welfare: payment_method === 'ไทยช่วยไทย' ? 1 : 0,
        expense_date: now.toISOString().slice(0, 10),
        expense_time: now.toTimeString().slice(0, 5),
        source: 'manual'
      });
      showToast('บันทึกรายจ่ายแล้ว', 'success');
    }
    closeModal('modalTxn');
    loadDashboard();
  } catch (e) { showToast(e.message, 'error'); }
}

/* ---------------- AI parse ---------------- */
async function parseAiText() {
  const text = document.getElementById('aiTextInput').value.trim();
  if (!text) return;
  try {
    const parsed = await API.post('/ai/parse-text', { text });
    applyParsedExpense(parsed);
  } catch (e) { showToast(e.message, 'error'); }
}

document.getElementById('aiImageInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  showToast('กำลังอ่านสลิป...', 'info');
  try {
    const parsed = await API.post('/ai/parse-image', fd, true);
    applyParsedExpense(parsed);
  } catch (err) { showToast(err.message, 'error'); }
});

function applyParsedExpense(parsed) {
  if (parsed.amount) document.getElementById('expAmount').value = parsed.amount;
  if (parsed.merchant) document.getElementById('expMerchant').value = parsed.merchant;
  if (parsed.category) {
    const match = categories.find(c => c.name === parsed.category);
    if (match) {
      document.getElementById('expCategory').value = match.id;
      selectQuickTag(match.id);
    }
  }
}

/* ---------------- Save income ---------------- */
async function saveIncome() {
  const amount = parseFloat(document.getElementById('incAmount').value);
  if (!amount || amount <= 0) return showToast('กรุณาระบุจำนวนเงิน', 'error');

  const unlockBox = document.getElementById('incomeUnlockBox');
  try {
    if (!unlockBox.classList.contains('hidden')) {
      const password = document.getElementById('unlockPassword').value;
      const { token } = await API.post('/auth/unlock', { password });
      API.setToken(token);
    }
    await API.post('/income', { amount });
    closeModal('modalTxn');
    showToast('บันทึกรายรับแล้ว', 'success');
    loadDashboard();
  } catch (e) { showToast(e.message, 'error'); }
}

/* ---------------- Stats view ---------------- */
document.querySelectorAll('#statsRangeTabs .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#statsRangeTabs .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentStatsRange = btn.dataset.range;
    loadStats(currentStatsRange);
  });
});

async function loadStats(range) {
  try {
    const d = await API.get(`/stats/period/${range}`);
    document.getElementById('statTotal').textContent = fmt(d.total);
    document.getElementById('statTop').textContent = d.topExpense ? fmt(d.topExpense.amount) : fmt(0);

    const list = document.getElementById('statCategoryList');
    list.innerHTML = d.byCategory.length
      ? d.byCategory.map(c => `
        <li class="plain">
          <div class="ledger-main">
            <p class="ledger-title">${c.name}</p>
            <p class="ledger-sub">${c.count} รายการ</p>
          </div>
          <span class="ledger-amt neg mono">-${fmt(c.total)}</span>
        </li>
      `).join('')
      : '<li class="plain empty-note">ยังไม่มีรายจ่ายช่วงนี้</li>';

    // รายรับ vs รายจ่าย — รายรับนับเฉพาะเงินเดือนเดือนปัจจุบัน (บันทึกเป็นรายเดือนเท่านั้น)
    let income = 0;
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (d.to.startsWith(currentMonth) || range === 'month' || range === 'year') {
      try {
        const inc = await API.get('/income/current');
        income = inc.amount || 0;
      } catch { /* ignore */ }
    }
    renderTrendChart(income, d.total);
  } catch (e) { showToast(e.message, 'error'); }
}

function renderTrendChart(income, expense) {
  const ctx = document.getElementById('chartTrend');
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['รายรับ', 'รายจ่าย'],
      datasets: [{
        data: [income, expense],
        backgroundColor: ['#2E6B4D', '#B23A2E'],
        borderRadius: 6,
        barThickness: 48
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { font: { family: 'IBM Plex Mono' } } } }
    }
  });
}

/* ---------------- Settings ---------------- */
async function loadSettings() {
  try {
    const s = await API.get('/settings');
    document.getElementById('setTctLimit').value = s.tct_limit || '';
  } catch { /* ignore if empty */ }
  document.getElementById('setAdminPass').value = '';
}

async function saveAdminPassword() {
  const pass = document.getElementById('setAdminPass').value;
  if (!pass || pass.length < 4) return showToast('รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร', 'error');
  try {
    await API.post('/settings', { admin_pass: pass });
    showToast('เปลี่ยนรหัสผ่านแล้ว', 'success');
    document.getElementById('setAdminPass').value = '';
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveTctLimit() {
  const limit = document.getElementById('setTctLimit').value;
  try {
    await API.post('/settings', { tct_limit: limit });
    showToast('บันทึกวงเงินแล้ว', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

/* ---------------- Init ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

(async function init() {
  await loadCategories();
  await loadDashboard();
})();
