const TZ = 'Asia/Bangkok';

function todayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const out = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { year: Number(out.year), month: Number(out.month), day: Number(out.day) };
}

function currentDate() {
  const p = todayParts();
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function currentMonth() {
  return currentDate().slice(0, 7);
}

function dateText(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const out = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${out.year}-${out.month}-${out.day}`;
}

module.exports = { TZ, todayParts, currentDate, currentMonth, dateText };
