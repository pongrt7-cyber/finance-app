(() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = v => Number(v || 0).toLocaleString('th-TH',{minimumFractionDigits:2});
  const currentMonth = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
  const nextMonth = m => { const [y,mo]=m.split('-').map(Number); const d=new Date(y,mo,1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
  window.openGmailAudit = async function() {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'gmail'));
    let view = document.getElementById('gmailAuditView');
    if (!view) {
      document.getElementById('app').insertAdjacentHTML('beforeend', `<section id="gmailAuditView" class="view hidden"><div style="max-width:900px;margin:auto">
      <div class="gmail-page-head"><div><h2>Gmail Audit Center</h2><p>ตรวจสอบ Gmail ↔ Finance และค้นหารายการที่ตกหล่น</p></div><button class="btn-secondary" onclick="closeGmailAudit()">ปิด</button></div>
      <div class="card"><div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><div style="flex:1;min-width:150px"><label class="field-label">เดือนที่ตรวจสอบ</label><input id="auditMonth" type="month" class="field-input"></div><button class="btn-primary" onclick="runGmailAudit()">ตรวจสอบ</button><button class="btn-secondary" onclick="scanGmailAudit()">สแกน Gmail ใหม่</button></div></div>
      <div id="auditSummary"></div><div id="auditReconcile"></div><div id="auditIntegrity" class="card"></div>
      <div class="card"><div class="card-head"><p class="card-title">Gmail ที่พบแต่ยังไม่ได้นำเข้า</p></div><div id="auditCandidates"></div></div>
      <div class="card"><div class="card-head"><p class="card-title">ประวัติการนำเข้า</p></div><div id="auditItems"></div></div>
      </div></section>`);
      view = document.getElementById('gmailAuditView');
    }
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    view.classList.remove('hidden');
    document.getElementById('auditMonth').value = currentMonth();
    await runGmailAudit();
  };
  window.closeGmailAudit = function() {
    if (typeof window.openGmail === 'function') window.openGmail();
  };
  window.runGmailAudit = async function() {
    const month=document.getElementById('auditMonth')?.value || currentMonth();
    const [s,r,i] = await Promise.all([fetch(`/api/gmail-audit/summary?month=${month}`).then(x=>x.json()),fetch(`/api/gmail-audit/reconciliation?month=${month}`).then(x=>x.json()),fetch('/api/gmail-audit/integrity').then(x=>x.json())]);
    renderSummary(s); renderReconcile(r); renderIntegrity(i); await loadImported(month);
  };
  function renderSummary(s) { document.getElementById('auditSummary').innerHTML=`<div class="stat-grid"><div class="stat-cell"><p class="stat-label">รายจ่ายจาก Gmail</p><p class="stat-value mono">฿${money(s.importedExpenseTotal)}</p></div><div class="stat-cell"><p class="stat-label">ธุรกรรมที่ Import</p><p class="stat-value mono">${s.importedExpenses+s.importedIncome}</p></div><div class="stat-cell"><p class="stat-label">รายรับจาก Gmail</p><p class="stat-value mono">฿${money(s.importedIncomeTotal)}</p></div></div>`; }
  function renderReconcile(r) { const ok=r.missingCount===0; document.getElementById('auditReconcile').innerHTML=`<div class="card"><div class="card-head"><p class="card-title">Gmail ↔ Finance Reconciliation</p><span>${ok?'✓ ตรงกัน':'⚠️ มีรายการตกหล่น'}</span></div><p style="margin:5px 0">Finance จาก Gmail <b>${r.financeCount}</b> รายการ · ฿${money(r.financeTotal)}</p><p style="margin:5px 0">จับคู่ Gmail แล้ว <b>${r.matchedCount}</b> · ตกหล่น <b>${r.missingCount}</b> · ฿${money(r.missingTotal)}</p></div>`; }
  function renderIntegrity(i) { document.getElementById('auditIntegrity').innerHTML=`<div class="card-head"><p class="card-title">สถานะความถูกต้อง</p></div><p style="margin:5px 0">${i.orphanImportedEmails?'⚠️':'✓'} Orphan import: ${i.orphanImportedEmails}</p><p style="margin:5px 0">${i.duplicateGmailIds?'⚠️':'✓'} Gmail ID ซ้ำ: ${i.duplicateGmailIds} · ${i.duplicateFingerprints?'⚠️':'✓'} Fingerprint ซ้ำ: ${i.duplicateFingerprints}</p><p style="margin:5px 0">${i.gmailExpensesWithoutImport?'⚠️':'✓'} รายจ่าย Gmail ไม่มีประวัติ: ${i.gmailExpensesWithoutImport}</p>${i.legacyUnlinkedGmailExpenses?`<p style="margin:5px 0;color:var(--muted)">รายการ Gmail รุ่นเก่าก่อนเริ่มติดตามประวัติ: ${i.legacyUnlinkedGmailExpenses}</p>`:''}`; }
  async function loadImported(month) {
    const data=await fetch(`/api/gmail-audit/imported?month=${month}`).then(x=>x.json());
    document.getElementById('auditItems').innerHTML=(data.items||[]).map(x=>`<div style="padding:10px 0;border-bottom:1px dashed var(--hairline)"><div style="display:flex;justify-content:space-between;gap:8px"><span><b>${esc(x.merchant||'รายการ Gmail')}</b><small style="display:block;color:var(--muted)">${esc(x.kind)} · ${esc(x.expense_date||'')} · ${esc(x.imported_at||'')}</small></span><span><b class="mono">${x.expense_amount!=null?'฿'+money(x.expense_amount):'รายรับ'}</b><button class="btn-secondary" style="margin-left:8px;padding:4px 8px" onclick="removeGmailAudit(${x.id})">ตรวจใหม่</button></span></div></div>`).join('')||'<p class="empty-note">ยังไม่มีประวัติ</p>';
  }
  window.scanGmailAudit = async function() {
    const month=document.getElementById('auditMonth')?.value || currentMonth();
    const to=nextMonth(month);
    const box=document.getElementById('auditCandidates'); box.innerHTML='<p class="empty-note">กำลังสแกน Gmail...</p>';
    try {
      const r=await fetch(`/api/gmail/messages?from=${month}-01&to=${to}&limit=100`); const data=await r.json();
      if(!r.ok) throw new Error(data.error||'สแกน Gmail ไม่สำเร็จ');
      const candidates = [...(data.messages || []), ...(data.review || [])];
      box.innerHTML=candidates.map((x,n)=>`<div style="padding:10px 0;border-bottom:1px dashed var(--hairline)"><div style="display:flex;justify-content:space-between;gap:8px"><span><b>${esc(x.merchant||x.subject||'รายการ Gmail')}</b><small style="display:block;color:var(--muted)">${esc(x.date||'')} · ${esc(x.bank||'')} · ${esc(x.confidence||'')}</small></span><span><b class="mono">฿${money(x.amount)}</b><button class="btn-primary" style="margin-left:8px;padding:4px 8px" onclick='importGmailCandidate(${JSON.stringify(x).replace(/'/g,"&#39;")})'>นำเข้า</button></span></div><small style="color:var(--muted)">${esc(x.subject||'')}</small></div>`).join('')||'<p class="empty-note">ไม่พบ Gmail ที่พร้อมนำเข้า (รายการที่ Import แล้วจะไม่แสดง)</p>';
    } catch(e) { box.innerHTML=`<p style="color:var(--ink-red)">${esc(e.message)}</p>`; }
  };
  window.importGmailCandidate = async function(candidate) {
    const r=await fetch('/api/gmail/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({candidate})}); const data=await r.json();
    if(!r.ok) return alert(data.error||'นำเข้าไม่สำเร็จ');
    if(typeof showToast==='function') showToast(data.duplicate?'รายการนี้มีอยู่แล้ว':'นำเข้ารายการสำเร็จ');
    await runGmailAudit();
  };
  window.removeGmailAudit = async function(id) {
    if(!confirm('ลบเฉพาะประวัติ Import เพื่อให้ระบบสามารถตรวจ Gmail รายการนี้ใหม่ใช่ไหม?')) return;
    const r=await fetch(`/api/gmail-audit/imported/${id}`,{method:'DELETE'}); const data=await r.json();
    if(!r.ok) return alert(data.error||'ดำเนินการไม่สำเร็จ');
    await runGmailAudit();
  };
})();
