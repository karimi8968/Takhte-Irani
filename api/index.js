const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// دریافت اطلاعات از Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.DB_URL
  });
}

const db = admin.database();
const bot = new Telegraf(BOT_TOKEN);

// تابع تولید کد تصادفی ۴ رقمی
function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// --- تابع پاکسازی کدهای منقضی شده ---
async function clearExpiredCodes() {
    try {
        const ref = db.ref('auth_codes');
        const snapshot = await ref.once('value');
        
        if (!snapshot.exists()) return;

        const now = Date.now();
        const updates = {};
        let hasExpired = false;

        snapshot.forEach((child) => {
            const data = child.val();
            if (data.expires_at && data.expires_at < now) {
                updates[child.key] = null; 
                hasExpired = true;
            }
        });

        if (hasExpired) {
            await ref.update(updates);
            console.log('Expired codes cleaned up.');
        }
    } catch (error) {
        console.error('Error cleaning expired codes:', error);
    }
}

// --- سیستم ارسال نوتیفیکیشن تلگرامی ---
// این بخش دیتابیس را گوش می‌دهد تا اگر درخواستی ثبت شد، پیام بفرستد
db.ref('pending_notifications').on('child_added', async (snapshot) => {
    const notification = snapshot.val();
    const key = snapshot.key;

    if (notification && notification.target_id && notification.message) {
        try {
            // ارسال پیام به تلگرام کاربر
            await bot.telegram.sendMessage(
                notification.target_id, 
                `🎮 *درخواست بازی جدید*\n\n${notification.message}\n\n👇 همین الان وارد بازی شو!`, 
                { parse_mode: 'Markdown' }
            );
            
            // حذف درخواست از صف پس از ارسال موفق
            await db.ref(`pending_notifications/${key}`).remove();
        } catch (error) {
            console.error(`Failed to send message to ${notification.target_id}:`, error);
            // در صورت خطا هم حذف میکنیم تا لوپ ایجاد نشود (مثلا اگر کاربر ربات را بلاک کرده باشد)
            await db.ref(`pending_notifications/${key}`).remove();
        }
    } else {
        // اگر دیتا ناقص بود حذف کن
        if (key) await db.ref(`pending_notifications/${key}`).remove();
    }
});

// --- منطق ربات ---
bot.start(async (ctx) => {
    const user = ctx.from;
    clearExpiredCodes(); 

    const code = generateCode();
    const expiresAt = Date.now() + (5 * 60 * 1000); 

    await db.ref(`auth_codes/${code}`).set({
        telegram_id: user.id,
        first_name: user.first_name,
        username: user.username || '',
        expires_at: expiresAt
    });

    await ctx.reply(
        `🔐 کد ورود شما: \`${code}\`\n\n⏳ این کد تا ۵ دقیقه اعتبار دارد.\n\n✅ حالا به بازی برگردید و کد را وارد کنید.`, 
        { parse_mode: 'Markdown' }
    );
});

// --- وب‌هوک ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).json({ ok: true });
        } else {
            res.status(200).send('Bot is Active & Notification System Running!');
        }
    } catch (e) {
        console.error(e);
        res.status(500).send('Error processing update');
    }
};
