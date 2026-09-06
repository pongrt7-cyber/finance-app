async function loadAdminStats() {
    try {
        const stats = await API.get('/admin/stats');
        document.getElementById('adminTotalExpenses').textContent = '฿' + Number(stats.totalExpenses).toLocaleString();
        document.getElementById('adminTotalIncome').textContent = '฿' + Number(stats.totalIncome).toLocaleString();
    } catch (e) {
        console.error('Error loading admin stats:', e);
    }
}

async function resetData() {
    if (!confirm('คุณแน่ใจหรือไม่ว่าต้องการล้างข้อมูลทั้งหมด? การกระทำนี้ไม่สามารถย้อนกลับได้')) return;
    try {
        await API.post('/admin/reset');
        alert('ล้างข้อมูลสำเร็จ');
        loadAdminStats();
    } catch (e) {
        console.error('Error resetting data:', e);
        alert('เกิดข้อผิดพลาดในการล้างข้อมูล');
    }
}

loadAdminStats();
