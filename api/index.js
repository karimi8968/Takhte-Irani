const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// --- 1. تنظیمات و اتصال به دیتابیس ---
const BOT_TOKEN = process.env.BOT_TOKEN;

// جلوگیری از خطای مقداردهی تکراری در محیط Serverless
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.DB_URL
        });
    } catch (error) {
        console.error('Firebase Init Error:', error);
    }
}

const db = admin.database();
const bot = new Telegraf(BOT_TOKEN);

// --- 2. توابع کمکی ---

function logBot(type, msg, data = null) {
    const ref = db.ref('debug_bot_logs');
    ref.push({
        type: type,
        msg: msg,
        data: data ? JSON.stringify(data) : '',
        time: Date.now()
    }).catch(e => console.error(e));
}

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// --- 3. پردازشگر صف پیام‌ها ---
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
                    console.error(`Failed to send to ${notif.target_id}:`, err.message);
                    // در صورت خطا هم حذف می‌کنیم تا صف گیر نکند (می‌توانید لاگ کنید)
                    return db.ref(`pending_notifications/${key}`).remove();
                });
                promises.push(p);
            } else {
                // دیتای خراب
                updates[key] = null;
            }
        });

        if (Object.keys(updates).length > 0) await ref.update(updates);
        await Promise.all(promises);
        console.log(`Queue processed: ${promises.length} messages.`);

    } catch (e) {
        console.error('Queue Error:', e);
    }
}

// --- 4. پاکسازی دیتابیس (Clean DB) ---
async function cleanDatabase() {
    const now = Date.now();
    try {
        // پاکسازی کدهای Auth منقضی
        const authRef = db.ref('auth_codes');
        const authSnap = await authRef.once('value');
        if (authSnap.exists()) {
            const updates = {};
            authSnap.forEach((child) => {
                if (child.val().expires_at < now) updates[child.key] = null;
            });
            if (Object.keys(updates).length > 0) await authRef.update(updates);
        }

        // پاکسازی بازی‌های قدیمی
        const gamesRef = db.ref('games');
        const gamesSnap = await gamesRef.once('value');
        if (gamesSnap.exists()) {
            const updates = {};
            gamesSnap.forEach((child) => {
                const g = child.val();
                const k = child.key;
                if (!g) return;

                const p1Exited = g.exited_white === true;
                const p2Exited = g.exited_black === true;
                const lastTurnTime = g.turnStartTime || now;
                
                // شرط حذف: بازی خیلی قدیمی (1 ساعت) یا هر دو خارج شده
                const isVeryOld = (now - lastTurnTime) > 3600000; 
                const isAbandoned = (p1Exited && p2Exited);
                const isStuck = (p1Exited || p2Exited) && ((now - lastTurnTime) > 300000); // 5 دقیقه

                if (isVeryOld || isAbandoned || isStuck) {
                    updates[k] = null;
                }
            });
            if (Object.keys(updates).length > 0) await gamesRef.update(updates);
        }
    } catch (e) { console.error('Clean DB Error:', e); }
}

// --- 5. دستورات ربات ---
bot.start(async (ctx) => {
    const user = ctx.from;
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

// --- 6. هندلر اصلی (Main Entry Point) ---
module.exports = async (req, res) => {
    try {
        // الف) تشخیص درخواست Cron Job (از طرف Vercel)
        // این بخش جایگزین setInterval شده است
        const isCron = req.headers['user-agent'] && req.headers['user-agent'].includes('vercel-cron');

        if (isCron) {
            console.log('⏰ Cron Job execution started...');
            await processMessageQueue(); // صف پیام‌ها را خالی کن
            await cleanDatabase();       // دیتابیس را تمیز کن
            return res.status(200).send('Cron Jobs Executed');
        }

        // ب) تشخیص درخواست تلگرام (Webhook)
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).json({ ok: true });
        } 
        
        // ج) درخواست معمولی مرورگر (Health Check)
        res.status(200).send('Bot is running properly on Vercel (Cron Enabled).');
        
    } catch (e) {
        console.error('Main Handler Error:', e);
        res.status(500).send('Internal Server Error');
    }
};
