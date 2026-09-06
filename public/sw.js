// Service worker ขั้นต่ำ — แค่ให้ browser มองว่าแอปนี้ installable
// ไม่ทำ offline cache (ข้อมูลต้องออนไลน์เสมออยู่แล้ว เพราะเป็น server-based app)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', () => {}); // no-op, ปล่อยผ่านไป network ปกติ
