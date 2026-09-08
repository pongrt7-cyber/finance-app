const express = require('express');
const db = require('../db');
const { currentMonth, todayParts } = require('../utils/date');
const router = express.Router();

function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
}

function money(n) {
  return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
}

function pctChange(current, previous) {
  if (!previous) return current ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function buildBudgetIntelligence(data) {
  const { income, expense, month } = data;
  const rows = db.prepare(`
    SELECT b.category_id, c.name AS category_name, b.monthly_limit,
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.category_id=b.category_id AND e.expense_date LIKE ?),0) AS spent
    FROM budgets b JOIN categories c ON c.id=b.category_id ORDER BY c.name ASC
  `).all(`${month}%`);
  const budgets = rows.map(r => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
    limit: Number(r.monthly_limit || 0),
    spent: Number(r.spent || 0),
    remaining: Number(r.monthly_limit || 0) - Number(r.spent || 0),
    usedPct: Number(r.monthly_limit || 0) > 0 ? Number(r.spent || 0) / Number(r.monthly_limit || 0) * 100 : 0
  }));
  const [year, mon] = month.split('-').map(Number);
  const days = new Date(year, mon, 0).getDate();
  const today = todayParts();
  const elapsed = currentMonth() === month ? Math.min(today.day, days) : days;
  const projectedExpense = elapsed > 0 ? expense / elapsed * days : expense;
  const projectedRemaining = income - projectedExpense;
  const recent = db.prepare(`SELECT substr(expense_date,1,7) AS month, SUM(amount) AS total
    FROM expenses GROUP BY month ORDER BY month DESC LIMIT 6`).all();
  const avgRecentExpense = recent.length ? recent.reduce((s,r)=>s+Number(r.total||0),0)/recent.length : 0;
  const current = currentMonth() === month;
  const remainingDays = current ? Math.max(0, days - elapsed) : 0;
  const variableRows = db.prepare(`SELECT COALESCE(c.name,'ไม่ระบุ') AS category, SUM(e.amount) AS total
    FROM expenses e LEFT JOIN categories c ON c.id=e.category_id WHERE e.expense_date LIKE ?
    GROUP BY e.category_id`).all(`${month}%`);
  const variableTotal = variableRows.reduce((s,r)=>s+Number(r.total||0),0);
  const fixedEstimate = current ? Math.min(variableTotal, avgRecentExpense * 0.45) : expense;
  const variableSpent = Math.max(0, expense - (current ? fixedEstimate : 0));
  const baseDaily = elapsed > 0 ? variableSpent / elapsed : 0;
  const bestDaily = baseDaily * 0.75;
  const expectedDaily = baseDaily;
  const worstDaily = baseDaily * 1.25;
  const bestExpense = current ? fixedEstimate + variableSpent + bestDaily * remainingDays : expense;
  const expectedExpense = current ? fixedEstimate + variableSpent + expectedDaily * remainingDays : expense;
  const worstExpense = current ? fixedEstimate + variableSpent + worstDaily * remainingDays : expense;
  const buffer = income > 0 ? income * 0.10 : 0;
  const safeSpendDaily = current && remainingDays > 0 ? Math.max(0, (income - expense - buffer) / remainingDays) : 0;
  const confidence = elapsed >= 14 ? 'สูง' : elapsed >= 7 ? 'ปานกลาง' : 'ต่ำ';
  const forecast = { currentExpense: expense, bestExpense, expectedExpense, worstExpense,
    bestRemaining: income-bestExpense, expectedRemaining: income-expectedExpense, worstRemaining: income-worstExpense,
    remainingDays, elapsedDays: elapsed, safeSpendDaily, confidence, buffer, avgRecentExpense };
  return { budgets, projectedExpense: expectedExpense, projectedRemaining: income-expectedExpense, avgRecentExpense, forecast };
}

function buildInsights(data) {
  const { income, expense, remaining, categories, merchants, daily, previous, budgetIntelligence } = data;
  const insights = [];
  const top = categories[0];
  const forecast = budgetIntelligence?.forecast;
  if (forecast && currentMonth() === data.month && income > 0 && forecast.expectedRemaining < 0) insights.push({ type: 'warning', title: 'Forecast มีความเสี่ยงเงินไม่พอสิ้นเดือน', text: `กรณีคาดการณ์ รายจ่ายอาจอยู่ที่ ${money(forecast.expectedExpense)} บาท และติดลบประมาณ ${money(Math.abs(forecast.expectedRemaining))} บาท` });
  if (income > 0 && expense / income >= 0.8) insights.push({ type: 'warning', title: 'รายจ่ายสูงเมื่อเทียบกับรายรับ', text: `ใช้ไป ${(expense / income * 100).toFixed(1)}% ของรายรับเดือนนี้` });
  if (previous.expense > 0 && expense > previous.expense * 1.15) insights.push({ type: 'warning', title: 'รายจ่ายเพิ่มขึ้นชัดเจน', text: `เพิ่มขึ้น ${((expense / previous.expense - 1) * 100).toFixed(1)}% จากเดือนก่อน` });
  if (previous.expense > 0 && expense < previous.expense * 0.85) insights.push({ type: 'positive', title: 'ควบคุมรายจ่ายได้ดีขึ้น', text: `ลดลง ${((1 - expense / previous.expense) * 100).toFixed(1)}% จากเดือนก่อน` });
  if (top && expense > 0 && top.share >= 40) insights.push({ type: 'info', title: `หมวด “${top.name}” มีสัดส่วนสูง`, text: `${top.share.toFixed(1)}% ของรายจ่ายทั้งหมดมาจากหมวดนี้` });
  const peak = daily.reduce((best, row) => !best || row.total > best.total ? row : best, null);
  if (peak && expense > 0 && peak.total / expense >= 0.25) insights.push({ type: 'info', title: 'มีวันใช้เงินสูงผิดปกติ', text: `${peak.date} ใช้ ${money(peak.total)} บาท หรือ ${(peak.total / expense * 100).toFixed(1)}% ของรายจ่ายทั้งเดือน` });
  if (income > 0 && remaining > 0 && expense > 0 && !insights.some(x => x.type === 'warning')) insights.push({ type: 'positive', title: 'ภาพรวมการเงินยังอยู่ในเกณฑ์ดี', text: `เหลือสุทธิ ${money(remaining)} บาท หลังหักรายจ่าย` });
  return insights.slice(0, 5);
}


function buildFinancialHealth(data) {
  const { income, expense, remaining, previous, categories, budgetIntelligence } = data;
  let score = 50; const factors = [];
  if (income > 0) { const rate=Math.max(-100,Math.min(100,remaining/income*100)); score+=Math.round(rate*0.35); factors.push({label:'เงินเหลือ',value:rate.toFixed(1)+'%'}); }
  if (previous.expense > 0) { const change=(expense-previous.expense)/previous.expense*100; score+=Math.round(Math.max(-20,Math.min(20,-change*0.5))); factors.push({label:'เทียบเดือนก่อน',value:(change>=0?'+':'')+change.toFixed(1)+'%'}); }
  if (categories[0] && expense > 0) { const share=categories[0].share; score+=share<=30?8:share<=45?3:-6; factors.push({label:'หมวดสูงสุด',value:categories[0].name+' '+share.toFixed(1)+'%'}); }
  const budgets=budgetIntelligence?.budgets||[]; const over=budgets.filter(x=>x.usedPct>100).length; if(budgets.length) score += over ? -Math.min(12,over*4) : 6;
  score=Math.max(0,Math.min(100,score));
  const level=score>=80?'ดีมาก':score>=65?'ดี':score>=50?'พอใช้':score>=35?'ต้องระวัง':'น่าเป็นห่วง';
  return {score,level,factors,budgetOverCount:over};
}
function buildMonthlyPlan(data) {
  const { income, expense, remaining, categories, budgetIntelligence } = data;
  const currentMonthSelected=currentMonth()===data.month;
  const days=new Date(Number(data.month.slice(0,4)),Number(data.month.slice(5,7)),0).getDate();
  const today=todayParts(); const elapsed=currentMonthSelected?Math.min(today.day,days):days;
  const remainingDays=currentMonthSelected?Math.max(1,days-elapsed):0;
  const projected=budgetIntelligence?.projectedExpense??expense; const projectedRemaining=income-projected;
  const dailySpendTarget=remainingDays>0?(budgetIntelligence?.forecast?.safeSpendDaily||0):0; const top=categories[0];
  return {remainingDays,dailySpendTarget,projectedExpense:projected,projectedRemaining,actions:[
    top?'คุมหมวด '+top.name+' เป็นอันดับแรก เพราะคิดเป็น '+top.share.toFixed(1)+'% ของรายจ่าย':'บันทึกรายจ่ายให้ครบเพื่อสร้างแผนที่แม่นขึ้น',
    currentMonthSelected?'จากนี้พยายามใช้ไม่เกินประมาณ '+money(dailySpendTarget)+' บาท/วัน เพื่อรักษายอดคงเหลือตามการคาดการณ์':'เดือนนี้ใช้จริง '+money(expense)+' บาท และเหลือสุทธิ '+money(remaining)+' บาท',
    (budgetIntelligence?.budgets||[]).some(x=>x.usedPct>100)?'มีงบประมาณบางหมวดเกินแล้ว ควรชะลอรายจ่ายในหมวดที่เกินก่อน':'ตั้งงบประมาณรายหมวดเพื่อให้ระบบเตือนก่อนใช้เกิน'
  ]};
}

function buildResearch(data) {
  const { month, income, expense, remaining, activeDays, avgPerDay, categories, merchants, daily, previous } = data;
  const topCategory = categories[0];
  const topMerchant = merchants[0];
  const change = pctChange(expense, previous.expense);
  const parts = [];

  parts.push(`${monthLabel(month)} มีรายรับรวม ${money(income)} บาท และรายจ่ายรวม ${money(expense)} บาท เหลือสุทธิ ${money(remaining)} บาท`);
  if (income > 0) parts.push(`คิดเป็นการใช้รายรับประมาณ ${(expense / income * 100).toFixed(1)}%`);
  if (topCategory) parts.push(`หมวดที่ใช้จ่ายมากที่สุดคือ “${topCategory.name}” ${money(topCategory.total)} บาท หรือ ${topCategory.share.toFixed(1)}% ของรายจ่ายทั้งหมด`);
  if (topMerchant) parts.push(`ร้านค้า/ผู้รับเงินที่มียอดสะสมสูงสุดคือ “${topMerchant.name}” ${money(topMerchant.total)} บาท จาก ${topMerchant.count} รายการ`);
  if (activeDays > 0) parts.push(`มีการใช้จ่ายใน ${activeDays} วันของเดือน เฉลี่ยประมาณ ${money(avgPerDay)} บาทต่อวันที่มีรายการ`);
  if (previous.expense > 0 || expense > 0) {
    if (change > 5) parts.push(`เมื่อเทียบกับเดือนก่อน รายจ่ายเพิ่มขึ้น ${change.toFixed(1)}% ควรตรวจสอบหมวดที่เพิ่มขึ้นเป็นพิเศษ`);
    else if (change < -5) parts.push(`เมื่อเทียบกับเดือนก่อน รายจ่ายลดลง ${Math.abs(change).toFixed(1)}% ถือเป็นแนวโน้มที่ดีขึ้น`);
    else parts.push(`เมื่อเทียบกับเดือนก่อน รายจ่ายเปลี่ยนแปลง ${change.toFixed(1)}% อยู่ในระดับใกล้เคียงเดิม`);
  }
  const peakDay = daily.reduce((best, row) => !best || row.total > best.total ? row : best, null);
  if (peakDay) parts.push(`วันที่มีรายจ่ายสูงสุดคือ ${peakDay.date} จำนวน ${money(peakDay.total)} บาท`);
  if (income === 0 && expense === 0) parts.push('เดือนนี้ยังไม่มีข้อมูลทางการเงินเพียงพอสำหรับการวิเคราะห์');

  return parts.join(' ');
}

router.get('/month/:month', (req, res) => {
  const month = String(req.params.month || '');
  if (!validMonth(month)) return res.status(400).json({ error: 'รูปแบบเดือนต้องเป็น YYYY-MM' });
  const prevMonth = previousMonth(month);
  const pattern = `${month}%`;
  const prevPattern = `${prevMonth}%`;

  const incomeRow = db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM income_entries WHERE month=?').get(month);
  const income = Number(incomeRow?.amount || 0);
  const expense = Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE expense_date LIKE ?').get(pattern).total || 0);
  const previousExpense = Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE expense_date LIKE ?').get(prevPattern).total || 0);
  const previousIncome = Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM income_entries WHERE month=?').get(prevMonth)?.amount || 0);
  const remaining = income - expense;
  const transactionCount = Number(db.prepare('SELECT COUNT(*) AS count FROM expenses WHERE expense_date LIKE ?').get(pattern).count || 0);

  const categories = db.prepare(`SELECT c.name, SUM(e.amount) AS total, COUNT(*) AS count
    FROM expenses e JOIN categories c ON c.id=e.category_id WHERE e.expense_date LIKE ?
    GROUP BY c.id ORDER BY total DESC`).all(pattern).map(r => ({ ...r, total: Number(r.total || 0), count: Number(r.count || 0) }));
  const totalForShare = expense || 1;
  categories.forEach(r => { r.share = (r.total / totalForShare) * 100; });
  const merchants = db.prepare(`SELECT COALESCE(NULLIF(TRIM(merchant),''),'ไม่ระบุ') AS name,
    SUM(amount) AS total, COUNT(*) AS count FROM expenses WHERE expense_date LIKE ?
    GROUP BY name ORDER BY total DESC LIMIT 10`).all(pattern).map(r => ({ ...r, total: Number(r.total || 0), count: Number(r.count || 0) }));

  const daily = db.prepare(`SELECT expense_date AS date, SUM(amount) AS total, COUNT(*) AS count
    FROM expenses WHERE expense_date LIKE ? GROUP BY expense_date ORDER BY expense_date ASC`).all(pattern).map(r => ({ ...r, total: Number(r.total || 0), count: Number(r.count || 0) }));
  const activeDays = daily.length;
  const avgPerDay = activeDays ? expense / activeDays : 0;
  const avgPerCalendarDay = expense / new Date(Number(month.slice(0,4)), Number(month.slice(5,7)), 0).getDate();
  const savingsRate = income > 0 ? (remaining / income) * 100 : null;

  const data = {
    month, monthLabel: monthLabel(month), income, expense, remaining, transactionCount,
    activeDays, avgPerDay, avgPerCalendarDay, savingsRate, categories, merchants, daily,
    previous: { month: prevMonth, income: previousIncome, expense: previousExpense,
      remaining: previousIncome - previousExpense }
  };
  data.changes = {
    expensePct: pctChange(expense, previousExpense),
    incomePct: pctChange(income, previousIncome),
    remainingPct: pctChange(remaining, previousIncome - previousExpense)
  };
  data.research = buildResearch(data);
  data.insights = buildInsights(data);
  data.budgetIntelligence = buildBudgetIntelligence(data);
  data.financialHealth = buildFinancialHealth(data);
  data.monthlyPlan = buildMonthlyPlan(data);
  if (data.budgetIntelligence?.forecast) {
    data.monthlyPlan.dailySpendTarget = data.budgetIntelligence.forecast.safeSpendDaily;
  }
  res.json(data);
});

router.get('/overview/list', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 24);
  const rows = db.prepare(`SELECT month, COALESCE(SUM(amount),0) AS income FROM income_entries GROUP BY month ORDER BY month DESC LIMIT ?`).all(limit);
  const months = new Map(rows.map(r => [r.month, Number(r.income || 0)]));
  const expenseRows = db.prepare(`SELECT substr(expense_date,1,7) AS month, SUM(amount) AS expense
    FROM expenses GROUP BY substr(expense_date,1,7) ORDER BY month DESC LIMIT ?`).all(limit);
  expenseRows.forEach(r => months.set(r.month, months.has(r.month) ? months.get(r.month) : 0));
  const out = [...months.keys()].sort((a,b) => b.localeCompare(a)).slice(0, limit).map(month => {
    const expense = Number(expenseRows.find(r => r.month === month)?.expense || 0);
    const income = Number(months.get(month) || 0);
    return { month, income, expense, remaining: income - expense };
  });
  res.json({ months: out });
});

module.exports = router;
