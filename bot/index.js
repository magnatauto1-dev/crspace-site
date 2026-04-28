const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const admin = require('firebase-admin');

const TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = 'https://crspace.online/login.html';
const AUDIO_25_URL = 'https://crspace.online/audio.html?track=25';
const AUDIO_40_URL = 'https://crspace.online/audio.html?track=40';
const ADMIN_ID = 405630652;

const bot = new TelegramBot(TOKEN, { polling: true });

// Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Получаем всех пользователей из вайтлиста
async function getUsers() {
  const snapshot = await db.collection('whitelist').get();
  const ids = [];
  snapshot.forEach(doc => {
    const id = parseInt(doc.id);
    if (!isNaN(id)) ids.push(id);
  });
  return ids;
}

const checkinState = new Map();

const questions = [
  'Напряжение в теле',
  'Напряжение в уме',
  'Общий уровень стресса'
];

function sliderKeyboard() {
  return {
    inline_keyboard: [
      [1,2,3,4,5].map(i => ({ text: String(i), callback_data: `c_${i}` })),
      [6,7,8,9,10].map(i => ({ text: String(i), callback_data: `c_${i}` }))
    ]
  };
}

async function sendCheckin(userId, type) {
  checkinState.set(userId, { type, step: 0, answers: [] });
  const prefix = type === 'before'
    ? 'Как ты себя чувствуешь именно сейчас?'
    : 'Как ты себя чувствуешь после практики?';
  await bot.sendMessage(userId,
    `${prefix}\n\n*${questions[0]}*\nОцени от 1 до 10:`,
    { parse_mode: 'Markdown', reply_markup: sliderKeyboard() }
  );
}

// Напоминание о медитации в сопровождении
async function sendMeditationReminder(userId) {
  await bot.sendMessage(userId,
    '🎧 Сделай сегодня практику в сопровождении\n\nВыбери свою:',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '25 минут', web_app: { url: AUDIO_25_URL } },
            { text: '40 минут', web_app: { url: AUDIO_40_URL } }
          ],
          [{ text: 'Завершил практику ✓', callback_data: 'done_meditation' }]
        ]
      }
    }
  );
}

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;

  // Одобрение доступа
  if (data.startsWith('approve_')) {
    const newUserId = parseInt(data.split('_')[1]);
    const newUserName = query.message.text.match(/👤 (.+)/)?.[1] || '';
    await db.collection('whitelist').doc(String(newUserId)).set({ name: newUserName });
    await bot.answerCallbackQuery(query.id, { text: 'Доступ выдан ✓' });
    await bot.editMessageText(query.message.text + '\n\n✅ Доступ выдан', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    }).catch(() => {});
    await bot.sendMessage(newUserId,
      'Доступ открыт ✓\n\nДобро пожаловать в CR Space.',
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'Открыть →', web_app: { url: MINI_APP_URL } }]]
        }
      }
    );
    return;
  }

  // Завершил медитацию → чекин после
  if (data === 'done_meditation') {
    await bot.answerCallbackQuery(query.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    }).catch(() => {});
    await sendCheckin(userId, 'after');
    return;
  }

  if (!data.startsWith('c_')) return;

  const state = checkinState.get(userId);
  if (!state) {
    await bot.answerCallbackQuery(query.id, { text: 'Сессия устарела.' });
    return;
  }

  const value = parseInt(data.split('_')[1]);
  state.answers.push(value);

  await bot.editMessageReplyMarkup(
    { inline_keyboard: [] },
    { chat_id: query.message.chat.id, message_id: query.message.message_id }
  ).catch(() => {});
  await bot.answerCallbackQuery(query.id);

  if (state.step < 2) {
    state.step++;
    await bot.sendMessage(userId,
      `*${questions[state.step]}*\nОцени от 1 до 10:`,
      { parse_mode: 'Markdown', reply_markup: sliderKeyboard() }
    );
  } else {
    const [body, mind, stress] = state.answers;
    await db.collection('checkins').add({
      userId, type: state.type, body, mind, stress,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    if (state.type === 'before') {
      await bot.sendMessage(userId,
        `✅ Принято\n\n🫀 Тело · ${body}\n🧠 Ум · ${mind}\n⚡ Стресс · ${stress}\n\nХорошей практики.`
      );
    } else {
      const beforeSnap = await db.collection('checkins')
        .where('userId', '==', userId)
        .where('type', '==', 'before')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

      if (!beforeSnap.empty) {
        const b = beforeSnap.docs[0].data();
        const fmt = v => v > 0 ? `−${v}` : v < 0 ? `+${Math.abs(v)}` : '±0';
        await bot.sendMessage(userId,
          `✅ Принято\n\n` +
          `🫀 Тело:   ${b.body} → ${body}  (${fmt(b.body - body)})\n` +
          `🧠 Ум:     ${b.mind} → ${mind}  (${fmt(b.mind - mind)})\n` +
          `⚡ Стресс: ${b.stress} → ${stress}  (${fmt(b.stress - stress)})\n\n` +
          `Практика работает.`
        );
      } else {
        await bot.sendMessage(userId,
          `✅ Принято\n\n🫀 Тело · ${body}\n🧠 Ум · ${mind}\n⚡ Стресс · ${stress}\n\nХорошая практика.`
        );
      }
    }

    checkinState.delete(userId);
  }
});

// ── РАСПИСАНИЕ ────────────────────────────────────────────────────

// Пн, Вт, Чт, Сб, Вс в 13:00 — медитация в сопровождении + чекин ДО
cron.schedule('0 13 * * 1,2,4,6,0', async () => {
  const users = await getUsers();
  for (const id of users) {
    await sendMeditationReminder(id).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    await sendCheckin(id, 'before').catch(() => {});
  }
}, { timezone: 'Europe/Kiev' });

// /start — запрос на доступ
bot.onText(/\/start/, async (msg) => {
  const user = msg.from;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');

  await bot.sendMessage(user.id,
    'Привет! Твоя заявка отправлена.\n\nКак только получишь доступ — напишу тебе.'
  );

  await bot.sendMessage(ADMIN_ID,
    `Новый запрос на доступ:\n\n👤 ${name}\n🔗 @${user.username || '—'}\n🆔 ${user.id}`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: 'Одобрить ✓', callback_data: `approve_${user.id}` }]]
      }
    }
  );
});

// ТЕСТ — удалить после проверки
cron.schedule('56 11 * * *', async () => {
  const users = await getUsers();
  for (const id of users) {
    await sendMeditationReminder(id).catch(() => {});
    await sendCheckin(id, 'before').catch(() => {});
  }
}, { timezone: 'Europe/Kiev' });

console.log('CR Space Bot запущен');
