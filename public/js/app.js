let categories = [];
let trendChart = null;
let currentTxnTab = 'expense';
let currentStatsRange = 'month';
let currentPayment = 'โอน';
let editingExpenseId = null;
let editingExpenseDate = null;
let editingExpenseTime = null;

function fmt(n) {
  const num = Number(n || 0);
  const sign = num < 0 ? '-' : '';
  return sign + '฿' + Math.abs(num).toLocaleString('th-TH', { maximumFractionDigits: 0 });
}
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function firstOfMonth() {
  return localDateStr().slice(0, 7) + '-01';
}
function todayStr() {
  return localDateStr();
}

/* ---------------- Navigation ---------------- */
function switchView(view) {
  if (view === 'gmail' && typeof window.openGmail === 'function') { window.openGmail(); return; }
  if (view === 'monthly' && typeof window.openMonthly === 'function') { window.openMonthly(); return; }
  if (view === 'gmail-audit' && typeof window.openGmailAudit === 'function') { window.openGmailAudit(); return; }
  const target = document.getElementById(`view-${view}`);
  if (!target) return;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  target.classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'dashboard') loadDashboard();
  if (view === 'stats') loadStats(currentStatsRange);
  if (view === 'settings') loadSettings();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
const latestBoxBtn = document.getElementById('latestBoxBtn');
const latestBoxPanel = document.getElementById('latestBoxPanel');
const latestBoxClose = document.getElementById('latestBoxClose');
latestBoxBtn?.addEventListener('click', event => { event.stopPropagation(); if (latestBoxPanel?.classList.contains('hidden')) { latestBoxPanel.classList.remove('hidden'); latestBoxBtn.setAttribute('aria-expanded', 'true'); } else closeLatestBox(); });
latestBoxClose?.addEventListener('click', closeLatestBox);
latestBoxPanel?.addEventListener('click', event => event.stopPropagation());
document.addEventListener('click', event => { if (!event.target.closest('#latestBoxPanel') && !event.target.closest('#latestBoxBtn')) closeLatestBox(); });

/* ---------------- Dashboard ---------------- */
async function loadDashboard() {
  try {
    const d = await API.get('/stats/dashboard');
    document.getElementById('dashRemaining').textContent = fmt(d.remaining);
    document.getElementById('dashSalary').textContent = fmt(d.salary);
    document.getElementById('dashIncome').textContent = fmt(d.salary);
    document.getElementById('dashExpense').textContent = fmt(d.totalExpense);
    document.getElementById('dashRemainStat').textContent = fmt(d.remaining);
    document.getElementById('dashSavingsPct').textContent = d.salary > 0 ? (Math.max(0, d.remaining) / d.salary * 100).toFixed(0) + '%' : '0%';
    document.getElementById('dashUsedPct').textContent = `ใช้ไป ${d.usedPct}%`;
    document.getElementById('dashUsedBar').style.width = Math.min(Math.max(d.usedPct, 0), 100) + '%';
    document.getElementById('dashDailyBudget').textContent = fmt(d.dailyBudget);

    renderCategoryBars(d.byCategory);
    renderLatestBox(d.recent || []);
    loadBudgetWidget();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function renderCategoryBars(data) {
  const wrap = document.getElementById('categoryBars');
  const totalEl = document.getElementById('categoryTotal');
  const total = data.reduce((sum, category) => sum + Number(category.total || 0), 0);
  if (totalEl) totalEl.textContent = fmt(total);
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

function renderLatestBox(items) {
  const titleEl=document.getElementById('latestBoxTitle');
  const amountEl=document.getElementById('latestBoxAmount');
  const listEl=document.getElementById('latestBoxList');
  if(!titleEl||!amountEl||!listEl)return;
  const latest=items[0];
  titleEl.textContent=latest?(latest.merchant||latest.category_name||'ไม่ระบุ'):'ยังไม่มีรายการ';
  amountEl.textContent=latest?'-'+fmt(latest.amount):'—';
  if(!items.length){listEl.innerHTML='<div class="latest-empty">ยังไม่มีรายการรายจ่าย</div>';return;}
  listEl.innerHTML=items.slice(0,8).map(e =>
    '<div class="latest-item"><div class="latest-item-main">' +
    '<span class="latest-item-title">'+escHtml(e.merchant||e.category_name||'ไม่ระบุ')+'</span>' +
    '<span class="latest-item-meta">'+escHtml(e.category_name||'ไม่ระบุ')+' · '+escHtml(e.expense_date||'')+(e.expense_time?' · '+escHtml(e.expense_time):'')+'</span></div>' +
    '<div class="latest-item-right"><span class="latest-item-amount">-'+fmt(e.amount)+'</span>' +
    '<span class="latest-item-actions"><button type="button" class="latest-edit" onclick="openEditExpense('+e.id+'); closeLatestBox();">แก้ไข</button>' +
    '<button type="button" class="latest-delete" onclick="deleteExpense('+e.id+')">ลบ</button></span></div></div>'
  ).join('');
}
function escHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function closeLatestBox(){document.getElementById('latestBoxPanel')?.classList.add('hidden');document.getElementById('latestBoxBtn')?.setAttribute('aria-expanded','false');}

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
    editingExpenseDate = row.expense_date || null;
    editingExpenseTime = row.expense_time || null;
    openTxnModal('expense');
    document.getElementById('expAmount').value = row.amount;
    document.getElementById('expCategory').value = row.category_name || '';
    document.querySelectorAll('#quickCategoryTags .tag-btn').forEach(b => b.classList.remove('active'));
    openCategoryMenu();
    const editCategory = categories.find(c => c.name === row.category_name);
    if (editCategory) selectQuickTag(editCategory.id);
    document.getElementById('expMerchant').value = row.merchant || '';
    selectPayment(row.payment_method === 'โอน' ? 'โอน' : 'เงินสด');
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
  const list = document.getElementById('categoryMenu');
  if (list) renderCategoryMenu('');

  const quickNames = ['ค่ากิน', 'ค่าน้ำมัน', 'ค่าห้อง', 'ค่าเน็ต'];
  const quickWrap = document.getElementById('quickCategoryTags');
  quickWrap.innerHTML = categories
    .filter(c => quickNames.includes(c.name))
    .map(c => `<button type="button" class="tag-btn" data-id="${c.id}" onclick="selectQuickTag(${c.id})">${c.name}</button>`)
    .join('');
}

function selectQuickTag(categoryId) {
  const category = categories.find(c => Number(c.id) === Number(categoryId));
  if (!category) return;
  document.getElementById('expCategory').value = category.name;
  document.querySelectorAll('#quickCategoryTags .tag-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.id) === Number(categoryId));
  });
}

async function resolveCategoryId(name) {
  const categoryName = String(name || '').trim();
  if (!categoryName) return null;
  const existing = categories.find(c => c.name.trim().toLowerCase() === categoryName.toLowerCase());
  if (existing) return Number(existing.id);

  const created = await API.post('/categories', { name: categoryName });
  const category = { id: Number(created.id), name: created.name };
  categories.push(category);

  return category.id;
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
  editingExpenseDate = null;
  editingExpenseTime = null;
}

function switchTxnTab(tab) {
  currentTxnTab = tab;
  document.getElementById('tabExpense').classList.toggle('active', tab === 'expense');
  document.getElementById('tabIncome').classList.toggle('active', tab === 'income');
  document.getElementById('formExpense').classList.toggle('hidden', tab !== 'expense');
  document.getElementById('formIncome').classList.toggle('hidden', tab !== 'income');

  if (tab === 'expense') {
    document.getElementById('expAmount').value = '';
    document.getElementById('expMerchant').value = '';
    document.getElementById('expCategory').value = '';
    document.querySelectorAll('#quickCategoryTags .tag-btn').forEach(b => b.classList.remove('active'));
    if (!editingExpenseId) {
      selectPayment('โอน');
      document.querySelector('#formExpense .btn-primary').textContent = 'บันทึกรายจ่าย';
    }
  } else {
    prefillIncome();
  }
}

async function prefillIncome() {
  try {
    const current = await API.get('/income/current');
    const salary = (current.entries || []).find(e => e.type === 'salary');
    const type = document.getElementById('incType').value;
    document.getElementById('incomeUnlockBox').classList.toggle('hidden', type !== 'salary' || !salary?.locked);
    document.getElementById('incAmount').value = type === 'salary' ? (salary?.amount || '') : '';
    document.getElementById('incTitle').value = type === 'salary' ? (salary?.title || 'เงินเดือนหลัก') : '';
    document.getElementById('incDate').value = type === 'salary' ? (salary?.income_date || todayStr()) : todayStr();
    renderIncomeEntries(current.entries || []);
  } catch { /* ignore */ }
}

function renderIncomeEntries(entries) {
  const wrap = document.getElementById('incomeEntryList');
  if (!wrap) return;
  const labels = { salary:'เงินเดือนหลัก', side:'รายได้เสริม', freelance:'ฟรีแลนซ์', bonus:'โบนัส', refund:'เงินคืน', other:'รายรับอื่นๆ' };
  wrap.innerHTML = entries.length ? entries.map(e => `
    <div class="income-entry-row">
      <div><b>${e.title || labels[e.type] || 'รายรับ'}</b><small>${e.income_date} · ${labels[e.type] || 'รายรับอื่นๆ'}</small></div>
      <strong class="mono pos">+${fmt(e.amount)}</strong>
      ${e.locked ? '<span class="income-lock">ล็อก</span>' : `<button type="button" class="income-delete" onclick="deleteIncome(${e.id})">ลบ</button>`}
    </div>`).join('') : '<p class="empty-note">ยังไม่มีรายรับเพิ่มเติมในเดือนนี้</p>';
}

/* ---------------- Save expense ---------------- */
async function saveExpense() {
  const amount = parseFloat(document.getElementById('expAmount').value);
  const categoryName = document.getElementById('expCategory').value.trim();
  const merchant = document.getElementById('expMerchant').value.trim();
  const payment_method = currentPayment;
  if (!amount || amount <= 0) return showToast('กรุณาระบุจำนวนเงิน', 'error');
  if (!categoryName) return showToast('กรุณาเลือกหรือพิมพ์หมวดหมู่', 'error');

  const now = new Date();
  try {
    const category_id = await resolveCategoryId(categoryName);
    if (editingExpenseId) {
      await API.put(`/expenses/${editingExpenseId}`, {
        amount, category_id, merchant: merchant || null,
        payment_method,
        expense_date: editingExpenseDate || localDateStr(now),
        expense_time: editingExpenseTime || now.toTimeString().slice(0, 5)
      });
      showToast('แก้ไขรายการแล้ว', 'success');
    } else {
      const result = await API.post('/expenses', {
        amount, category_id, merchant: merchant || null,
        payment_method,
        expense_date: localDateStr(now),
        expense_time: now.toTimeString().slice(0, 5),
        source: 'manual'
      });
      showToast(
        result?.duplicate ? 'พบรายการเดิมแล้ว ไม่ได้สร้างรายการซ้ำ' : 'บันทึกรายจ่ายแล้ว',
        result?.duplicate ? 'error' : 'success'
      );
    }
    closeModal('modalTxn');
    loadDashboard();
  } catch (e) { showToast(e.message, 'error'); }
}

/* ---------------- Save income ---------------- */
async function saveIncome() {
  const amount = parseFloat(document.getElementById('incAmount').value);
  const type = document.getElementById('incType').value;
  const title = document.getElementById('incTitle').value.trim();
  const income_date = document.getElementById('incDate').value || todayStr();
  if (!amount || amount <= 0) return showToast('กรุณาระบุจำนวนเงิน', 'error');
  if (!title) return showToast('กรุณาระบุชื่อรายการ', 'error');

  const unlockBox = document.getElementById('incomeUnlockBox');
  try {
    if (type === 'salary' && !unlockBox.classList.contains('hidden')) {
      const password = document.getElementById('unlockPassword').value;
      const { token } = await API.post('/auth/unlock', { password });
      API.setToken(token);
    }
    await API.post('/income', { amount, type, title, income_date });
    showToast('บันทึกรายรับแล้ว', 'success');
    await prefillIncome();
    loadDashboard();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteIncome(id) {
  if (!confirm('ลบรายรับรายการนี้?')) return;
  try {
    await API.del(`/income/${id}`);
    showToast('ลบรายรับแล้ว', 'success');
    await prefillIncome();
    loadDashboard();
  } catch (e) { showToast(e.message, 'error'); }
}

document.getElementById('incType')?.addEventListener('change', prefillIncome);

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

/* ---------------- Init ---------------- */
(async function init() {
  await loadCategories();
  initCategoryPicker();
  await loadDashboard();
})();


/* ---------------- Custom category dropdown ---------------- */
function closeCategoryMenu() {
  const menu = document.getElementById('categoryMenu');
  const input = document.getElementById('expCategory');
  const toggle = document.getElementById('categoryToggle');
  if (!menu) return;
  menu.classList.add('hidden');
  input?.setAttribute('aria-expanded', 'false');
  toggle?.setAttribute('aria-expanded', 'false');
}

function openCategoryMenu() {
  renderCategoryMenu(document.getElementById('expCategory')?.value || '');
  document.getElementById('categoryMenu')?.classList.remove('hidden');
  document.getElementById('expCategory')?.setAttribute('aria-expanded', 'true');
  document.getElementById('categoryToggle')?.setAttribute('aria-expanded', 'true');
}

function renderCategoryMenu(query = '') {
  const menu = document.getElementById('categoryMenu');
  if (!menu) return;
  const q = String(query).trim().toLowerCase();
  const filtered = categories.filter(c => c.name.toLowerCase().includes(q));
  menu.innerHTML = '';

  filtered.forEach(category => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'category-option';
    item.setAttribute('role', 'option');
    item.textContent = category.name;
    item.addEventListener('mousedown', e => e.preventDefault());
    item.addEventListener('click', () => selectCategory(category));
    menu.appendChild(item);
  });

  const exact = categories.some(c => c.name.trim().toLowerCase() === q && q);
  if (q && !exact) {
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'category-option category-create';
    create.setAttribute('role', 'option');
    create.textContent = `เพิ่มหมวด “${String(query).trim()}”`;
    create.addEventListener('mousedown', e => e.preventDefault());
    create.addEventListener('click', () => {
      document.getElementById('expCategory').value = String(query).trim();
      document.querySelectorAll('#quickCategoryTags .tag-btn').forEach(b => b.classList.remove('active'));
      closeCategoryMenu();
      document.getElementById('expCategory').focus();
    });
    menu.appendChild(create);
  }

  if (!menu.children.length) {
    const empty = document.createElement('div');
    empty.className = 'category-empty';
    empty.textContent = 'ไม่พบหมวดหมู่นี้';
    menu.appendChild(empty);
  }
}

function selectCategory(category) {
  document.getElementById('expCategory').value = category.name;
  document.querySelectorAll('#quickCategoryTags .tag-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.id) === Number(category.id));
  });
  closeCategoryMenu();
}

function initCategoryPicker() {
  const input = document.getElementById('expCategory');
  const toggle = document.getElementById('categoryToggle');
  const picker = document.getElementById('categoryPicker');
  if (!input || !toggle || !picker) return;
  toggle.addEventListener('click', () => {
    const menu = document.getElementById('categoryMenu');
    menu.classList.contains('hidden') ? openCategoryMenu() : closeCategoryMenu();
  });
  input.addEventListener('focus', openCategoryMenu);
  input.addEventListener('input', () => renderCategoryMenu(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCategoryMenu();
    if (e.key === 'ArrowDown') { e.preventDefault(); openCategoryMenu(); }
  });
  document.addEventListener('click', e => {
    if (!picker.contains(e.target)) closeCategoryMenu();
  });
}
