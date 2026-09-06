// แปลงบรรทัดข้อความจาก OCR ให้เป็น {amount, merchant, date, category}
// ทำงานด้วย regex ล้วนๆ ไม่ต้องพึ่ง AI API

const CATEGORY_KEYWORDS = {
  'ค่ากิน': ['7-eleven', '7-11', 'เซเว่น', 'ร้านอาหาร', 'ก๋วยเตี๋ยว', 'ข้าว', 'กาแฟ', 'cafe', 'coffee', 'restaurant', 'food', 'เครื่องดื่ม', 'ชานม'],
  'ค่าน้ำมัน': ['ปตท', 'ptt', 'บางจาก', 'shell', 'esso', 'น้ำมัน', 'gas station'],
  'ค่าเน็ต': ['ais', 'true', 'dtac', 'เน็ต', 'internet', 'fibre', 'wifi'],
  'เกม': ['steam', 'garena', 'google play', 'app store', 'เติมเกม', 'topup', 'top-up'],
  'ของใช้': ['lotus', 'บิ๊กซี', 'big c', 'โลตัส', 'makro', 'แมคโคร', 'ซุปเปอร์มาร์เก็ต'],
};

function extractAmount(lines) {
  const priorityKeywords = ['รวม', 'total', 'ยอดรวม', 'จำนวนเงิน', 'net', 'จ่าย'];

  // 1) หาบรรทัดที่มีคำว่า "รวม/total" ก่อน — แม่นสุด
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (priorityKeywords.some(k => lower.includes(k))) {
      const m = line.match(/(?<!\d)\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?(?!\d)/);
      if (m) return parseFloat(m[0].replace(/,/g, ''));
    }
  }

  // 2) เลขที่มีทศนิยม 2 ตำแหน่ง (เช่น 136.00) มักเป็นยอดเงินจริง
  //    ต่างจากเลขอ้างอิง/รหัสธุรกรรมซึ่งมักเป็นจำนวนเต็มยาวๆ ไม่มีทศนิยม
  //    negative lookaround กันไม่ให้ตัดเลขอ้างอิงยาวๆ เป็นท่อนๆ มาปนกัน
  let maxDecimal = null;
  for (const line of lines) {
    const matches = line.match(/(?<!\d)\d{1,3}(?:,\d{3})*\.\d{2}(?!\d)/g);
    if (!matches) continue;
    for (const m of matches) {
      const val = parseFloat(m.replace(/,/g, ''));
      if (!isNaN(val) && (maxDecimal === null || val > maxDecimal)) maxDecimal = val;
    }
  }
  if (maxDecimal !== null) return maxDecimal;

  // 3) ไม่มีทศนิยมเลย -> fallback หาเลขจำนวนเต็มที่มากที่สุด (กันเลขอ้างอิงยาวปนด้วย)
  let max = null;
  for (const line of lines) {
    const matches = line.match(/(?<!\d)\d{1,3}(?:,\d{3})*(?!\d)/g);
    if (!matches) continue;
    for (const m of matches) {
      const val = parseFloat(m.replace(/,/g, ''));
      if (!isNaN(val) && (max === null || val > max)) max = val;
    }
  }
  return max;
}

function extractDate(lines) {
  const now = new Date();
  for (const line of lines) {
    let m = line.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) {
      let [, d, mo, y] = m.map(Number);
      if (y > 2400) y -= 543;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    m = line.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
      let [, y, mo, d] = m.map(Number);
      if (y > 2400) y -= 543;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return now.toISOString().slice(0, 10);
}

function extractTime(lines) {
  for (const line of lines) {
    const m = line.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  return new Date().toTimeString().slice(0, 5);
}

function extractMerchant(lines) {
  const skip = ['ใบเสร็จ', 'receipt', 'tax invoice', 'สลิป', 'slip'];
  const bankNames = ['ttb', 'scb', 'kbank', 'bbl', 'krungsri', 'ktb', 'gsb', 'uob', 'cimb', 'tmb', 'kasikorn', 'ไทยพาณิชย์', 'กสิกร', 'กรุงไทย', 'กรุงเทพ', 'กรุงศรี', 'ออมสิน'];
  const statusPhrases = ['สำเร็จ', 'โอนเงิน', 'จ่ายบิล', 'ชำระเงิน', 'complete', 'success'];

  const isNoise = (clean) => {
    if (clean.length < 2) return true;
    if (/^\d+$/.test(clean)) return true;
    const lower = clean.toLowerCase();
    if (skip.some(s => lower.includes(s))) return true;
    if (bankNames.some(b => lower === b || lower.includes(b))) return true;
    if (statusPhrases.some(s => clean.includes(s))) return true;
    if (/^\d{1,2}\s*[ก-๙]+\.[ก-๙]+\.\s*\d{2,4}/.test(clean)) return true; // วันที่ เช่น 3 ส.ค. 69
    return false;
  };

  // สลิปโอนเงิน: ร้านค้า/ผู้รับมักอยู่บรรทัดถัดจากชื่อคน/เลขบัญชีผู้จ่าย (บล็อกที่ 2)
  // หาบรรทัดที่ไม่ใช่ noise แล้วอยู่ "หลัง" บรรทัดที่มีเลขบัญชี (มี x หรือ * ปนตัวเลข) ก่อน — มักเป็นชื่อร้าน/ผู้รับเงินจริง
  const acctLineIdx = lines.findIndex(l => /(xxx|[*])[\-x\d]*\d/i.test(l));
  if (acctLineIdx !== -1) {
    for (let i = acctLineIdx + 1; i < lines.length; i++) {
      const clean = lines[i].trim();
      if (!isNoise(clean)) return clean;
    }
  }

  // ไม่เจอรูปแบบสลิปโอนเงิน -> ใช้บรรทัดแรกๆ ที่ไม่ใช่ noise (เช่น ใบเสร็จร้านค้าทั่วไป)
  for (const line of lines.slice(0, 6)) {
    const clean = line.trim();
    if (!isNoise(clean)) return clean;
  }
  return null;
}

function guessCategory(lines, merchant) {
  const haystack = (lines.join(' ') + ' ' + (merchant || '')).toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => haystack.includes(k))) return category;
  }
  return null;
}

function extractFields(lines) {
  return {
    amount: extractAmount(lines),
    merchant: extractMerchant(lines),
    date: extractDate(lines),
    time: extractTime(lines),
    category: guessCategory(lines, extractMerchant(lines)),
    raw_text: lines.join('\n')
  };
}

module.exports = { extractFields };
