const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// دریافت اطلاعات از Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN;
// استفاده از فایلی که الان آپلود کردیم
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.DB_URL
  });
}

const db = admin.database();
const bot = new Telegraf(BOT_TOKEN);

// --- منطق ربات ---
bot.start(async (ctx) => {
    const payload = ctx.startPayload;
    
    if (payload && payload.startsWith('auth_')) {
        const user = ctx.from;
        // ذخیره در فایربیس
        await db.ref(`temp_logins/${payload}`).set({
            id: user.id,
            first_name: user.first_name,
            username: user.username || '',
            timestamp: Date.now()
        });
        await ctx.reply(`✅ ${user.first_name} عزیز، ورود تایید شد!`);
    } else {
        await ctx.reply('لطفا از طریق دکمه داخل سایت اقدام کنید.');
    }
});

// --- وب‌هوک برای ورسل ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).json({ ok: true });
        } else {
            res.status(200).send('Bot is Active!');
        }
    } catch (e) {
        console.error(e);
        res.status(500).send('Error processing update');
    }
};
