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

// --- تابع پاکسازی کدهای منقضی شده (ضروری برای تمیز ماندن دیتابیس) ---
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
            // اگر زمان انقضا گذشته است، آن را لیست کن
            if (data.expires_at && data.expires_at < now) {
                updates[child.key] = null; 
                hasExpired = true;
            }
        });

        // حذف یکجای همه کدهای باطل شده
        if (hasExpired) {
            await ref.update(updates);
            console.log('Expired codes cleaned up.');
        }
    } catch (error) {
        console.error('Error cleaning expired codes:', error);
    }
}

// --- منطق ربات ---
bot.start(async (ctx) => {
    const user = ctx.from;
    
    // پاکسازی کدهای قدیمی قبل از تولید کد جدید
    clearExpiredCodes(); 

    const code = generateCode();
    
    // اعتبار ۵ دقیقه
    const expiresAt = Date.now() + (5 * 60 * 1000); 

    await db.ref(`auth_codes/${code}`).set({
        telegram_id: user.id,
        first_name: user.first_name,
        username: user.username || '',
        expires_at: expiresAt
    });

    await ctx.reply(
        `🔐 کد ورود شما: \`${code}\`\n\n⏳ این کد تا ۵ دقیقه اعتبار دارد.`, 
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
            res.status(200).send('Bot is Active & Auto-Cleanup Enabled!');
        }
    } catch (e) {
        console.error(e);
        res.status(500).send('Error processing update');
    }
};
