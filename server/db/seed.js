require('dotenv').config();
const db = require('./index');

const month = new Date().toISOString().slice(0, 7);

db.prepare(`
  INSERT INTO income (amount, month, locked) VALUES (?, ?, 1)
  ON CONFLICT(month) DO UPDATE SET amount = excluded.amount
`).run(15000, month);

const cat = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;

const sample = [
  { amount: 3500, category: 'ค่าห้อง', merchant: 'หอพักบ้านสวย', day: '01' },
  { amount: 599, category: 'ค่าเน็ต', merchant: 'AIS Fibre', day: '02' },
  { amount: 300, category: 'ค่าน้ำมัน', merchant: 'ปตท.', day: '03' },
  { amount: 60, category: 'ค่ากิน', merchant: '7-Eleven', day: '03' },
  { amount: 120, category: 'ค่ากิน', merchant: 'ร้านข้าวมันไก่', day: '04' },
  { amount: 890, category: 'เกม', merchant: 'Steam', day: '05' },
];

const insert = db.prepare(`
  INSERT INTO expenses (amount, category_id, merchant, payment_method, expense_date, expense_time, source)
  VALUES (?, ?, ?, 'เงินสด', ?, '12:00', 'manual')
`);

sample.forEach(s => {
  insert.run(s.amount, cat(s.category), s.merchant, `${month}-${s.day}`);
});

console.log('Seed data inserted for', month);
