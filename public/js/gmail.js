(() => {
  const esc = (v = '') => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { messages: [], scanned: 0 };

  async function gmailFetch(path, options = {}) {
    const res = await fetch('/api/gmail' + path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        const retry = Number(res.headers.get('Retry-After') || 0);
        const suffix = retry > 0 ? ` ลองใหม่ในประมาณ ${retry} วินาที` : '';
        throw new Error((data.error || 'Gmail ถูกจำกัดชั่วคราว') + suffix);
      }
      throw new Error(data.error || 'Gmail error');
    }
    return data;
  }

  function ensureUI() {
    if (document.getElementById('gmailView')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <button id="gmailFloatingBtn" onclick="openGmail()" style="position:fixed;right:18px;bottom:78px;z-index:50;border:0;border-radius:999px;padding:11px 16px;background:#111827;color:#fff;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,.18)">Gmail</button>
      <section id="gmailView" class="view hidden" style="position:fixed;inset:0;z-index:45;background:#fff;overflow:auto;padding:20px 16px 110px">
        <div style="max-width:900px;margin:auto">
          <div class="gmail-page-head">
            <div><h2>นำเข้ารายการจาก Gmail</h2><p>เลือกเดือนเพื่อค้นหาและนำเข้าธุรกรรมจากอีเมล</p></div>
            <button onclick="closeGmail()" class="btn-secondary gmail-close-btn">ปิด</button>
          </div>
          <div id="gmailConnectBox" class="gmail-connect-card">
            <div class="gmail-connect-row">
              <p id="gmailStatus" class="gmail-status-text">กำลังตรวจสอบสถานะ...</p>
              <div class="gmail-connect-actions">
                <button id="gmailConnectBtn" onclick="connectGmail()" class="btn-primary gmail-connect-btn">เชื่อมต่อ Gmail</button>
                <button id="gmailDisconnectBtn" onclick="disconnectGmail()" class="btn-secondary gmail-disconnect-btn" style="display:none">ยกเลิกการเชื่อมต่อ</button>
              </div>
            </div>
            <div class="gmail-info-box">
              รองรับธนาคาร: ttb · K PLUS · SCB
              <span>ระบบจะใช้เฉพาะยอดที่มีบริบทว่าเป็นจำนวนเงินของธุรกรรม</span>
            </div>
          </div>
          <div id="gmailTools" class="gmail-tools" style="display:none">
            <div class="gmail-toolbar">
              <div class="gmail-month-row">
                <select id="gmailMonth" class="field-input gmail-month-select" aria-label="month"></select>
                <button onclick="fetchGmailMessages()" class="btn-secondary gmail-load-btn">โหลดเดือนที่เลือก</button>
              </div>
              <input id="gmailQuery" class="field-input gmail-query-input" value="" placeholder="ค้นหาเฉพาะเพิ่มเติม เช่น from:scb.co.th newer_than:30d">
              <button onclick="fetchGmailMessages()" class="gmail-fetch-btn">ดึงอีเมลล่าสุด</button>
              <button onclick="openGmailAudit()" class="btn-secondary" style="margin:0">เปิด Gmail Audit Center</button>
            </div>
            <div id="gmailScanInfo" class="gmail-scan-info"></div>
            <div id="gmailResults"></div>
          </div>
        </div>
      </section>`);
  }

  function initMonthPicker() {
    const el = document.getElementById('gmailMonth');
    if (!el || el.options.length) return;
    const now = new Date();
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const label = d.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
      el.insertAdjacentHTML('beforeend', `<option value="${value}">${label}</option>`);
    }
  }

  window.openGmail = async function () {
    ensureUI();
    initMonthPicker();
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById('gmailView').classList.remove('hidden');
    await checkGmailStatus();
  };

  window.closeGmail = function () {
    document.getElementById('gmailView')?.classList.add('hidden');
    document.querySelectorAll('.view').forEach(v => { if (v.id === 'view-dashboard') v.classList.remove('hidden'); });
  };

  window.connectGmail = function () { window.location.href = '/api/gmail/connect'; };

  window.disconnectGmail = async function () {
    if (!confirm('ยกเลิกการเชื่อมต่อ Gmail ใช่หรือไม่?')) return;
    await gmailFetch('/disconnect', { method: 'POST' });
    state.messages = [];
    await checkGmailStatus();
  };

  window.checkGmailStatus = async function () {
    ensureUI();
    const s = document.getElementById('gmailStatus');
    try {
      const d = await gmailFetch('/status');
      s.textContent = d.connected ? `เชื่อมต่อแล้ว: ${d.email || 'Gmail'}` : 'ยังไม่ได้เชื่อมต่อ Gmail';
      document.getElementById('gmailConnectBtn').style.display = d.connected ? 'none' : '';
      document.getElementById('gmailDisconnectBtn').style.display = d.connected ? '' : 'none';
      document.getElementById('gmailTools').style.display = d.connected ? '' : 'none';
      if (d.connected) {
        const box = document.getElementById('gmailResults');
        box.innerHTML = '<div style="padding:18px;border:1px solid #e5e7eb;border-radius:14px;color:#64748b">เชื่อมต่อ Gmail แล้ว เลือกเดือนและกด “ดึงอีเมลล่าสุด” เพื่อเริ่มค้นหา</div>';
      }
    } catch (e) { s.textContent = e.message; }
  };

  window.fetchGmailMessages = async function () {
    const box = document.getElementById('gmailResults');
    box.innerHTML = '<p>กำลังอ่านอีเมลและบันทึกรายการที่ตรวจสอบผ่านอัตโนมัติ...</p>';
    try {
      const rawQuery = document.getElementById('gmailQuery').value.trim();
      const month = document.getElementById('gmailMonth').value;
      const [y, m] = month.split('-').map(Number);
      const from = `${y}-${String(m).padStart(2,'0')}-01`;
      const next = new Date(y, m, 1);
      const to = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-01`;
      const params = new URLSearchParams({ from, to, limit: '100' });
      if (rawQuery) params.set('q', rawQuery);
      const d = await gmailFetch('/messages?' + params.toString());
      state.messages = [];
      state.scanned = d.scanned || 0;

      let saved = 0;
      let duplicates = 0;
      for (const m of (d.messages || [])) {
        if (m.confidence !== 'high') continue;
        try {
          const imported = await gmailFetch('/import', { method: 'POST', body: JSON.stringify({ candidate: m }) });
          if (imported.duplicate) duplicates++;
          else saved++;
        } catch (e) {
          state.messages.push({ ...m, importError: e.message });
        }
      }

      const scanInfo = document.getElementById('gmailScanInfo');
      scanInfo.innerHTML = `
        <span class="gmail-chip"><b>ทั้งหมด</b> ${state.scanned.toLocaleString()}</span>
        <span class="gmail-chip"><b>บันทึกใหม่</b> ${saved.toLocaleString()}</span>
        <span class="gmail-chip"><b>รายการซ้ำ</b> ${duplicates.toLocaleString()}</span>
        <span class="gmail-chip"><b>ต้องตรวจ</b> ${state.messages.length.toLocaleString()}</span>`;
      render();
      if (saved) {
        if (typeof loadDashboard === 'function') loadDashboard();
        if (typeof loadStats === 'function') loadStats('month');
      }
    } catch (e) { box.innerHTML = `<p style="color:#b91c1c">${esc(e.message)}</p>`; }
  };
  function bankName(bank) {
    return ({ ttb: 'ttb', kplus: 'K PLUS', scb: 'SCB' })[bank] || 'ไม่ทราบธนาคาร';
  }

  function render() {
    const box = document.getElementById('gmailResults');
    if (!state.messages.length) {
      box.innerHTML = `<div style="padding:20px;border:1px dashed #d1d5db;border-radius:14px">
        <strong>ไม่มีรายการที่ต้องตรวจสอบเพิ่ม</strong>
        <p style="margin-bottom:0;color:#64748b">รายการที่มีความมั่นใจสูงถูกบันทึกอัตโนมัติแล้ว ส่วนรายการที่ไม่แน่ใจจะไม่ถูกบันทึก เพื่อป้องกันยอดผิด</p>
      </div>`;
      return;
    }

    box.innerHTML = state.messages.map((m, i) => `
      <article style="padding:16px;border:1px solid #e5e7eb;border-radius:16px;margin-bottom:10px;background:#fff">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
          <div><strong>${esc(m.subject || '(ไม่มีหัวข้อ)')}</strong><div style="font-size:12px;color:#64748b;margin-top:4px">${esc(bankName(m.bank))} · ${esc(m.from)}</div></div>
          <strong style="white-space:nowrap">${Number(m.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท</strong>
        </div>
        <div style="font-size:13px;color:#6b7280;margin:6px 0">${esc(m.date || '')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">
          <span>${m.type === 'income' ? 'รายรับ' : 'รายจ่าย'}</span>
          <span>· ${esc(m.category)}</span>
          ${m.merchant ? `<span>· ${esc(m.merchant)}</span>` : ''}
          <span>· ความมั่นใจ ${m.confidence === 'high' ? 'สูง' : 'ปานกลาง'}</span>
        </div>
        <details><summary>รายละเอียดอีเมล</summary><p style="white-space:pre-wrap;font-size:13px;max-height:260px;overflow:auto">${esc(m.detail)}</p></details>
        <button onclick="importGmail(${i})" class="btn-primary" style="margin-top:10px">ตรวจสอบและบันทึกรายการ</button>
      </article>`).join('');
  }

  window.importGmail = async function (i) {
    const m = state.messages[i];
    if (!m?.amount) return;
    const type = m.type === 'income' ? 'รายรับ' : 'รายจ่าย';
    const ok = confirm(`ยืนยันรายการนี้หรือไม่?\n\n${type}: ${Number(m.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท\nธนาคาร: ${bankName(m.bank)}\n${m.merchant || m.category}\n\nระบบจะบันทึกเข้าบัญชีเมื่อกด OK`);
    if (!ok) return;
    try {
      await gmailFetch('/import', { method: 'POST', body: JSON.stringify({ candidate: m }) });
      alert('บันทึกรายการสำเร็จ');
      state.messages.splice(i, 1);
      render();
      if (typeof loadDashboard === 'function') loadDashboard();
      if (typeof loadStats === 'function') loadStats('month');
    } catch (e) { alert(e.message); }
  };

  document.addEventListener('DOMContentLoaded', () => {
    ensureUI();
    if (new URLSearchParams(location.search).get('gmail') === 'connected') openGmail();
  });
})();
