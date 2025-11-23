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

// --- سیستم لاگ برای دیباگ در دیتابیس ---
function logBot(type, msg, data = null) {
    const ref = db.ref('debug_bot_logs');
    ref.push({
        type: type,
        msg: msg,
        data: data ? JSON.stringify(data) : '',
        time: Date.now()
    }).catch(e => console.error(e));
}

// تابع تولید کد تصادفی ۴ رقمی
function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// --- پاکسازی دیتابیس (جاروبرقی) ---
async function cleanDatabase() {
    const now = Date.now();
    try {
        // پاکسازی کدهای منقضی
        const authRef = db.ref('auth_codes');
        const authSnap = await authRef.once('value');
        if (authSnap.exists()) {
            const updates = {};
            authSnap.forEach((child) => {
                if (child.val().expires_at < now) updates[child.key] = null;
            });
            if (Object.keys(updates).length > 0) await authRef.update(updates);
        }

        // پاکسازی بازی‌های متروکه
        const gamesRef = db.ref('games');
        const gamesSnap = await gamesRef.once('value');
        if (gamesSnap.exists()) {
            const updates = {};
            gamesSnap.forEach((child) => {
                const g = child.val();
                const k = child.key;
                const p1Exited = g.exited_white === true;
                const p2Exited = g.exited_black === true;
                const isOld = (now - (g.turnStartTime || now)) > 3600000; // 1 ساعت

                // اگر هر دو خارج شدند یا بازی خیلی قدیمی است
                if ((p1Exited && p2Exited) || isOld) {
                    updates[k] = null;
                } else if ((p1Exited || p2Exited) && (now - (g.turnStartTime || now) > 300000)) {
                    // اگر یکی خارج شده و ۵ دقیقه گذشته و بازی گیر کرده
                    updates[k] = null;
                }
            });
            if (Object.keys(updates).length > 0) await gamesRef.update(updates);
        }
    } catch (e) { console.error(e); }
}

// --- پردازشگر صف پیام‌ها (مهمترین بخش) ---
async function processMessageQueue() {
    const ref = db.ref('pending_notifications');
    try {
        const snapshot = await ref.once('value');
        if (!snapshot.exists()) return;

        const updates = {};
        const promises = [];

        snapshot.forEach((child) => {
            const notif = child.val();
            const key = child.key;

            if (notif && notif.target_id && notif.message) {
                // ارسال پیام
                const p = bot.telegram.sendMessage(
                    notif.target_id, 
                    `🎮 *پیام جدید*\n\n${notif.message}\n\n👇 همین الان وارد شو!`, 
                    { parse_mode: 'Markdown' }
                ).then(() => {
                    // حذف پس از ارسال موفق
                    return db.ref(`pending_notifications/${key}`).remove();
                }).catch((err) => {
                    logBot('Error', `Send failed to ${notif.target_id}`, err.message);
                    // اگر کاربر بلاک کرده یا خطا داد، باز هم حذف کن که صف گیر نکند
                    return db.ref(`pending_notifications/${key}`).remove();
                });
                promises.push(p);
            } else {
                // دیتای خراب را حذف کن
                updates[key] = null;
            }
        });

        if (Object.keys(updates).length > 0) await ref.update(updates);
        await Promise.all(promises);

    } catch (e) {
        console.error('Queue Error:', e);
    }
}

// --- لوپ چک‌کننده (Polling) ---
// این جایگزین لیسنر معمولی شده تا مطمئن شویم هر ۲ ثانیه حتما چک میکند
setInterval(() => {
    processMessageQueue();
    // هر ۱۰ ثانیه یکبار دیتابیس را هم تمیز کن
    if (Math.random() < 0.2) cleanDatabase();
}, 2000);

// --- ربات ---
bot.start(async (ctx) => {
    const user = ctx.from;
    
    // فورس چک کردن صف
    processMessageQueue();

    const code = generateCode();
    const expiresAt = Date.now() + (5 * 60 * 1000); 

    await db.ref(`auth_codes/${code}`).set({
        telegram_id: user.id,
        first_name: user.first_name,
        username: user.username || '',
        expires_at: expiresAt
    });

    await ctx.reply(
        `🔐 کد ورود شما: \`${code}\`\n\n⏳ اعتبار: ۵ دقیقه`, 
        { parse_mode: 'Markdown' }
    );
});

// --- وب‌هوک ---
module.exports = async (req, res) => {
    try {
        // با هر ریکوئست، یکبار صف را چک کن (برای محیط‌های Serverless)
        await processMessageQueue();
        
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).json({ ok: true });
        } else {
            res.status(200).send('Bot is Running & Polling DB...');
        }
    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
};
