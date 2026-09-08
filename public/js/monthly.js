(() => {
  const esc = (v = '') => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  let selectedMonth = new Date().toISOString().slice(0, 7);
  let monthsCache = [];

  function money(n) {
    return '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
  }
  function monthLabel(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
  }
  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function changeClass(n) { return n > 0.5 ? 'up' : n < -0.5 ? 'down' : 'flat'; }
  function changeText(n) {
    if (Math.abs(n) < 0.5) return 'ใกล้เคียงเดิม';
    return `${n > 0 ? 'เพิ่มขึ้น' : 'ลดลง'} ${Math.abs(n).toFixed(1)}%`;
  }

  function injectStyles() {
    if (document.getElementById('monthlyStyles')) return;
    const style = document.createElement('style');
    style.id = 'monthlyStyles';
    style.textContent = `
      .monthly-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px}
      .monthly-toolbar .field-input{flex:1}
      .month-arrow{width:42px;height:42px;border:1px solid var(--hairline);background:var(--cream-card);border-radius:9px;font-size:18px;color:var(--navy);cursor:pointer}
      .monthly-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .monthly-stat{background:var(--cream);border-radius:10px;padding:12px}
      .monthly-stat .label{font-size:11.5px;color:var(--muted);margin-bottom:4px}
      .monthly-stat .value{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:18px;color:var(--navy)}
      .monthly-stat .value.expense{color:var(--ink-red)}
      .monthly-stat .value.remaining{color:var(--ink-green)}
      .monthly-change{font-size:11.5px;margin-top:3px}
      .monthly-change.up{color:var(--ink-red)}.monthly-change.down{color:var(--ink-green)}.monthly-change.flat{color:var(--muted)}
      .research-box{background:#fff;border:1px solid var(--hairline);border-left:4px solid var(--navy);border-radius:10px;padding:14px;font-size:14px;line-height:1.7}
      .insight-item{padding:11px 12px;border:1px solid var(--hairline);border-radius:10px;margin-bottom:8px}.insight-item:last-child{margin-bottom:0}.insight-title{font-weight:700;font-size:13px}.insight-text{font-size:12px;color:var(--muted);margin-top:3px}.insight-item.warning{border-left:3px solid var(--ink-red)}.insight-item.positive{border-left:3px solid var(--ink-green)}.insight-item.info{border-left:3px solid var(--brass)}
      .forecast-box{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.forecast-stat{background:var(--cream);padding:11px;border-radius:10px}.forecast-stat .label{font-size:11px;color:var(--muted)}.forecast-stat .value{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:16px;margin-top:3px}.forecast-note{font-size:12px;color:var(--muted);margin-top:10px;line-height:1.6}.forecast-scenarios{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}.forecast-scenario{padding:10px;border:1px solid var(--hairline);border-radius:10px}.forecast-scenario .scenario-title{font-size:12px;font-weight:700}.forecast-scenario .scenario-value{font-family:'IBM Plex Mono',monospace;font-weight:700;margin-top:4px}.forecast-scenario .scenario-sub{font-size:11px;color:var(--muted);margin-top:3px}@media(max-width:520px){.forecast-scenarios{grid-template-columns:1fr}}
      .budget-health{padding:9px 0;border-bottom:1px dashed var(--hairline)}.budget-health:last-child{border-bottom:none}.budget-health-top{display:flex;justify-content:space-between;gap:10px;font-size:12.5px}.budget-health-bar{height:7px;background:var(--hairline);border-radius:5px;overflow:hidden;margin-top:5px}.budget-health-bar span{display:block;height:100%;background:var(--brass);border-radius:5px}.budget-health.over .budget-health-bar span{background:var(--ink-red)}
      .metric-row{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px dashed var(--hairline);font-size:13px}
      .metric-row:last-child{border-bottom:none}.metric-row b{font-family:'IBM Plex Mono',monospace}
      .monthly-list{list-style:none;margin:0;padding:0}.monthly-list li{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px dashed var(--hairline)}
      .monthly-list li:last-child{border-bottom:none}.monthly-list .muted{color:var(--muted);font-size:11.5px}
      .monthly-bar{height:8px;background:var(--hairline);border-radius:5px;overflow:hidden;margin-top:5px}.monthly-bar > span{display:block;height:100%;background:var(--brass);border-radius:5px}
      .monthly-actions{display:flex;gap:8px;flex-wrap:wrap}.monthly-actions button{flex:1;min-width:160px}
      .mini-table{width:100%;border-collapse:collapse;font-size:12.5px}.mini-table th,.mini-table td{padding:8px 4px;border-bottom:1px dashed var(--hairline);text-align:right}.mini-table th:first-child,.mini-table td:first-child{text-align:left}
      @media(max-width:520px){.monthly-grid{grid-template-columns:1fr 1fr}.monthly-toolbar{flex-wrap:wrap}.monthly-toolbar .field-input{min-width:180px}}
    `;
    document.head.appendChild(style);
  }

  function buildUI() {
    injectStyles();
    const nav = document.querySelector('.bottomnav');
    if (nav && !nav.querySelector('[data-view="monthly"]')) {
      nav.insertAdjacentHTML('beforeend', `<button class="nav-btn" data-view="monthly"><span class="nav-icon">◫</span><span>รายเดือน</span></button>`);
    }
    if (!document.getElementById('view-monthly')) {
      document.getElementById('app').insertAdjacentHTML('beforeend', `
        <section id="view-monthly" class="view hidden">
          <div class="monthly-toolbar">
            <button id="monthlyPrev" class="month-arrow" aria-label="เดือนก่อน">‹</button>
            <select id="monthlySelect" class="field-input" aria-label="เลือกเดือน"></select>
            <button id="monthlyNext" class="month-arrow" aria-label="เดือนถัดไป">›</button>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title" id="monthlyTitle">วิเคราะห์รายเดือน</p></div>
            <div class="monthly-grid">
              <div class="monthly-stat"><div class="label">รายรับ</div><div id="monthlyIncome" class="value">฿0</div><div id="monthlyIncomeChange" class="monthly-change flat">—</div></div>
              <div class="monthly-stat"><div class="label">รายจ่าย</div><div id="monthlyExpense" class="value expense">฿0</div><div id="monthlyExpenseChange" class="monthly-change flat">—</div></div>
              <div class="monthly-stat"><div class="label">เหลือสุทธิ</div><div id="monthlyRemaining" class="value remaining">฿0</div><div id="monthlyRemainingChange" class="monthly-change flat">—</div></div>
              <div class="monthly-stat"><div class="label">อัตราเงินเหลือ</div><div id="monthlySavingsRate" class="value">—</div><div class="monthly-change flat">เทียบจากรายรับ</div></div>
            </div>
          </div>


          <div class="card health-card">
            <div class="card-head"><p class="card-title">สุขภาพการเงินเดือนนี้</p></div>
            <div id="financialHealth"></div>
          </div>
          <div class="card plan-card">
            <div class="card-head"><p class="card-title">แผนการเงินเดือนนี้</p></div>
            <div id="monthlyPlan"></div>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">วิจัยประจำเดือน</p></div>
            <div id="monthlyResearch" class="research-box">กำลังวิเคราะห์...</div>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">สิ่งที่ควรรู้เดือนนี้</p></div>
            <div id="monthlyInsights"></div>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">พยากรณ์สิ้นเดือน</p></div>
            <div id="monthlyForecast"></div>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">AI Financial Analyst</p></div>
            <div id="monthlyAiAnalysis" class="ai-analysis-card">
              <div class="ai-analysis-empty">กดวิเคราะห์เพื่อให้ AI ช่วยสรุปข้อมูลเดือนนี้</div>
            </div>
            <button id="monthlyAiAnalyze" class="btn-primary" style="margin-top:10px">วิเคราะห์เดือนนี้ด้วย AI</button>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">สถานะงบประมาณ</p></div>
            <div id="monthlyBudgetHealth"></div>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">เป้าหมายการออม</p></div>
            <div class="goal-intro">ตั้งเป้าหมายไว้ก่อน แล้วกด <b>เติมเงิน</b> ทุกครั้งที่กันเงินเข้าจริง ระบบจะสะสมยอดให้เอง</div>
            <div id="monthlyGoals"></div>
            <div class="monthly-goal-form" style="display:grid;grid-template-columns:1.3fr 1fr 1fr auto;gap:8px;margin-top:10px">
              <input id="goalName" class="field-input" placeholder="ชื่อเป้าหมาย เช่น เงินสำรอง">
              <input id="goalTarget" class="field-input" type="number" min="1" step="0.01" placeholder="เป้าหมาย (฿)">
              <input id="goalDate" class="field-input" type="date" aria-label="วันที่เป้าหมาย">
              <button id="goalAdd" class="btn-secondary">เพิ่ม</button>
            </div>
            <p id="goalStatus" class="field-note" style="margin-bottom:0"></p>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">พฤติกรรมการใช้เงิน</p></div>
            <div id="monthlyMetrics"></div>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">ค่าใช้จ่ายตามหมวด</p></div>
            <div id="monthlyCategories"></div>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">ร้านค้า / ผู้รับเงินที่มียอดสูงสุด</p></div>
            <ul id="monthlyMerchants" class="monthly-list"></ul>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">แนวโน้ม 12 เดือน</p></div>
            <div id="monthlyOverview"></div>
          </div>

          <div class="card">
            <div class="card-head"><p class="card-title">เก็บข้อมูล Gmail ของเดือนนี้</p></div>
            <p class="field-note" style="margin-top:0">ใช้สำหรับดึงอีเมลธุรกรรมของเดือนที่เลือกโดยตรง ระบบกันรายการซ้ำด้วย Gmail ID</p>
            <div class="monthly-actions">
              <button id="monthlyGmailSync" class="btn-primary">สแกนและบันทึก Gmail เดือนนี้</button>
              <button id="monthlyDashboardBtn" class="btn-secondary">กลับหน้าหลัก</button>
            </div>
            <p id="monthlyGmailStatus" class="field-note"></p>
          </div>
        </section>`);
    }
    nav?.querySelector('[data-view="monthly"]')?.addEventListener('click', () => {
      switchToMonthly();
    });
    document.getElementById('monthlyPrev')?.addEventListener('click', () => {
      selectedMonth = shiftMonth(selectedMonth, -1); renderMonthly();
    });
    document.getElementById('monthlyNext')?.addEventListener('click', () => {
      const next = shiftMonth(selectedMonth, 1);
      const current = new Date().toISOString().slice(0,7);
      if (next <= current) { selectedMonth = next; renderMonthly(); }
    });
    document.getElementById('monthlySelect')?.addEventListener('change', e => {
      selectedMonth = e.target.value; renderMonthly();
    });
    document.getElementById('monthlyGmailSync')?.addEventListener('click', syncGmailMonth);
    document.getElementById('monthlyDashboardBtn')?.addEventListener('click', () => switchView('dashboard'));
    document.getElementById('goalAdd')?.addEventListener('click', addGoal);
    document.getElementById('monthlyAiAnalyze')?.addEventListener('click', runAiMonthlyAnalysis);
    populateMonthSelect();
  }

  function populateMonthSelect() {
    const el = document.getElementById('monthlySelect');
    if (!el || el.options.length) return;
    const now = new Date();
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      el.insertAdjacentHTML('beforeend', `<option value="${value}">${esc(monthLabel(value))}</option>`);
    }
    el.value = selectedMonth;
  }

  function switchToMonthly() {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById('view-monthly').classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'monthly'));
    renderMonthly();
  }

  async function renderMonthly() {
    populateMonthSelect();
    const select = document.getElementById('monthlySelect');
    if (select) select.value = selectedMonth;
    try {
      const d = await API.get(`/monthly/month/${selectedMonth}`);
      document.getElementById('monthlyTitle').textContent = `วิเคราะห์ ${d.monthLabel}`;
      document.getElementById('monthlyIncome').textContent = money(d.income);
      document.getElementById('monthlyExpense').textContent = money(d.expense);
      document.getElementById('monthlyRemaining').textContent = money(d.remaining);
      document.getElementById('monthlySavingsRate').textContent = d.savingsRate == null ? '—' : `${d.savingsRate.toFixed(1)}%`;
      setChange('monthlyIncomeChange', d.changes.incomePct, 'รายรับ');
      setChange('monthlyExpenseChange', d.changes.expensePct, 'รายจ่าย');
      setChange('monthlyRemainingChange', d.changes.remainingPct, 'คงเหลือ');
      document.getElementById('monthlyResearch').textContent = d.research;
      renderHealth(d.financialHealth);
      renderMonthlyPlan(d.monthlyPlan);
      renderForecast(d);
      renderBudgetHealth(d.budgetIntelligence);
      renderGoals(d);
      const insights = d.insights || [];
      document.getElementById('monthlyInsights').innerHTML = insights.length
        ? insights.map(x => `<div class="insight-item ${esc(x.type)}"><div class="insight-title">${esc(x.title)}</div><div class="insight-text">${esc(x.text)}</div></div>`).join('')
        : '<p class="empty-note">ยังไม่มีข้อมูลเพียงพอสำหรับสร้าง insight</p>';
      document.getElementById('monthlyMetrics').innerHTML = [
        ['จำนวนธุรกรรม', `${d.transactionCount.toLocaleString('th-TH')} รายการ`],
        ['วันที่มีการใช้จ่าย', `${d.activeDays.toLocaleString('th-TH')} วัน`],
        ['เฉลี่ยต่อวันที่มีรายการ', money(d.avgPerDay)],
        ['เฉลี่ยต่อวันตามปฏิทิน', money(d.avgPerCalendarDay)],
        ['เดือนก่อน', `${monthLabel(d.previous.month)} · รายจ่าย ${money(d.previous.expense)}`]
      ].map(([a,b]) => `<div class="metric-row"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('');
      renderCategories(d.categories);
      renderMerchants(d.merchants);
      renderOverview();
    } catch (e) {
      document.getElementById('monthlyResearch').textContent = e.message;
    }
  }

  async function runAiMonthlyAnalysis() {
    const box = document.getElementById('monthlyAiAnalysis');
    const btn = document.getElementById('monthlyAiAnalyze');
    if (!box || !btn) return;
    btn.disabled = true;
    box.textContent = 'กำลังให้ AI วิเคราะห์ข้อมูลเดือนนี้...';
    try {
      const res = await fetch(`/api/ai/analysis?month=${encodeURIComponent(selectedMonth)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI วิเคราะห์ไม่สำเร็จ');
      renderAiAnalysis(data.summary || 'ยังไม่มีผลวิเคราะห์');
    } catch (e) {
      box.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }


  function renderHealth(data) {
    const box=document.getElementById('financialHealth'); if(!box||!data)return;
    const score=Number(data.score||0); const cls=score>=65?'good':score>=50?'mid':'bad';
    const factors=(data.factors||[]).map(x=>`<span><b>${esc(x.label)}</b> ${esc(x.value)}</span>`).join('');
    box.innerHTML=`<div class="health-score-row"><div class="health-score ${cls}">${score}</div><div><div class="health-level">${esc(data.level)}</div><div class="forecast-note">คะแนนจากเงินเหลือ แนวโน้มรายจ่าย หมวดหลัก และงบประมาณ</div></div></div><div class="health-factors">${factors}</div>${data.budgetOverCount?`<div class="health-warning">มีงบประมาณเกิน ${data.budgetOverCount} หมวด ควรชะลอรายจ่ายในหมวดที่เกิน</div>`:''}`;
  }
  function renderMonthlyPlan(data) {
    const box=document.getElementById('monthlyPlan'); if(!box||!data)return;
    const actions=(data.actions||[]).map((x,i)=>`<div><span class="plan-num">${i+1}</span><p>${esc(x)}</p></div>`).join('');
    box.innerHTML=`<div class="plan-stats"><div><span>เป้าหมายใช้/วัน</span><b>${money(data.dailySpendTarget)}</b></div><div><span>คาดว่ารายจ่ายสิ้นเดือน</span><b>${money(data.projectedExpense)}</b></div><div><span>คาดว่าเหลือ</span><b>${money(data.projectedRemaining)}</b></div></div><div class="plan-actions">${actions}</div>`;
  }

  function renderForecast(d) {
    const box = document.getElementById('monthlyForecast');
    const f = d.budgetIntelligence?.forecast;
    if (!box || !f) return;
    if (d.month !== new Date().toISOString().slice(0,7)) {
      box.innerHTML = `<div class="forecast-box"><div class="forecast-stat"><div class="label">ยอดจริง</div><div class="value">${money(d.expense)}</div></div><div class="forecast-stat"><div class="label">เหลือสุทธิ</div><div class="value">${money(d.remaining)}</div></div><div class="forecast-stat"><div class="label">สถานะ</div><div class="value">ปิดเดือน</div></div></div><p class="forecast-note">เดือนที่ปิดแล้วใช้ยอดจริง ไม่คาดการณ์เพิ่ม</p>`;
      return;
    }
    box.innerHTML = `<div class="forecast-box"><div class="forecast-stat"><div class="label">ใช้ไปแล้ว</div><div class="value">${money(f.currentExpense)}</div></div><div class="forecast-stat"><div class="label">เหลืออีก</div><div class="value">${money(f.remainingDays)} วัน</div></div><div class="forecast-stat"><div class="label">Safe Spend / วัน</div><div class="value">${money(f.safeSpendDaily)}</div></div></div>
      <div class="forecast-scenarios"><div class="forecast-scenario"><div class="scenario-title">ประหยัด</div><div class="scenario-value">${money(f.bestExpense)}</div><div class="scenario-sub">เหลือ ${money(f.bestRemaining)}</div></div><div class="forecast-scenario"><div class="scenario-title">คาดการณ์</div><div class="scenario-value">${money(f.expectedExpense)}</div><div class="scenario-sub">เหลือ ${money(f.expectedRemaining)}</div></div><div class="forecast-scenario"><div class="scenario-title">ใช้สูง</div><div class="scenario-value">${money(f.worstExpense)}</div><div class="scenario-sub">เหลือ ${money(f.worstRemaining)}</div></div></div>
      <p class="forecast-note">ความมั่นใจ: ${esc(f.confidence)} · กันเงินสำรอง 10% ของรายรับ · ใช้ข้อมูล ${f.elapsedDays} วันที่ผ่านมา</p>`;
  }

  function renderBudgetHealth(data) {
    const box = document.getElementById('monthlyBudgetHealth');
    if (!box) return;
    const rows = data?.budgets || [];
    if (!rows.length) {
      box.innerHTML = '<p class="empty-note">ยังไม่ได้ตั้งงบประมาณรายหมวด</p>';
      return;
    }
    box.innerHTML = rows.map(r => {
      const pct = Math.min(Math.max(r.usedPct, 0), 100);
      const over = r.usedPct > 100;
      const width = Math.min(r.usedPct, 100);
      const status = over ? `เกิน ${money(Math.abs(r.remaining))}` : `เหลือ ${money(r.remaining)}`;
      return `<div class="budget-health ${over ? 'over' : ''}">
        <div class="budget-health-top"><span>${esc(r.categoryName)}</span><span>${money(r.spent)} / ${money(r.limit)}</span></div>
        <div class="budget-health-bar"><span style="width:${width.toFixed(0)}%"></span></div>
        <div class="forecast-note" style="margin-top:3px">${status} · ${pct.toFixed(0)}%</div>
      </div>`;
    }).join('');
  }

  async function addGoal() {
    const name = document.getElementById('goalName')?.value.trim();
    const target = Number(document.getElementById('goalTarget')?.value || 0);
    const targetDate = document.getElementById('goalDate')?.value || null;
    const status = document.getElementById('goalStatus');
    if (!name || target <= 0) {
      if (status) status.textContent = 'กรุณาระบุชื่อเป้าหมายและจำนวนเงิน';
      return;
    }
    try {
      await API.post('/goals', { name, target_amount: target, target_date: targetDate });
      document.getElementById('goalName').value = '';
      document.getElementById('goalTarget').value = '';
      document.getElementById('goalDate').value = '';
      if (status) status.textContent = 'เพิ่มเป้าหมายแล้ว';
      await renderGoals();
    } catch (e) {
      if (status) status.textContent = e.message;
    }
  }

  async function renderGoals(d) {
    const box = document.getElementById('monthlyGoals');
    if (!box) return;
    try {
      const goals = await API.get('/goals');
      if (!goals.length) {
        box.innerHTML = '<p class="empty-note">ยังไม่มีเป้าหมายการออม</p>';
        return;
      }
      box.innerHTML = goals.slice(0, 5).map(g => {
        const target = Number(g.target_amount || 0);
        const current = Number(g.current_amount || 0);
        const remaining = Math.max(0, target - current);
        const pct = target > 0 ? Math.min(current / target * 100, 100) : 0;
        let plan = '';
        if (g.target_date && remaining > 0) {
          const today = new Date();
          const due = new Date(g.target_date + 'T00:00:00');
          const months = Math.max(1, (due.getFullYear() - today.getFullYear()) * 12 + due.getMonth() - today.getMonth() + 1);
          plan = `ควรออมประมาณ ${money(remaining / months)} บาท/เดือน · เป้าหมาย ${esc(new Date(g.target_date + 'T00:00:00').toLocaleDateString('th-TH'))}`;
        }
        const done = pct >= 100;
        return `<div class="goal-card">
          <div class="goal-card-head"><div><div class="goal-card-name">${esc(g.name)}</div><div class="goal-card-meta">${done ? 'บรรลุเป้าหมายแล้ว' : `เหลือ ${money(remaining)}`}</div></div><div class="goal-card-percent">${pct.toFixed(0)}%</div></div>
          <div class="goal-card-bar"><span style="width:${pct.toFixed(0)}%"></span></div>
          <div class="goal-card-values"><span>${money(current)} / ${money(target)}</span><button type="button" class="btn-secondary goal-add-btn" data-goal-id="${g.id}" ${done ? 'disabled' : ''}>เติมเงิน</button></div>
          ${plan ? `<div class="goal-card-plan">${esc(plan)}</div>` : ''}
          <div class="goal-card-add hidden" id="goalAddBox${g.id}"><input class="field-input goal-add-input" id="goalAddInput${g.id}" type="number" min="0.01" step="0.01" placeholder="จำนวนเงินที่ออม"><button type="button" class="btn-primary goal-save-add" data-goal-id="${g.id}" style="margin-top:8px">ยืนยันการออม</button></div>
        </div>`;
      }).join('');
      box.querySelectorAll('.goal-add-btn').forEach(btn => btn.addEventListener('click', () => {
        document.getElementById(`goalAddBox${btn.dataset.goalId}`)?.classList.toggle('hidden');
      }));
      box.querySelectorAll('.goal-save-add').forEach(btn => btn.addEventListener('click', () => addGoalMoney(btn.dataset.goalId)));
    } catch (e) {
      box.innerHTML = `<p class="empty-note">${esc(e.message)}</p>`;
    }
  }

  async function addGoalMoney(goalId) {
    const input = document.getElementById(`goalAddInput${goalId}`);
    const amount = Number(input?.value || 0);
    const status = document.getElementById('goalStatus');
    if (amount <= 0) {
      if (status) status.textContent = 'กรุณาระบุจำนวนเงินที่ออม';
      return;
    }
    try {
      await API.put(`/goals/${goalId}/add`, { amount });
      if (status) status.textContent = `บันทึกเงินออม ${money(amount)} แล้ว`;
      await renderGoals();
    } catch (e) {
      if (status) status.textContent = e.message;
    }
  }

  function renderAiAnalysis(text) {
    const box = document.getElementById('monthlyAiAnalysis');
    if (!box) return;
    const value = String(text || '').replace(/\r/g, '').trim();
    const headings = ['ภาพรวม','แนวโน้ม 6 เดือน','จุดที่ควรระวัง','งบประมาณ','เป้าหมายการออม','แผนที่แนะนำ'];
    const parts = value.split(/\n(?=(?:ภาพรวม|แนวโน้ม 6 เดือน|จุดที่ควรระวัง|งบประมาณ|เป้าหมายการออม|แผนที่แนะนำ)\s*\n?)/g);
    const html = [];
    for (const part of parts) {
      const lines = part.split('\n').map(x => x.trim()).filter(Boolean);
      if (!lines.length) continue;
      const title = lines.shift();
      if (!headings.includes(title)) {
        html.push(`<p class="ai-analysis-text">${esc(lines.length ? [title, ...lines].join('\n') : title).replace(/\n/g,'<br>')}</p>`);
        continue;
      }
      const body = lines.map(line => {
        const clean = line.replace(/^(?:[-•*]|\d+[.)])\s*/, '');
        return `<div class="ai-analysis-line">${esc(clean)}</div>`;
      }).join('');
      html.push(`<section class="ai-analysis-section"><h3>${esc(title)}</h3>${body || '<div class="ai-analysis-line muted">ไม่มีข้อมูล</div>'}</section>`);
    }
    box.innerHTML = html.join('') || '<div class="ai-analysis-empty">ยังไม่มีผลวิเคราะห์</div>';
  }

  function setChange(id, value, label) {
    const el = document.getElementById(id);
    el.className = `monthly-change ${changeClass(value)}`;
    el.textContent = `${label}: ${changeText(value)} จากเดือนก่อน`;
  }

  function renderCategories(rows) {
    const box = document.getElementById('monthlyCategories');
    if (!rows.length) { box.innerHTML = '<p class="empty-note">ยังไม่มีรายจ่ายในเดือนนี้</p>'; return; }
    const max = Math.max(...rows.map(r => r.total), 1);
    box.innerHTML = rows.map(r => `<div class="metric-row"><div style="flex:1"><div>${esc(r.name)} <span class="muted">(${r.count} รายการ · ${r.share.toFixed(1)}%)</span></div><div class="monthly-bar"><span style="width:${Math.max(2, r.total/max*100).toFixed(0)}%"></span></div></div><b>${money(r.total)}</b></div>`).join('');
  }

  function renderMerchants(rows) {
    const ul = document.getElementById('monthlyMerchants');
    ul.innerHTML = rows.length ? rows.slice(0, 8).map((r,i) => `<li><div><strong>${i+1}. ${esc(r.name)}</strong><div class="muted">${r.count} รายการ</div></div><strong class="mono">${money(r.total)}</strong></li>`).join('') : '<li class="empty-note">ยังไม่มีข้อมูล</li>';
  }

  async function renderOverview() {
    try {
      const d = await API.get('/monthly/overview/list?limit=12');
      monthsCache = d.months || [];
      const rows = [...monthsCache].sort((a,b) => a.month.localeCompare(b.month));
      if (!rows.length) { document.getElementById('monthlyOverview').innerHTML = '<p class="empty-note">ยังไม่มีข้อมูลเพียงพอ</p>'; return; }
      const max = Math.max(...rows.map(r => Math.max(r.income, r.expense)), 1);
      document.getElementById('monthlyOverview').innerHTML = `<table class="mini-table"><thead><tr><th>เดือน</th><th>รายรับ</th><th>รายจ่าย</th><th>เหลือ</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(monthLabel(r.month))}</td><td>${money(r.income)}</td><td>${money(r.expense)}</td><td>${money(r.remaining)}</td></tr>`).join('')}</tbody></table><div style="margin-top:12px">${rows.map(r => `<div style="margin-bottom:8px;font-size:11.5px"><div style="display:flex;justify-content:space-between"><span>${esc(monthLabel(r.month))}</span><span class="mono">${money(r.expense)}</span></div><div class="monthly-bar"><span style="width:${(r.expense/max*100).toFixed(0)}%"></span></div></div>`).join('')}</div>`;
    } catch (e) { document.getElementById('monthlyOverview').innerHTML = `<p class="empty-note">${esc(e.message)}</p>`; }
  }

  async function syncGmailMonth() {
    const status = document.getElementById('monthlyGmailStatus');
    const btn = document.getElementById('monthlyGmailSync');
    btn.disabled = true;
    status.textContent = 'กำลังตรวจสอบ Gmail...';
    try {
      const sRes = await fetch('/api/gmail/status');
      const s = await sRes.json();
      if (!s.connected) throw new Error('ยังไม่ได้เชื่อมต่อ Gmail');
      const [y,m] = selectedMonth.split('-').map(Number);
      const from = `${selectedMonth}-01`;
      const next = new Date(y, m, 1);
      const to = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-01`;
      const res = await fetch(`/api/gmail/messages?from=${from}&to=${to}&limit=100`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gmail scan failed');
      let saved=0, duplicate=0, review=0;
      for (const candidate of data.messages || []) {
        if (candidate.confidence !== 'high') { review++; continue; }
        const r = await fetch('/api/gmail/import', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({candidate}) });
        if (r.ok) saved++;
        else if (r.status === 409) duplicate++;
        else review++;
      }
      status.textContent = `ตรวจ ${data.scanned || 0} อีเมล · บันทึกใหม่ ${saved} · ซ้ำ ${duplicate} · ต้องตรวจสอบ ${review}`;
      await renderMonthly();
      if (typeof loadDashboard === 'function') loadDashboard();
    } catch (e) {
      status.textContent = e.message;
    } finally { btn.disabled = false; }
  }

  document.addEventListener('DOMContentLoaded', buildUI);
})();
