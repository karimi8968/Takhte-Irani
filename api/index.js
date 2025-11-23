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

// --- سیستم لاگ دیباگ ---
function logDebug(section, message, data = null) {
    const logRef = db.ref('debug_logs');
    logRef.push({
        section: section,
        message: message,
        data: data ? JSON.stringify(data) : null,
        timestamp: Date.now()
    }).catch(err => console.error("Logging failed:", err));
}

// تابع تولید کد تصادفی ۴ رقمی
function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// --- پاکسازی هوشمند دیتابیس ---
async function cleanDatabase() {
    const now = Date.now();

    // 1. پاکسازی کدهای منقضی
    try {
        const authRef = db.ref('auth_codes');
        const authSnap = await authRef.once('value');
        if (authSnap.exists()) {
            const updates = {};
            authSnap.forEach((child) => {
                if (child.val().expires_at < now) updates[child.key] = null;
            });
            if (Object.keys(updates).length > 0) await authRef.update(updates);
        }
    } catch (e) { console.error('Auth Clean Error', e); }

    // 2. پاکسازی بازی‌های خراب یا تمام شده
    try {
        const gamesRef = db.ref('games');
        const gamesSnap = await gamesRef.once('value');
        if (gamesSnap.exists()) {
            const updates = {};
            gamesSnap.forEach((child) => {
                const g = child.val();
                const k = child.key;
                
                // شرط حذف:
                // ۱. هر دو خارج شده باشند (حتی ناقص)
                const p1Exited = g.exited_white === true;
                const p2Exited = g.exited_black === true;
                
                // ۲. بازی خیلی قدیمی باشد (بیش از ۲ ساعت)
                const isOld = (now - (g.turnStartTime || now)) > 7200000;
                
                // ۳. وضعیت Waiting است اما بیشتر از ۳۰ دقیقه مانده (بازی رها شده)
                const isStaleWaiting = g.status === 'waiting' && (now - (g.turnStartTime || now)) > 1800000;

                // اگر یکی خارج شده و دیگری نیست (باگ دیتابیس) یا هر دو خارج شدند
                if ((p1Exited && p2Exited) || isOld || isStaleWaiting) {
                    updates[k] = null;
                    logDebug('Cleaner', `Removing game ${k}`, { p1Exited, p2Exited, isOld });
                } else if ((p1Exited || p2Exited) && (now - (g.turnStartTime || now) > 600000)) {
                    // اگر ده دقیقه گذشته و یکی خارج شده، کلا پاک کن (بازی گیر کرده)
                    updates[k] = null;
                    logDebug('Cleaner', `Force removing stuck game ${k}`);
                }
            });

            if (Object.keys(updates).length > 0) {
                await gamesRef.update(updates);
            }
        }
    } catch (e) { console.error('Game Clean Error', e); }
}

// --- سیستم ارسال نوتیفیکیشن (تضمینی) ---
async function sendNotification(key, data) {
    if (!data || !data.target_id || !data.message) {
        await db.ref(`pending_notifications/${key}`).remove();
        return;
    }

    try {
        await bot.telegram.sendMessage(
            data.target_id, 
            `🎮 *پیام جدید*\n\n${data.message}\n\n👇 وارد بازی شو!`, 
            { parse_mode: 'Markdown' }
        );
        logDebug('Notification', `Sent to ${data.target_id}`);
        await db.ref(`pending_notifications/${key}`).remove();
    } catch (error) {
        logDebug('NotificationError', `Failed for ${data.target_id}`, error.message);
        // در صورت بلاک بودن یا خطا هم حذف میکنیم تا لوپ نشود
        await db.ref(`pending_notifications/${key}`).remove();
    }
}

// لیسنر Real-time
db.ref('pending_notifications').on('child_added', (snapshot) => {
    sendNotification(snapshot.key, snapshot.val());
});

// پولینگ (Polling) برای اطمینان از ارسال - هر ۵ ثانیه چک میکند
setInterval(async () => {
    try {
        const ref = db.ref('pending_notifications');
        const snapshot = await ref.once('value');
        if (snapshot.exists()) {
            snapshot.forEach((child) => {
                sendNotification(child.key, child.val());
            });
        }
    } catch(e) { console.error(e); }
}, 5000); 

// نظارت بر بازی‌ها برای پاکسازی آنی
db.ref('games').on('child_changed', (snapshot) => {
    const g = snapshot.val();
    const k = snapshot.key;
    if (g && g.exited_white && g.exited_black) {
        db.ref(`games/${k}`).remove();
        logDebug('Watcher', `Instant remove game ${k}`);
    }
});

// --- ربات ---
bot.start(async (ctx) => {
    const user = ctx.from;
    cleanDatabase();

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
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).json({ ok: true });
        } else {
            // هر بار که پینگ میشود دیتابیس را هم تمیز میکند
            cleanDatabase();
            res.status(200).send('Bot Active');
        }
    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
};
