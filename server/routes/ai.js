const express = require('express');
const db = require('../db');
const { currentMonth } = require('../utils/date');
const router = express.Router();

async function callOllama(messages) {
  const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
  const resp = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OLLAMA_MODEL || 'qwen2.5:0.5b', prompt, stream: false, options: { temperature: 0.2, num_predict: 360, num_ctx: 4096 } })
  });
  if (!resp.ok) throw new Error(`Ollama API error: ${resp.status}`);
  const data = await resp.json();
  return String(data.response || '').replace(/```json|```/g, '').trim();
}

async function callClaude(messages) {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key || key === 'your_key_here') return callOllama(messages);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 900, messages })
  });
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) return callOllama(messages);
    throw new Error(`Claude API error: ${resp.status}`);
  }
  const data = await resp.json();
  return data.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
}

router.get('/analysis', async (req, res) => {
  const month = String(req.query.month || currentMonth());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'à¸£à¸¹à¸›à¹à¸šà¸šà¹€à¸”à¸·à¸­à¸™à¸•à¹‰à¸­à¸‡à¹€à¸›à¹‡à¸™ YYYY-MM' });
  try {
    const expenseRows = db.prepare(`SELECT e.amount, e.merchant, c.name AS category, e.expense_date
      FROM expenses e JOIN categories c ON c.id=e.category_id
      WHERE e.expense_date LIKE ? ORDER BY e.expense_date ASC, e.id ASC`).all(`${month}%`);
    const income = Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM income_entries WHERE month=?').get(month)?.amount || 0);
    const expense = expenseRows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const remaining = income - expense;
    const start = new Date(`${month}-01T00:00:00`);
    const history = [];
    for (let i = 1; i <= 6; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() - i, 1);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const inc = Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM income_entries WHERE month=?').get(m)?.amount || 0);
      const exp = Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE expense_date LIKE ?').get(`${m}%`).total || 0);
      history.push({ month: m, income: inc, expense: exp, remaining: inc - exp });
    }
    const budgets = db.prepare(`SELECT c.name AS category, b.monthly_limit AS monthly_limit,
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.category_id=b.category_id AND e.expense_date LIKE ?),0) AS spent
      FROM budgets b JOIN categories c ON c.id=b.category_id ORDER BY c.name`).all(`${month}%`)
      .map(r => ({ category: r.category, limit: Number(r.monthly_limit || 0), spent: Number(r.spent || 0) }));
    const goals = db.prepare('SELECT name, target_amount, current_amount, target_date FROM savings_goals ORDER BY created_at DESC LIMIT 8').all();
    const categoryTotals = {}, merchantTotals = {};
    for (const row of expenseRows) {
      categoryTotals[row.category] = (categoryTotals[row.category] || 0) + Number(row.amount || 0);
      const merchant = String(row.merchant || 'à¹„à¸¡à¹ˆà¸£à¸°à¸šà¸¸').trim() || 'à¹„à¸¡à¹ˆà¸£à¸°à¸šà¸¸';
      merchantTotals[merchant] = (merchantTotals[merchant] || 0) + Number(row.amount || 0);
    }
    const topCategory = Object.entries(categoryTotals).sort((a,b) => b[1]-a[1])[0] || null;
    const topMerchant = Object.entries(merchantTotals).sort((a,b) => b[1]-a[1])[0] || null;
    const [year, mon] = month.split('-').map(Number);
    const days = new Date(year, mon, 0).getDate();
    const now = new Date();
    const elapsed = now.toISOString().slice(0,7) === month ? Math.min(now.getDate(), days) : days;
    const projectedExpense = elapsed > 0 ? expense / elapsed * days : expense;
    const projectedRemaining = income - projectedExpense;
    const remainingDays = month === currentMonth() ? Math.max(0, days - elapsed) : 0;
    const daily = elapsed > 0 ? expense / elapsed : 0;
    const forecastExpected = month === currentMonth() ? expense + daily * remainingDays : expense;
    const forecastBest = month === currentMonth() ? expense + daily * 0.75 * remainingDays : expense;
    const forecastWorst = month === currentMonth() ? expense + daily * 1.25 * remainingDays : expense;
    const safeSpendDaily = month === currentMonth() && remainingDays > 0 ? Math.max(0, (income - expense - Math.max(0, income * 0.10)) / remainingDays) : 0;
    const averageHistory = history.filter(x => x.expense > 0);
    const avgRecentExpense = averageHistory.length ? averageHistory.reduce((s,x) => s+x.expense,0) / averageHistory.length : 0;
    const facts = {
      month, income, expense, remaining,
      savingsRate: income > 0 ? remaining / income * 100 : null,
      transactionCount: expenseRows.length,
      topCategory: topCategory ? { name: topCategory[0], total: topCategory[1], share: expense > 0 ? topCategory[1] / expense * 100 : 0 } : null,
      topMerchant: topMerchant ? { name: topMerchant[0], total: topMerchant[1] } : null,
      projectedExpense: forecastExpected, projectedRemaining: income - forecastExpected,
      forecast: { bestExpense: forecastBest, expectedExpense: forecastExpected, worstExpense: forecastWorst, bestRemaining: income-forecastBest, expectedRemaining: income-forecastExpected, worstRemaining: income-forecastWorst, remainingDays, safeSpendDaily },
      avgRecentExpense, budgets, goals, history
    };
    if (!expenseRows.length && !income) return res.json({ month, summary: 'à¹€à¸”à¸·à¸­à¸™à¸™à¸µà¹‰à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸—à¸²à¸‡à¸à¸²à¸£à¹€à¸‡à¸´à¸™à¹€à¸žà¸µà¸¢à¸‡à¸žà¸­à¸ªà¸³à¸«à¸£à¸±à¸šà¸§à¸´à¹€à¸„à¸£à¸²à¸°à¸«à¹Œ', facts });
    const prompt = `à¸„à¸¸à¸“à¹€à¸›à¹‡à¸™à¸™à¸±à¸à¸§à¸´à¹€à¸„à¸£à¸²à¸°à¸«à¹Œà¸à¸²à¸£à¹€à¸‡à¸´à¸™à¸ªà¹ˆà¸§à¸™à¸šà¸¸à¸„à¸„à¸¥
à¹ƒà¸Šà¹‰à¹€à¸‰à¸žà¸²à¸°à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹ƒà¸™ JSON à¸”à¹‰à¸²à¸™à¸¥à¹ˆà¸²à¸‡ à¸«à¹‰à¸²à¸¡à¸ªà¸£à¹‰à¸²à¸‡à¸•à¸±à¸§à¹€à¸¥à¸‚à¹ƒà¸«à¸¡à¹ˆ à¸«à¹‰à¸²à¸¡à¸­à¹‰à¸²à¸‡à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ à¸²à¸¢à¸™à¸­à¸ à¹à¸¥à¸°à¸«à¹‰à¸²à¸¡à¹€à¸›à¸¥à¸µà¹ˆà¸¢à¸™à¸ˆà¸³à¸™à¸§à¸™à¹€à¸‡à¸´à¸™
${JSON.stringify(facts)}
à¸•à¸­à¸šà¸ à¸²à¸©à¸²à¹„à¸—à¸¢à¹‚à¸”à¸¢à¹ƒà¸Šà¹‰à¸«à¸±à¸§à¸‚à¹‰à¸­à¹€à¸«à¸¥à¹ˆà¸²à¸™à¸µà¹‰:
à¸ à¸²à¸žà¸£à¸§à¸¡
à¹à¸™à¸§à¹‚à¸™à¹‰à¸¡ 6 à¹€à¸”à¸·à¸­à¸™
à¸ˆà¸¸à¸”à¸—à¸µà¹ˆà¸„à¸§à¸£à¸£à¸°à¸§à¸±à¸‡
à¸‡à¸šà¸›à¸£à¸°à¸¡à¸²à¸“
à¹€à¸›à¹‰à¸²à¸«à¸¡à¸²à¸¢à¸à¸²à¸£à¸­à¸­à¸¡
à¹à¸œà¸™à¸—à¸µà¹ˆà¹à¸™à¸°à¸™à¸³
à¹ƒà¸™à¹à¸œà¸™à¸—à¸µà¹ˆà¹à¸™à¸°à¸™à¸³à¹ƒà¸«à¹‰à¹€à¸ªà¸™à¸­ 2-3 à¸à¸²à¸£à¸à¸£à¸°à¸—à¸³à¸—à¸µà¹ˆà¸—à¸³à¹„à¸”à¹‰à¸ˆà¸£à¸´à¸‡à¸ˆà¸²à¸à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸™à¸µà¹‰ à¹€à¸Šà¹ˆà¸™ à¸¥à¸”à¸«à¸¡à¸§à¸”à¸—à¸µà¹ˆà¸ªà¸¹à¸‡à¸ªà¸¸à¸” à¸à¸³à¸«à¸™à¸”à¹€à¸žà¸”à¸²à¸™à¸à¸²à¸£à¹ƒà¸Šà¹‰ à¸«à¸£à¸·à¸­à¹€à¸žà¸´à¹ˆà¸¡à¹€à¸‡à¸´à¸™à¹€à¸‚à¹‰à¸²à¹€à¸›à¹‰à¸²à¸«à¸¡à¸²à¸¢
à¸«à¸²à¸à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹„à¸¡à¹ˆà¸žà¸­ à¹ƒà¸«à¹‰à¸£à¸°à¸šà¸¸à¸§à¹ˆà¸²à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹€à¸žà¸µà¸¢à¸‡à¸žà¸­à¹à¸—à¸™à¸à¸²à¸£à¹€à¸”à¸²
à¸­à¸¢à¹ˆà¸²à¸—à¸³à¹ƒà¸«à¹‰à¸à¸²à¸£à¸„à¸²à¸”à¸à¸²à¸£à¸“à¹Œà¸”à¸¹à¹€à¸«à¸¡à¸·à¸­à¸™à¹€à¸›à¹‡à¸™à¸à¸²à¸£à¸£à¸±à¸šà¸›à¸£à¸°à¸à¸±à¸™`;
    let summary = await callClaude([{ role: 'user', content: prompt }]);
    if (!isUsefulAnalystText(summary)) summary = buildGroundedAnalyst(facts);
    res.json({ month, summary, facts });
  } catch (err) {
    console.error('AI analysis:', err);
    const status = /Ollama API error/.test(err.message) ? 503 : 500;
    res.status(status).json({ error: 'à¸§à¸´à¹€à¸„à¸£à¸²à¸°à¸«à¹Œà¸”à¹‰à¸§à¸¢ AI à¹„à¸¡à¹ˆà¸ªà¸³à¹€à¸£à¹‡à¸ˆ', detail: err.message });
  }
});

module.exports = router;


function buildGroundedAnalyst(facts) {
  const top = facts.topCategory;
  const goal = facts.goals?.find(g => Number(g.current_amount || 0) < Number(g.target_amount || 0));
  const over = facts.projectedRemaining < 0;
  const lines = [
    'ภาพรวม',
    `เดือน ${facts.month}: รายรับ ${facts.income.toLocaleString('th-TH')} บาท รายจ่าย ${facts.expense.toLocaleString('th-TH')} บาท เหลือสุทธิ ${facts.remaining.toLocaleString('th-TH')} บาท`,
    `อัตราเงินเหลือ ${facts.savingsRate == null ? 'ไม่มีข้อมูล' : facts.savingsRate.toFixed(1) + '%'} จากรายรับ`,
    '',
    'แนวโน้ม 6 เดือน',
    `รายจ่ายเฉลี่ยของเดือนย้อนหลังที่มีข้อมูล ${facts.avgRecentExpense.toLocaleString('th-TH', { maximumFractionDigits: 0 })} บาท`,
    `พยากรณ์สิ้นเดือน ${facts.projectedExpense.toLocaleString('th-TH', { maximumFractionDigits: 0 })} บาท และคาดว่าเหลือ ${facts.projectedRemaining.toLocaleString('th-TH', { maximumFractionDigits: 0 })} บาท`,
    '',
    'จุดที่ควรระวัง',
    top ? `หมวด ${top.name} สูงสุด ${top.total.toLocaleString('th-TH')} บาท คิดเป็น ${top.share.toFixed(1)}% ของรายจ่ายเดือนนี้` : 'ยังไม่มีหมวดรายจ่ายเด่น',
    over ? 'จากอัตราการใช้เงินปัจจุบัน มีโอกาสที่รายจ่ายสิ้นเดือนจะสูงกว่ารายรับ' : 'จากข้อมูลปัจจุบัน ยังไม่พบว่ารายจ่ายคาดการณ์สูงกว่ารายรับ',
    '',
    'งบประมาณ',
    facts.budgets?.length ? `มีการตั้งงบประมาณ ${facts.budgets.length} หมวด` : 'ยังไม่ได้ตั้งงบประมาณรายหมวด',
    '',
    'เป้าหมายการออม',
    goal ? `เป้าหมาย ${goal.name}: ${Number(goal.current_amount || 0).toLocaleString('th-TH')} / ${Number(goal.target_amount || 0).toLocaleString('th-TH')} บาท` : 'ไม่มีเป้าหมายที่ยังขาดยอดสะสม',
    '',
    'แผนที่แนะนำ',
    top ? `1) คุมรายจ่ายหมวด ${top.name} เป็นลำดับแรก` : '1) บันทึกรายจ่ายให้ครบเพื่อหาหมวดที่ควรลด',
    goal ? `2) กันเงินเข้าเป้าหมาย ${goal.name} ตามจำนวนที่เหลือก่อนสิ้นเดือน` : '2) ตั้งเป้าหมายการออมและกำหนดยอดสะสมรายเดือน',
    '3) ตั้งงบประมาณรายหมวดเพื่อให้ระบบเตือนก่อนใช้เกิน'
  ];
  return lines.join('\n');
}

function isUsefulAnalystText(text) {
  const value = String(text || '');
  const headings = ['ภาพรวม', 'แนวโน้ม 6 เดือน', 'จุดที่ควรระวัง', 'งบประมาณ', 'เป้าหมายการออม', 'แผนที่แนะนำ'];
  return headings.filter(h => value.includes(h)).length >= 4 && !value.includes('$');
}


