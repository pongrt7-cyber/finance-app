(() => {
  const esc = (v = '') => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { messages: [], review: [], scanned: 0, scanning: false, scanId: null, progressTimer: null, elapsedTimer: null, cooldownTimer: null, cooldownUntil: 0, scanStartedAt: 0 };

  async function gmailFetch(path, options = {}) {
    const res = await fetch('/api/gmail' + path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        const retry = Number(res.headers.get('Retry-After') || 0);
        const suffix = retry > 0 ? ` ลองใหม่ในประมาณ ${retry} วินาที` : '';
        const error = new Error((data.error || 'Gmail ถูกจำกัดชั่วคราว') + suffix);
        error.status = 429;
        error.retryAfter = retry;
        throw error;
      }
      const error = new Error(data.error || 'Gmail error');
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function ensureUI() {
    if (document.getElementById('gmailView')) return;
    document.getElementById('app').insertAdjacentHTML('beforeend', `
      <section id="gmailView" class="view hidden">
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
                <button onclick="fetchGmailMessages()" class="btn-secondary gmail-load-btn">สแกนเดือนนี้</button>
              </div>
              <input id="gmailQuery" class="field-input gmail-query-input" value="" placeholder="ตัวกรองเพิ่มเติม (ไม่บังคับ) เช่น from:scb.co.th">
              <button onclick="fetchGmailMessages()" class="gmail-fetch-btn">สแกนและนำเข้าอัตโนมัติ</button>
              <button onclick="openGmailAudit()" class="btn-secondary" style="margin:0">เปิด Gmail Audit Center</button>
            </div>
            <div id="gmailScanProgress" class="gmail-scan-progress hidden" aria-live="polite">
              <div class="gmail-progress-head">
                <div class="gmail-progress-spinner" aria-hidden="true"></div>
                <div class="gmail-progress-copy">
                  <strong id="gmailProgressStage">กำลังเตรียมการ</strong>
                  <span id="gmailProgressMessage">กำลังเตรียมค้นหา Gmail...</span>
                </div>
                <span id="gmailProgressPercent" class="gmail-progress-percent">0%</span>
              </div>
              <div class="gmail-progress-track"><div id="gmailProgressBar" class="gmail-progress-bar"></div></div>
              <div class="gmail-progress-foot">
                <span id="gmailProgressCount">กำลังเริ่ม</span>
                <span id="gmailProgressElapsed">0:00</span>
              </div>
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
    for (let i = 0; i < 60; i++) {
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
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'gmail'));
    await checkGmailStatus();
  };

  window.closeGmail = function () {
    if (typeof switchView === 'function') switchView('dashboard');
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
        box.innerHTML = '<div style="padding:18px;border:1px solid #e5e7eb;border-radius:14px;color:#64748b">เชื่อมต่อ Gmail แล้ว เลือกเดือนและกด “สแกนและนำเข้าอัตโนมัติ” เพื่อเริ่มค้นหา</div>';
      }
    } catch (e) { s.textContent = e.message; }
  };

  function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function setScanBusy(busy) {
    state.scanning = busy;
    document.querySelectorAll('.gmail-load-btn, .gmail-fetch-btn').forEach(btn => {
      btn.disabled = busy;
      btn.classList.toggle('is-scanning', busy);
    });
    const month = document.getElementById('gmailMonth');
    const query = document.getElementById('gmailQuery');
    if (month) month.disabled = busy;
    if (query) query.disabled = busy;
  }

  function showScanProgress(show = true) {
    document.getElementById('gmailScanProgress')?.classList.toggle('hidden', !show);
  }

  function renderScanProgress(p = {}) {
    const panel = document.getElementById('gmailScanProgress');
    const spinner = document.querySelector('.gmail-progress-spinner');
    if (spinner) spinner.classList.toggle('hidden', p.status !== 'running' && p.status !== 'rate_limited');
    if (!panel) return;
    const percent = Math.max(0, Math.min(100, Number(p.percent || 0)));
    const stage = p.stage || 'กำลังทำงาน';
    let message = p.message || 'กำลังทำงาน...';
    let count = p.total ? `${Number(p.current || 0).toLocaleString()}/${Number(p.total).toLocaleString()}` : 'กำลังเริ่ม';
    let timerText = state.scanStartedAt ? formatElapsed(Date.now() - state.scanStartedAt) : '0:00';

    if (p.status === 'rate_limited') {
      message = p.message || 'Gmail จำกัดการใช้งานชั่วคราว';
      const retry = Math.max(0, Number(p.retryAfter || 0));
      if (retry && !state.cooldownUntil) state.cooldownUntil = Date.now() + retry * 1000;
      const remaining = state.cooldownUntil ? Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000)) : retry;
      count = remaining ? `ลองใหม่ได้ใน ${remaining} วินาที` : 'ลองสแกนใหม่ได้แล้ว';
      panel.classList.add('rate-limited');
      document.getElementById('gmailProgressSpinner')?.classList.remove('hidden');
    } else {
      panel.classList.remove('rate-limited');
    }

    document.getElementById('gmailProgressStage').textContent = stage;
    document.getElementById('gmailProgressMessage').textContent = message;
    document.querySelectorAll('.gmail-load-btn, .gmail-fetch-btn').forEach(btn => {
      if (!btn.dataset.defaultText) btn.dataset.defaultText = btn.textContent;
      if (p.status === 'rate_limited' && state.cooldownUntil) btn.textContent = `รอ ${Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000))} วิ`;
      else if (p.status === 'running') btn.textContent = 'กำลังสแกน...';
      else btn.textContent = btn.dataset.defaultText;
    });
    document.getElementById('gmailProgressPercent').textContent = `${percent}%`;
    document.getElementById('gmailProgressBar').style.width = `${percent}%`;
    document.getElementById('gmailProgressCount').textContent = count;
    document.getElementById('gmailProgressElapsed').textContent = timerText;
  }

  async function pollScanProgress(scanId) {
    if (state.progressTimer) clearInterval(state.progressTimer);
    const tick = async () => {
      if (!state.scanning) return;
      try {
        const p = await gmailFetchProgress(scanId);
        renderScanProgress(p);
        if (p.status === 'done' || p.status === 'error' || p.status === 'rate_limited') {
          clearInterval(state.progressTimer);
          state.progressTimer = null;
        }
      } catch {
        // The main request is still authoritative. Keep the animated timer alive.
      }
    };
    await tick();
    state.progressTimer = setInterval(tick, 500);
  }

  async function gmailFetchProgress(scanId) {
    const res = await fetch('/api/gmail/scan-progress?scanId=' + encodeURIComponent(scanId));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'progress unavailable');
    return data;
  }

  function startCooldownCountdown(seconds) {
    if (state.cooldownTimer) clearInterval(state.cooldownTimer);
    state.cooldownUntil = Date.now() + Math.max(0, Number(seconds || 0)) * 1000;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000));
      renderScanProgress({
        status: 'rate_limited',
        stage: 'พักการยิงคำขอ',
        message: 'Gmail ถูกจำกัดชั่วคราว ระบบหยุดส่งคำขอซ้ำ',
        percent: 100,
        retryAfter: remaining
      });
      if (!remaining) {
        clearInterval(state.cooldownTimer);
        state.cooldownTimer = null;
        state.cooldownUntil = 0;
        state.scanning = false;
        renderScanProgress({
          status: 'done',
          stage: 'พร้อมสแกน',
          message: 'หมดช่วงพักแล้ว สามารถสแกน Gmail ใหม่ได้',
          percent: 100,
          current: 0,
          total: 0
        });
        setScanBusy(false);
      }
    };
    tick();
    state.cooldownTimer = setInterval(tick, 500);
  }

  window.fetchGmailMessages = async function () {
    if (state.scanning) return;
    if (state.cooldownUntil && Date.now() < state.cooldownUntil) return;
    const box = document.getElementById('gmailResults');
    box.innerHTML = '<p>กำลังเริ่มสแกน Gmail...</p>';
    setScanBusy(true);
    showScanProgress(true);
    state.cooldownUntil = 0;
    if (state.cooldownTimer) clearInterval(state.cooldownTimer);
    state.cooldownTimer = null;
    state.scanId = crypto.randomUUID();
    state.scanStartedAt = Date.now();
    renderScanProgress({ status: 'running', stage: 'เตรียมการ', message: 'กำลังเริ่มสแกน Gmail...', percent: 2, current: 0, total: 0 });
    state.elapsedTimer = setInterval(() => {
      if (state.scanning) renderScanProgress({ status: 'running', stage: document.getElementById('gmailProgressStage')?.textContent, message: document.getElementById('gmailProgressMessage')?.textContent, percent: Number((document.getElementById('gmailProgressPercent')?.textContent || '0').replace('%','')) });
    }, 1000);
    try {
      const rawQuery = document.getElementById('gmailQuery').value.trim();
      const month = document.getElementById('gmailMonth').value;
      const [y, m] = month.split('-').map(Number);
      const from = `${y}-${String(m).padStart(2,'0')}-01`;
      const next = new Date(y, m, 1);
      const to = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-01`;
      const params = new URLSearchParams({ from, to, limit: '100' });
      if (rawQuery) params.set('q', rawQuery);
      const scanRequest = gmailFetch('/messages?' + params.toString(), {
        headers: { 'Content-Type': 'application/json', 'X-Scan-Id': state.scanId }
      });
      // Start polling shortly after the main request is sent so the backend has time
      // to create the progress record. Avoids a noisy initial 404 race in DevTools.
      setTimeout(() => {
        if (state.scanning) pollScanProgress(state.scanId);
      }, 150);
      const d = await scanRequest;
      state.messages = (Array.isArray(d.review) ? d.review : []).map(m => ({ ...m, reviewOnly: true }));
      state.review = [];
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

      state.scanning = false;
      const scanInfo = document.getElementById('gmailScanInfo');
      scanInfo.innerHTML = `
        <span class="gmail-chip"><b>อีเมลที่พบ</b> ${state.scanned.toLocaleString()}</span>
        <span class="gmail-chip"><b>บันทึกใหม่</b> ${saved.toLocaleString()}</span>
        <span class="gmail-chip"><b>รายการซ้ำ</b> ${duplicates.toLocaleString()}</span>
        <span class="gmail-chip"><b>ต้องตรวจ</b> ${state.messages.length.toLocaleString()}</span>`;
      renderScanProgress({
        status: 'done',
        stage: 'เสร็จสิ้น',
        message: 'สแกนเสร็จแล้ว พบ ' + state.scanned.toLocaleString() + ' อีเมล · ต้องตรวจ ' + state.messages.length.toLocaleString() + ' รายการ',
        percent: 100,
        current: state.scanned,
        total: state.scanned
      });
      render();
      if (saved) {
        if (typeof loadDashboard === 'function') loadDashboard();
        if (typeof loadStats === 'function') loadStats('month');
      }
    } catch (e) {
      if (e.status === 429) {
        renderScanProgress({
          status: 'rate_limited',
          stage: 'พักการยิงคำขอ',
          message: e.message.split(' ลองใหม่ในประมาณ')[0],
          percent: 100,
          retryAfter: e.retryAfter || 0,
          current: 0,
          total: 0
        });
        startCooldownCountdown(e.retryAfter || 0);
      } else {
        box.innerHTML = `<p style="color:#b91c1c">${esc(e.message)}</p>`;
      }
    } finally {
      const keepCooldownBusy = state.cooldownUntil && state.cooldownUntil > Date.now();
      if (!keepCooldownBusy) setScanBusy(false);
      if (state.elapsedTimer) clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
      if (!keepCooldownBusy) state.scanning = false;
    }
  };
  function bankName(bank) {
    return ({ ttb: 'ttb', kplus: 'K PLUS', scb: 'SCB' })[bank] || 'ไม่ทราบธนาคาร';
  }

  function render() {
    const box = document.getElementById('gmailResults');
    const reviewItems = state.review || [];
    if (!state.messages.length && !reviewItems.length) {
      box.innerHTML = `<div style="padding:20px;border:1px dashed #d1d5db;border-radius:14px">
        <strong>นำเข้ารายการเสร็จแล้ว</strong>
        <p style="margin:6px 0 0;color:#64748b">รายการที่มั่นใจสูงถูกบันทึกอัตโนมัติแล้ว รายการที่ยังไม่มั่นใจจะแสดงให้ตรวจสอบก่อนบันทึก</p>
      </div>`;
      return;
    }

    box.innerHTML = '<div style="font-weight:700;color:#1E2A44;margin:4px 0 10px">รายการที่ควรตรวจสอบก่อนบันทึก</div>' + state.messages.map((m, i) => `
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
          <span>· ความมั่นใจ ${m.confidence === 'high' ? 'สูง' : m.confidence === 'medium' ? 'ปานกลาง' : 'ต่ำ'}</span>
          ${m.reviewOnly ? '<span>· ต้องตรวจสอบ</span>' : ''}
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
      const result = await gmailFetch('/import', { method: 'POST', body: JSON.stringify({ candidate: m }) });
      alert(result.duplicate ? 'รายการนี้มีอยู่แล้ว' : 'บันทึกรายการสำเร็จ');
      state.messages = state.messages.filter(x => x !== m);
      state.review = state.review.filter(x => x !== m);
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
