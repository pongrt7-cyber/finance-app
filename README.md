# Finance App

เว็บแอปจัดการการเงินส่วนตัว (Single User) — Thai UI, AI-assisted expense entry.

## Stack
- Frontend: HTML5 + Tailwind CSS (CDN) + Vanilla JS + Chart.js
- Backend: Node.js + Express
- DB: SQLite via `node:sqlite` (native, no compilation needed)
- AI: **Tesseract.js** (อ่านสลิป/ใบเสร็จ — ฟรี, pure JavaScript, รันในตัว Node เลย ไม่ต้องพึ่ง Python) + Anthropic Claude API (เสริม: แปลงข้อความสั้นๆ และสรุปวิเคราะห์รายเดือน — ต้องมี key)

## Requirements
- Node.js **>= 22.5** (uses native `node:sqlite`, no `better-sqlite3`)

## Setup
```bash
cd finance-app
npm install
cp .env.example .env
# edit .env: set JWT_SECRET, ADMIN_PASSWORD (ANTHROPIC_API_KEY ใส่หรือไม่ใส่ก็ได้)

npm run seed    # optional: insert sample data
npm start       # or: npm run dev (auto-restart)
```
Open http://localhost:3000

### หมายเหตุ OCR (Tesseract.js)
- ครั้งแรกที่อัปโหลดรูป จะดาวน์โหลดโมเดลภาษา (ไทย+อังกฤษ) อัตโนมัติ (ต้องมีเน็ต ครั้งเดียว แล้ว cache ไว้)
- อ่านได้ทั้งภาษาไทย/อังกฤษ ความแม่นยำขึ้นกับความคมชัดของรูป
- ระบบใช้ regex ดึง จำนวนเงิน/วันที่/ร้านค้า/หมวดหมู่ จากข้อความที่ OCR อ่านได้ (ไม่ใช้ AI ในขั้นตอนนี้) ถ้าเดาผิดผู้ใช้แก้เองในฟอร์มได้
- ไม่ต้องติดตั้ง Python/PaddleOCR ใดๆ ทั้งสิ้น (เดิมเคยใช้ PaddleOCR แต่เจอปัญหา crash บน CPU ที่ไม่รองรับ AVX จึงเปลี่ยนมาใช้ตัวนี้)

## Project Structure
```
finance-app/
├── server/
│   ├── index.js          # Express app entry
│   ├── db/
│   │   ├── index.js      # node:sqlite connection
│   │   ├── schema.sql    # tables + default categories
│   │   └── seed.js       # sample data
│   ├── routes/
│   │   ├── auth.js       # unlock/change password (JWT)
│   │   ├── income.js     # monthly salary (lock/unlock)
│   │   ├── categories.js
│   │   ├── expenses.js   # CRUD + filter/search
│   │   ├── budgets.js
│   │   ├── goals.js      # savings goals
│   │   ├── stats.js      # dashboard + period stats
│   │   ├── ai.js         # image/text parsing, monthly analysis
│   │   └── data.js       # export/import/backup/clear
│   └── middleware/auth.js
└── public/
    ├── index.html
    ├── css/style.css
    └── js/{api.js, app.js}
```

## Implemented (MVP)
- Dashboard: เงินเดือน, คงเหลือ, %ใช้ไป, งบต่อวัน, กราฟหมวดหมู่, รายการล่าสุด
- รายรับ: เงินเดือน (ล็อกหลังบันทึก, ปลดล็อกด้วยรหัสผ่าน)
- รายจ่าย: CRUD, หมวดหมู่ default + เพิ่มเอง, วิธีชำระเงิน (รวมไทยช่วยไทย)
- AI: อ่านสลิป/ใบเสร็จจากรูป, แปลงข้อความสั้นๆ เป็นรายการ, สรุปวิเคราะห์รายเดือน
- สถิติ: today/week/month/year, top category, top expense, trend
- งบประมาณรายหมวด, เป้าหมายการออม
- Export CSV/JSON, Import JSON, Clear data

## LINE Bot (บันทึกรายจ่ายผ่าน LINE)
ส่งรูปสลิป/ข้อความสั้นๆ เข้า LINE OA แล้วบันทึกรายจ่ายอัตโนมัติ (ไม่ต้องเปิดเว็บ)

### Setup
1. สร้าง **Messaging API channel** ที่ https://developers.line.biz/console/ (ฟรี)
2. คัดลอก **Channel secret** และ **Channel access token** (long-lived) มาใส่ใน `.env`:
```
LINE_CHANNEL_SECRET=xxxxxxxxxxxxx
LINE_CHANNEL_ACCESS_TOKEN=xxxxxxxxxxxxx
```
3. เปิด server ให้เข้าถึงจากอินเทอร์เน็ตได้ (LINE ต้องการ HTTPS public URL) — ตอน dev ใช้ ngrok:
```
npx ngrok http 3000
```
จะได้ URL เช่น `https://xxxx.ngrok-free.app`

4. ใน LINE Developers Console → channel ที่สร้าง → **Messaging API** tab → ตั้ง **Webhook URL** เป็น:
```
https://xxxx.ngrok-free.app/api/line/webhook
```
กด **Verify** ให้ขึ้นเครื่องหมายถูก แล้วเปิด **Use webhook**

5. restart `npm start` (log ควรขึ้น `LINE Bot webhook enabled`)

6. เพิ่มเพื่อน LINE OA ด้วย QR code ในหน้า channel → ส่งรูปสลิปหรือพิมพ์ "7-Eleven 58 บาท" ทดสอบได้เลย

### วิธีใช้ผ่าน LINE
- **ส่งรูปสลิป/ใบเสร็จ** → OCR อ่านอัตโนมัติ บันทึกเป็นรายจ่ายทันที ตอบกลับสรุปยอด/ร้านค้า/หมวดหมู่
- **พิมพ์ข้อความสั้นๆ** เช่น `7-Eleven 58 บาท` หรือ `กาแฟ 65` → บันทึกทันที (หมวดหมู่เป็น "อื่นๆ" ไปก่อน แก้ที่หน้าเว็บได้)
- ทุกรายการที่บันทึกผ่าน LINE จะเข้า DB เดียวกับหน้าเว็บ เปิดเว็บดู/แก้ไขได้ปกติ


- หน้า UI: สถิติ, ปฏิทิน, งบประมาณ, เป้าหมายออม, ตั้งค่า (routes/API พร้อมแล้ว รอแค่หน้าจอ)
- แจ้งเตือนใช้เงินเกิน 50/70/90% (ฝั่ง frontend)
- Dark mode toggle
- Backup/Restore ผ่าน UI

## Notes
- รหัสผ่านแอดมิน default มาจาก `.env` (`ADMIN_PASSWORD`) ตอนแรกที่ unlock ครั้งแรก ควรเปลี่ยนทันทีผ่าน `/api/auth/change-password`
- `JWT_SECRET` ต้องตั้งเองใน `.env` ห้าม hardcode ในโค้ด
