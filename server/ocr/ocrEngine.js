const { createWorker } = require('tesseract.js');

// อ่านข้อความจากรูปด้วย Tesseract.js (pure JS, ไม่ต้องพึ่ง Python/native library)
async function runTesseractOcr(imagePath) {
  const worker = await createWorker(['tha', 'eng']);
  try {
    const { data } = await worker.recognize(imagePath);
    return data.text.split('\n').map(l => l.trim()).filter(Boolean);
  } finally {
    await worker.terminate();
  }
}

module.exports = { runTesseractOcr };
