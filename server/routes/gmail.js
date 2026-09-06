const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const db = require('..//db');

const router = express.Router();
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/gmail/oauth2callback';

function oauthClient() { return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI); }
function key() { return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'finance-app-secret').digest(); }
function seal(value) { const iv=crypto.randomBytes(12); const c=crypto.createCipheriv('aes-256-gcm',key(),iv); const enc=Buffer.concat([c.update(value,'utf8'),c.final()]); return [iv.toString('base64url'),c.getAuthTag().toString('base64url'),enc.toString('base64url')].join('.'); }
function unseal(value) { const [iv,tag,data]=String(value).split('.'); const d=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url')); d.setAuthTag(Buffer.from(tag,'base64url')); return Buffer.concat([d.update(Buffer.from(data,'base64url')),d.final()]).toString('utf8'); }
function saveToken(token) { db.prepare("INSERT INTO settings(key,value) VALUES('gmail_oauth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(seal(JSON.stringify(token))); }
function loadToken() { const row=db.prepare("SELECT value FROM settings WHERE key='gmail_oauth'").get(); return row ? JSON.parse(unseal(row.value)) : null; }
function header(headers,name) { return headers.find(h=>h.name.toLowerCase()===name.toLowerCase())?.value || ''; }
function decodePart(data='') { return Buffer.from(data.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); }
function htmlText(input='') { return input.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim(); }
function bodyFromPayload(p) { if(!p)return ''; if(p.mimeType==='text/plain'&&p.body?.data)return decodePart(p.body.data); if(p.mimeType==='text/html'&&p.body?.data)return htmlText(decodePart(p.body.data)); return (p.parts||[]).map(bodyFromPayload).find(Boolean)||''; }

function parseAmount(text='') {
  const clean=text.replace(/\u00a0/g,' ').replace(/\s+/g,' ');
  const patterns=[
    /(?:ยอด(?:ชำระ|รวม|เงิน)?|จำนวนเงิน|amount|total|paid|payment|transaction amount|debit|credit)[^0-9]{0,35}(?:฿|THB|บาท)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/gi,
    /(?:฿|THB|บาท)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/gi
  ];
  for(const re of patterns){ const vals=[...clean.matchAll(re)].map(m=>Number(m[1].replace(/,/g,''))).filter(v=>v>0&&v<10000000); if(vals.length)return Math.max(...vals); }
  return null;
}
function transactionScore(subject,body) {
  const t=(subject+' '+body).toLowerCase(); let score=0;
  if(/payment|purchase|transaction|receipt|invoice|paid|debit|credit|transfer|refund|cashback|salary|deposit|amount|total|ชำระ|ซื้อ|รายการ|ใบเสร็จ|หักบัญชี|โอนเงิน|เงินเข้า|เงินเดือน|ยอด/.test(t))score+=2;
  if(parseAmount(t)!=null)score+=2;
  if(/otp|verification|login|password|newsletter|unsubscribe|promotion|โปรโมชั่น/.test(t))score-=3;
  return score;
}
function classify(subject,body) {
  const t=(subject+' '+body).toLowerCase();
  if(/7-eleven|lotus|big c|makro|tops|food|restaurant|cafe|coffee|grabfood|lineman|อาหาร|ร้าน|กาแฟ|ข้าว/.test(t))return 'ค่าอาหาร';
  if(/shopee|lazada|amazon|shopping|สินค้า|สั่งซื้อ/.test(t))return 'ของใช้';
  if(/gas|fuel|ptt|น้ำมัน|เติมน้ำมัน/.test(t))return 'ค่าน้ำมัน';
  if(/netflix|spotify|youtube|subscription|สมาชิก/.test(t))return 'บันเทิง';
  if(/phone|mobile|internet|ais|true|dtac|โทรศัพท์|อินเทอร์เน็ต/.test(t))return 'ค่าเน็ต';
  if(/rent|ห้อง|ค่าเช่า/.test(t))return 'ค่าห้อง';
  return 'อื่นๆ';
}
function merchant(subject,body) {
  const t=subject+' '+body; const m=t.match(/(?:ร้านค้า|merchant|ร้าน)[:\s]+([^\n|]{2,60})/i); if(m)return m[1].trim().replace(/[.。]+$/,'');
  const known=['7-Eleven','Shopee','Lazada','Grab','LINE MAN','Netflix','Spotify','AIS','True','dtac','PTT','Lotus','Big C','Makro'];
  return known.find(x=>t.toLowerCase().includes(x.toLowerCase()))||'';
}
function toCandidate(message) {
  const h=message.payload?.headers||[]; const subject=header(h,'Subject'); const from=header(h,'From'); const date=header(h,'Date'); const body=bodyFromPayload(message.payload); const text=subject+' '+body;
  const amount=parseAmount(text); const score=transactionScore(subject,body);
  const income=/refund|cashback|เงินเข้า|ได้รับเงิน|โอนเข้า|deposit|credited|salary|เงินเดือน|incoming/i.test(text);
  const expense=/payment|purchase|paid|debit|ชำระ|ซื้อ|หักบัญชี|โอนออก|outgoing/i.test(text);
  const type=income?'income':expense?'expense':null;
  return {id:message.id,threadId:message.threadId,subject,from,date,amount,type,merchant:merchant(subject,body),category:classify(subject,body),detail:body.slice(0,700),score};
}

router.get('/status',(req,res)=>res.json({connected:!!loadToken(),email:db.prepare("SELECT value FROM settings WHERE key='gmail_email'").get()?.value||null}));
router.get('/connect',(req,res)=>{ if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)return res.status(500).json({error:'ยังไม่ได้ตั้ง GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET'}); res.redirect(oauthClient().generateAuthUrl({access_type:'offline',prompt:'consent',scope:SCOPES})); });
router.get('/oauth2callback',async(req,res)=>{try{const c=oauthClient();const {tokens}=await c.getToken(req.query.code);c.setCredentials(tokens);saveToken(tokens);const gmail=google.gmail({version:'v1',auth:c});const profile=await gmail.users.getProfile({userId:'me'});db.prepare("INSERT INTO settings(key,value) VALUES('gmail_email',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(profile.data.emailAddress||'');res.redirect('/?gmail=connected')}catch(e){console.error(e);res.status(500).send('Gmail connection failed')}});
router.post('/disconnect',(req,res)=>{db.prepare("DELETE FROM settings WHERE key IN ('gmail_oauth','gmail_email')").run();res.json({success:true})});

router.get('/messages',async(req,res)=>{
  try{
    const token=loadToken(); if(!token)return res.status(401).json({error:'ยังไม่ได้เชื่อมต่อ Gmail'});
    const c=oauthClient();c.setCredentials(token);const gmail=google.gmail({version:'v1',auth:c});
    const requested=String(req.query.q||'').trim();
    const queries=requested?[requested]:[
      'newer_than:90d {payment purchase transaction receipt invoice paid debit credit transfer refund cashback salary deposit}',
      'newer_than:90d {THB amount total payment}',
      'newer_than:90d {ชำระ ซื้อ รายการ ใบเสร็จ หักบัญชี โอนเงิน เงินเข้า เงินเดือน}'
    ];
    const ids=new Map();
    for(const q of queries){const list=await gmail.users.messages.list({userId:'me',q,maxResults:50});for(const m of(list.data.messages||[]))ids.set(m.id,m)}
    let messages=[];
    for(const m of ids.values()){const full=await gmail.users.messages.get({userId:'me',id:m.id,format:'full'});const candidate=toCandidate(full.data);if(candidate.amount!=null&&candidate.type&&candidate.score>=2)messages.push(candidate)}
    if(!messages.length&&!requested){
      const list=await gmail.users.messages.list({userId:'me',q:'newer_than:180d',maxResults:50});
      for(const m of(list.data.messages||[]))ids.set(m.id,m);
      messages=[];for(const m of ids.values()){const full=await gmail.users.messages.get({userId:'me',id:m.id,format:'full'});const candidate=toCandidate(full.data);if(candidate.amount!=null&&candidate.type&&candidate.score>=2)messages.push(candidate)}
    }
    messages.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
    res.json({messages,scanned:ids.size});
  }catch(e){console.error(e);res.status(500).json({error:'ดึงอีเมลไม่สำเร็จ',detail:e.message})}
});

router.post('/import',async(req,res)=>{const {candidate}=req.body||{};if(!candidate?.id||!candidate.amount||!['expense','income'].includes(candidate.type))return res.status(400).json({error:'ข้อมูลรายการไม่ครบ'});try{const exists=db.prepare('SELECT id FROM imported_emails WHERE gmail_id=?').get(candidate.id);if(exists)return res.status(409).json({error:'อีเมลนี้ถูกนำเข้าแล้ว'});if(candidate.type==='income'){const month=(candidate.date?new Date(candidate.date):new Date()).toISOString().slice(0,7);const row=db.prepare('SELECT * FROM income WHERE month=?').get(month);if(row)db.prepare('UPDATE income SET amount=amount+? WHERE month=?').run(candidate.amount,month);else db.prepare('INSERT INTO income(amount,month,locked) VALUES(?,?,1)').run(candidate.amount,month);db.prepare('INSERT INTO imported_emails(gmail_id,kind,source) VALUES(?,?,?)').run(candidate.id,'income','gmail');return res.json({success:true,type:'income'})}const cat=db.prepare('SELECT id FROM categories WHERE name=?').get(candidate.category)||db.prepare("SELECT id FROM categories WHERE name='อื่นๆ'").get();const date=new Date(candidate.date||Date.now());const dateText=Number.isNaN(date.getTime())?new Date().toISOString().slice(0,10):date.toISOString().slice(0,10);const info=db.prepare('INSERT INTO expenses(amount,category_id,merchant,note,expense_date,source) VALUES(?,?,?,?,?,?)').run(candidate.amount,cat.id,candidate.merchant||null,candidate.detail||null,dateText,'gmail');db.prepare('INSERT INTO imported_emails(gmail_id,kind,expense_id,source) VALUES(?,?,?,?)').run(candidate.id,'expense',info.lastInsertRowid,'gmail');res.json({success:true,type:'expense',id:Number(info.lastInsertRowid)})}catch(e){console.error(e);res.status(500).json({error:'บันทึกรายการไม่สำเร็จ',detail:e.message})}});
module.exports=router;
