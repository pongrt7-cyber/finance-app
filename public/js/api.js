const API = {
  base: '/api',
  token: localStorage.getItem('token') || null,

  async request(method, path, body, isFormData = false) {
    const headers = {};
    if (!isFormData) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body ? (isFormData ? body : JSON.stringify(body)) : undefined
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาเปิด Finance App ที่ http://localhost:3000 แล้วลองใหม่');
      }
      throw error;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
    return data;
  },

  get(path) { return this.request('GET', path); },
  post(path, body, isFormData) { return this.request('POST', path, body, isFormData); },
  put(path, body) { return this.request('PUT', path, body); },
  del(path) { return this.request('DELETE', path); },

  setToken(t) { this.token = t; localStorage.setItem('token', t); }
};
