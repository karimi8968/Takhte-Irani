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

// --- منطق ربات ---
bot.start(async (ctx) => {
    const user = ctx.from;
    const code = generateCode();
    
    // محاسبه زمان انقضا: زمان فعلی + ۵ دقیقه (۳۰۰,۰۰۰ میلی‌ثانیه)
    const expiresAt = Date.now() + (5 * 60 * 1000); 

    // ذخیره کد در فایربیس
    // ساختار: auth_codes -> [CODE] -> { اطلاعات کاربر + زمان انقضا }
    await db.ref(`auth_codes/${code}`).set({
        telegram_id: user.id,
        first_name: user.first_name,
        username: user.username || '',
        expires_at: expiresAt
    });

    // ارسال کد به کاربر (با فرمت کپی‌برداری راحت)
    await ctx.reply(
        `🔐 کد ورود شما: \`${code}\`\n\n⏳ این کد تا ۵ دقیقه اعتبار دارد.`, 
        { parse_mode: 'Markdown' }
    );
});

// --- وب‌هوک برای ورسل ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).json({ ok: true });
        } else {
            res.status(200).send('Bot is Active & Logic Updated!');
        }
    } catch (e) {
        console.error(e);
        res.status(500).send('Error processing update');
    }
};
