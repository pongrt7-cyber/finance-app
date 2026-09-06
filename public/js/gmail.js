(() => {
  const esc = (v='') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = { messages: [] };
  async function gmailFetch(path, options={}) {
    const res = await fetch('/api/gmail' + path, {headers:{'Content-Type':'application/json'}, ...options});
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || 'Gmail error');
    return data;
  }
  function ensureUI(){
    if(document.getElementById('gmailView')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <button id="gmailFloatingBtn" onclick="openGmail()" style="position:fixed;right:18px;bottom:78px;z-index:50;border:0;border-radius:999px;padding:11px 16px;background:#111827;color:#fff;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,.18)">Gmail</button>
      <section id="gmailView" class="view hidden" style="position:fixed;inset:0;z-index:45;background:#fff;overflow:auto;padding:20px 16px 110px">
        <div style="max-width:900px;margin:auto">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px"><div><h2 style="margin:0">Gmail → รายการการเงิน</h2><p id="gmailStatus" style="margin:5px 0;color:#6b7280">กำลังตรวจสอบ...</p></div><button onclick="closeGmail()" class="btn-secondary">ปิด</button></div>
          <div id="gmailConnectBox" style="padding:18px;border:1px solid #e5e7eb;border-radius:16px;margin-bottom:18px">
            <p style="margin-top:0">เชื่อม Gmail แบบอ่านอย่างเดียว ระบบจะอ่านอีเมลเพื่อหาเงินที่จ่าย/รับ แล้วให้ตรวจสอบก่อนบันทึก</p>
            <button id="gmailConnectBtn" onclick="connectGmail()" class="btn-primary">เชื่อมต่อ Gmail</button>
            <button id="gmailDisconnectBtn" onclick="disconnectGmail()" class="btn-secondary" style="display:none">ยกเลิกการเชื่อมต่อ</button>
          </div>
          <div id="gmailTools" style="display:none">
            <div style="display:flex;gap:8px;margin-bottom:14px"><input id="gmailQuery" class="field-input" style="flex:1" value="newer_than:90d" placeholder="เช่น newer_than:30d from:bank@example.com"><button onclick="fetchGmailMessages()" class="btn-primary">ดึงอีเมล</button></div>
            <div id="gmailResults"></div>
          </div>
        </div>
      </section>`);
  }
  window.openGmail = async function(){ ensureUI(); document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden')); document.getElementById('gmailView').classList.remove('hidden'); await checkGmailStatus(); };
  window.closeGmail = function(){ document.getElementById('gmailView')?.classList.add('hidden'); document.querySelectorAll('.view').forEach(v=>{if(v.id==='view-dashboard')v.classList.remove('hidden')}); };
  window.connectGmail = function(){ window.location.href='/api/gmail/connect'; };
  window.disconnectGmail = async function(){ if(!confirm('ยกเลิกการเชื่อมต่อ Gmail?')) return; await gmailFetch('/disconnect',{method:'POST'}); await checkGmailStatus(); };
  window.checkGmailStatus = async function(){
    ensureUI(); const s=document.getElementById('gmailStatus');
    try { const d=await gmailFetch('/status'); s.textContent=d.connected ? `เชื่อมต่อแล้ว: ${d.email||'Gmail'}` : 'ยังไม่ได้เชื่อมต่อ Gmail'; document.getElementById('gmailConnectBtn').style.display=d.connected?'none':''; document.getElementById('gmailDisconnectBtn').style.display=d.connected?'':'none'; document.getElementById('gmailTools').style.display=d.connected?'':'none'; if(d.connected && !state.messages.length) fetchGmailMessages(); } catch(e){ s.textContent=e.message; }
  };
  window.fetchGmailMessages = async function(){
    const box=document.getElementById('gmailResults'); box.innerHTML='<p>กำลังอ่านอีเมล...</p>';
    try { const q=encodeURIComponent(document.getElementById('gmailQuery').value||'newer_than:90d'); const d=await gmailFetch('/messages?q='+q+'&limit=30'); state.messages=d.messages||[]; render(); } catch(e){ box.innerHTML=`<p style="color:#b91c1c">${esc(e.message)}</p>`; }
  };
  function render(){
    const box=document.getElementById('gmailResults');
    if(!state.messages.length){ box.innerHTML='<div style="padding:20px;border:1px dashed #d1d5db;border-radius:14px">ไม่พบอีเมลที่เข้าเงื่อนไข</div>'; return; }
    box.innerHTML=state.messages.map((m,i)=>`<article style="padding:16px;border:1px solid #e5e7eb;border-radius:16px;margin-bottom:10px;background:#fff"><div style="display:flex;justify-content:space-between;gap:12px"><strong>${esc(m.subject||'(ไม่มีหัวข้อ)')}</strong><strong>${m.amount?Number(m.amount).toLocaleString('th-TH',{minimumFractionDigits:2}):'ไม่พบยอดเงิน'} บาท</strong></div><div style="font-size:13px;color:#6b7280;margin:6px 0">${esc(m.from)} · ${esc(m.date)}</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0"><span>${m.type==='income'?'รายรับ':'รายจ่าย'}</span><span>· ${esc(m.category)}</span>${m.merchant?`<span>· ${esc(m.merchant)}</span>`:''}</div><details><summary>รายละเอียดอีเมล</summary><p style="white-space:pre-wrap;font-size:13px">${esc(m.detail)}</p></details><button onclick="importGmail(${i})" class="btn-primary" style="margin-top:10px" ${m.amount?'':'disabled'}>ตรวจสอบและบันทึกรายการ</button></article>`).join('');
  }
  window.importGmail = async function(i){
    const m=state.messages[i]; if(!m.amount) return;
    const type=m.type==='income'?'รายรับ':'รายจ่าย'; const ok=confirm(`บันทึกเป็น${type}\n${m.amount.toLocaleString()} บาท\n${m.merchant||m.category||''}\n\nถ้าข้อมูลถูกต้องกด OK`); if(!ok) return;
    try { await gmailFetch('/import',{method:'POST',body:JSON.stringify({candidate:m})}); alert('บันทึกรายการแล้ว'); state.messages.splice(i,1); render(); if(typeof loadDashboard==='function') loadDashboard(); if(typeof loadStats==='function') loadStats('month'); } catch(e){ alert(e.message); }
  };
  document.addEventListener('DOMContentLoaded',()=>{ ensureUI(); if(new URLSearchParams(location.search).get('gmail')==='connected') openGmail(); });
})();
