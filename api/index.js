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

// --- سیستم پاکسازی دیتابیس (بازی‌های مرده و کدهای منقضی) ---
async function cleanDatabase() {
    const now = Date.now();

    // 1. پاکسازی کدهای ورود منقضی
    try {
        const authRef = db.ref('auth_codes');
        const authSnap = await authRef.once('value');
        if (authSnap.exists()) {
            const updates = {};
            authSnap.forEach((child) => {
                const data = child.val();
                if (data.expires_at && data.expires_at < now) {
                    updates[child.key] = null;
                }
            });
            if (Object.keys(updates).length > 0) {
                await authRef.update(updates);
                console.log('Expired auth codes cleaned.');
            }
        }
    } catch (e) { console.error('Auth Clean Error:', e); }

    // 2. پاکسازی بازی‌های متروکه یا تمام شده که ناقص مانده‌اند
    try {
        const gamesRef = db.ref('games');
        const gamesSnap = await gamesRef.once('value');
        if (gamesSnap.exists()) {
            const updates = {};
            gamesSnap.forEach((child) => {
                const game = child.val();
                const key = child.key;
                
                // شرط حذف:
                // ۱. هر دو بازیکن پرچم خروج (exited) داشته باشند
                // ۲. یا بازی بیشتر از 2 ساعت (۷۲۰۰۰۰۰ میلی‌ثانیه) مانده باشد (بازی ارواح)
                // ۳. یا برنده مشخص شده اما هنوز پاک نشده (بعد از ۱۰ دقیقه)
                
                const bothExited = game.exited_white === true && game.exited_black === true;
                const isVeryOld = (now - (game.turnStartTime || now)) > 7200000; 
                const isFinishedOld = game.winner && (now - (game.turnStartTime || now) > 600000);

                if (bothExited || isVeryOld || isFinishedOld) {
                    updates[key] = null;
                    // اگر چت‌های این بازی هم جداگانه هستند باید پاک شوند (در اینجا چت داخل نود بازی است پس با خود بازی پاک میشود)
                }
            });

            if (Object.keys(updates).length > 0) {
                await gamesRef.update(updates);
                console.log('Stale games cleaned from DB.');
            }
        }
    } catch (e) { console.error('Game Clean Error:', e); }
}

// --- پردازش صف نوتیفیکیشن‌ها ---
async function processNotifications() {
    const ref = db.ref('pending_notifications');
    try {
        const snapshot = await ref.once('value');
        if (!snapshot.exists()) return;

        const updates = {};
        
        // پیمایش تمام نوتیفیکیشن‌های موجود (حتی قدیمی‌ها)
        const promises = [];
        snapshot.forEach((child) => {
            const notification = child.val();
            const key = child.key;

            if (notification && notification.target_id && notification.message) {
                const p = bot.telegram.sendMessage(
                    notification.target_id, 
                    `🎮 *پیام جدید بازی*\n\n${notification.message}\n\n👇 وارد بازی شو!`, 
                    { parse_mode: 'Markdown' }
                ).then(() => {
                    console.log(`Sent to ${notification.target_id}`);
                    // حذف پس از ارسال موفق
                    return db.ref(`pending_notifications/${key}`).remove();
                }).catch(async (err) => {
                    console.error(`Failed to send to ${notification.target_id}`, err.message);
                    // در صورت خطا هم حذف میکنیم تا صف گیر نکند (مثلا اگر کاربر ربات را بلاک کرده)
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
        
    } catch (e) {
        console.error('Notification Process Error:', e);
    }
}

// لیسنر برای نوتیفیکیشن‌های جدید (Real-time)
db.ref('pending_notifications').on('child_added', async (snapshot) => {
    const notification = snapshot.val();
    const key = snapshot.key;
    if (!notification) return;

    try {
        await bot.telegram.sendMessage(
            notification.target_id, 
            `🎮 *درخواست بازی*\n\n${notification.message}\n\n👇 همین الان وارد شو!`, 
            { parse_mode: 'Markdown' }
        );
        await db.ref(`pending_notifications/${key}`).remove();
    } catch (error) {
        console.error('Realtime Send Error:', error.message);
        await db.ref(`pending_notifications/${key}`).remove();
    }
});

// --- ربات ---
bot.start(async (ctx) => {
    const user = ctx.from;
    cleanDatabase(); // هر بار کسی استارت زد دیتابیس تمیز شود
    processNotifications(); // چک کردن صف گیر کرده

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

// --- وب‌هوک / سرور ---
module.exports = async (req, res) => {
    try {
        // اجرای دستی تمیزکاری در هر ریکوئست (چون سرورلس است و همیشه روشن نیست)
        // این کار باعث میشود حتی اگر child_added کار نکند، با هر پینگ دیتابیس تمیز و پیامها ارسال شوند
        processNotifications();
        if (Math.random() < 0.1) cleanDatabase(); // با احتمال ۱۰ درصد در هر ریکوئست دیتابیس را جارو کن

        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).json({ ok: true });
        } else {
            res.status(200).send('Bot Running & Cleaning DB...');
        }
    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
};
