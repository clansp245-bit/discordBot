// index.js — بوت اقتصاد متكامل (discord.js v14 + SQLite)
require('dotenv').config();
const Database = require('better-sqlite3');
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');

// ======================= الإعدادات =======================
const CURRENCY = '🪙';
const OWNER_ID = process.env.OWNER_ID; // آيدي حسابك، لأوامر /give و /take
const DAILY_REWARD = 500;
const WORK_COOLDOWN = 60 * 60 * 1000; // ساعة
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000; // 24 ساعة
const ROB_COOLDOWN = 60 * 60 * 1000; // ساعة

const SHOP = {
  padlock: { name: 'قفل حماية', emoji: '🔒', price: 1500, desc: 'يحميك من محاولة سرقة واحدة (يُستهلك)' },
  laptop: { name: 'لابتوب', emoji: '💻', price: 5000, desc: 'يزيد أرباح /work بنسبة 50%' },
  crown: { name: 'تاج الملوك', emoji: '👑', price: 100000, desc: 'للتفاخر فقط!' },
};

// ======================= قاعدة البيانات =======================
const db = new Database('economy.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  wallet INTEGER NOT NULL DEFAULT 0,
  bank INTEGER NOT NULL DEFAULT 0,
  last_daily INTEGER NOT NULL DEFAULT 0,
  last_work INTEGER NOT NULL DEFAULT 0,
  last_rob INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  item TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item)
);
`);

const stmtInsert = db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)');
const stmtGet = db.prepare('SELECT * FROM users WHERE id = ?');
const CD_COLUMNS = ['last_daily', 'last_work', 'last_rob'];

function getUser(id) {
  stmtInsert.run(id);
  return stmtGet.get(id);
}
function addWallet(id, amt) {
  getUser(id);
  db.prepare('UPDATE users SET wallet = wallet + ?, total_earned = total_earned + MAX(?, 0) WHERE id = ?').run(amt, amt, id);
}
function setCooldown(id, col) {
  if (!CD_COLUMNS.includes(col)) return;
  db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(Date.now(), id);
}
function cooldownLeft(user, col, ms) {
  return Math.max(0, user[col] + ms - Date.now());
}
function getQty(id, item) {
  const row = db.prepare('SELECT qty FROM inventory WHERE user_id = ? AND item = ?').get(id, item);
  return row ? row.qty : 0;
}
function addItem(id, item, qty) {
  db.prepare(
    'INSERT INTO inventory (user_id, item, qty) VALUES (?, ?, ?) ON CONFLICT(user_id, item) DO UPDATE SET qty = qty + excluded.qty'
  ).run(id, item, qty);
}

// ======================= دوال مساعدة =======================
const fmt = (n) => `${Number(n).toLocaleString('en-US')} ${CURRENCY}`;
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const when = (ms) => `<t:${Math.floor((Date.now() + ms) / 1000)}:R>`;

function parseAmount(input, max) {
  const s = input.trim().toLowerCase();
  if (s === 'all' || s === 'الكل') return max;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
const embed = (desc, color = 0x5865f2, title) => {
  const e = new EmbedBuilder().setColor(color).setDescription(desc);
  if (title) e.setTitle(title);
  return e;
};
const ok = (i, desc, title) => i.reply({ embeds: [embed(desc, 0x2ecc71, title)] });
const info = (i, desc, title) => i.reply({ embeds: [embed(desc, 0x5865f2, title)] });
const bad = (i, desc) => i.reply({ embeds: [embed(`❌ ${desc}`, 0xe74c3c)], ephemeral: true });

// ======================= العمليات الذرية =======================
const payTx = db.transaction((from, to, amt) => {
  const f = getUser(from);
  if (f.wallet < amt) return false;
  getUser(to);
  db.prepare('UPDATE users SET wallet = wallet - ? WHERE id = ?').run(amt, from);
  db.prepare('UPDATE users SET wallet = wallet + ? WHERE id = ?').run(amt, to);
  return true;
});
const depositTx = db.transaction((id, amt) => {
  const u = getUser(id);
  if (u.wallet < amt) return false;
  db.prepare('UPDATE users SET wallet = wallet - ?, bank = bank + ? WHERE id = ?').run(amt, amt, id);
  return true;
});
const withdrawTx = db.transaction((id, amt) => {
  const u = getUser(id);
  if (u.bank < amt) return false;
  db.prepare('UPDATE users SET bank = bank - ?, wallet = wallet + ? WHERE id = ?').run(amt, amt, id);
  return true;
});
const buyTx = db.transaction((id, item, qty, cost) => {
  const u = getUser(id);
  if (u.wallet < cost) return false;
  db.prepare('UPDATE users SET wallet = wallet - ? WHERE id = ?').run(cost, id);
  addItem(id, item, qty);
  return true;
});
const betTx = db.transaction((id, delta) => {
  // delta موجب = ربح، سالب = خسارة
  db.prepare('UPDATE users SET wallet = wallet + ?, total_earned = total_earned + MAX(?, 0) WHERE id = ?').run(delta, delta, id);
});

// ======================= تعريف الأوامر =======================
const amountOpt = (o, desc = 'المبلغ (رقم أو all)') => o.setName('amount').setDescription(desc).setRequired(true);
const shopChoices = Object.entries(SHOP).map(([k, v]) => ({ name: `${v.emoji} ${v.name}`, value: k }));

const commands = [
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('عرض رصيدك أو رصيد عضو')
    .addUserOption((o) => o.setName('user').setDescription('العضو')),
  new SlashCommandBuilder().setName('daily').setDescription('استلم مكافأتك اليومية'),
  new SlashCommandBuilder().setName('work').setDescription('اشتغل واكسب فلوس'),
  new SlashCommandBuilder().setName('deposit').setDescription('إيداع في البنك').addStringOption((o) => amountOpt(o)),
  new SlashCommandBuilder().setName('withdraw').setDescription('سحب من البنك').addStringOption((o) => amountOpt(o)),
  new SlashCommandBuilder()
    .setName('pay')
    .setDescription('تحويل فلوس لعضو')
    .addUserOption((o) => o.setName('user').setDescription('المستلم').setRequired(true))
    .addStringOption((o) => amountOpt(o)),
  new SlashCommandBuilder()
    .setName('rob')
    .setDescription('حاول تسرق عضو')
    .addUserOption((o) => o.setName('user').setDescription('الضحية').setRequired(true)),
  new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('قلب عملة وضاعف فلوسك')
    .addStringOption((o) => amountOpt(o, 'مبلغ الرهان'))
    .addStringOption((o) =>
      o
        .setName('side')
        .setDescription('اختر')
        .setRequired(true)
        .addChoices({ name: 'صورة', value: 'heads' }, { name: 'كتابة', value: 'tails' })
    ),
  new SlashCommandBuilder().setName('slots').setDescription('ماكينة الحظ').addStringOption((o) => amountOpt(o, 'مبلغ الرهان')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('أغنى 10 أعضاء'),
  new SlashCommandBuilder().setName('shop').setDescription('عرض المتجر'),
  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('شراء غرض من المتجر')
    .addStringOption((o) => o.setName('item').setDescription('الغرض').setRequired(true).addChoices(...shopChoices))
    .addIntegerOption((o) => o.setName('qty').setDescription('الكمية').setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName('inventory').setDescription('عرض أغراضك'),
  new SlashCommandBuilder()
    .setName('give')
    .setDescription('(للمالك) إعطاء فلوس')
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('المبلغ').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('take')
    .setDescription('(للمالك) سحب فلوس')
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('المبلغ').setRequired(true).setMinValue(1)),
].map((c) => c.toJSON());

// ======================= تنفيذ الأوامر =======================
const handlers = {
  async balance(i) {
    const user = i.options.getUser('user') || i.user;
    if (user.bot) return bad(i, 'البوتات ما عندها حسابات.');
    const u = getUser(user.id);
    const e = embed('', 0xf1c40f, `💰 رصيد ${user.username}`)
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: 'المحفظة', value: fmt(u.wallet), inline: true },
        { name: 'البنك', value: fmt(u.bank), inline: true },
        { name: 'المجموع', value: fmt(u.wallet + u.bank), inline: true }
      );
    return i.reply({ embeds: [e] });
  },

  async daily(i) {
    const u = getUser(i.user.id);
    const left = cooldownLeft(u, 'last_daily', DAILY_COOLDOWN);
    if (left) return bad(i, `رجع ${when(left)} لاستلام المكافأة.`);
    addWallet(i.user.id, DAILY_REWARD);
    setCooldown(i.user.id, 'last_daily');
    return ok(i, `استلمت مكافأتك اليومية: **${fmt(DAILY_REWARD)}**`, '🎁 مكافأة يومية');
  },

  async work(i) {
    const u = getUser(i.user.id);
    const left = cooldownLeft(u, 'last_work', WORK_COOLDOWN);
    if (left) return bad(i, `أنت تعبان! رجع للشغل ${when(left)}.`);
    let earn = rand(100, 400);
    let bonus = '';
    if (getQty(i.user.id, 'laptop') > 0) {
      earn = Math.floor(earn * 1.5);
      bonus = '\n💻 مكافأة اللابتوب +50%';
    }
    const jobs = ['برمجت موقع', 'وصّلت طلبات', 'صممت شعار', 'صلحت سيارة', 'درّست طالب'];
    addWallet(i.user.id, earn);
    setCooldown(i.user.id, 'last_work');
    return ok(i, `${jobs[rand(0, jobs.length - 1)]} وكسبت **${fmt(earn)}**${bonus}`, '💼 شغل');
  },

  async deposit(i) {
    const u = getUser(i.user.id);
    const amt = parseAmount(i.options.getString('amount'), u.wallet);
    if (!amt) return bad(i, 'مبلغ غير صالح.');
    if (!depositTx(i.user.id, amt)) return bad(i, 'ما عندك هالمبلغ في المحفظة.');
    return ok(i, `تم إيداع **${fmt(amt)}** في البنك 🏦`);
  },

  async withdraw(i) {
    const u = getUser(i.user.id);
    const amt = parseAmount(i.options.getString('amount'), u.bank);
    if (!amt) return bad(i, 'مبلغ غير صالح.');
    if (!withdrawTx(i.user.id, amt)) return bad(i, 'ما عندك هالمبلغ في البنك.');
    return ok(i, `تم سحب **${fmt(amt)}** من البنك 💵`);
  },

  async pay(i) {
    const target = i.options.getUser('user');
    if (target.bot) return bad(i, 'ما تقدر تحول لبوت.');
    if (target.id === i.user.id) return bad(i, 'ما تقدر تحول لنفسك.');
    const u = getUser(i.user.id);
    const amt = parseAmount(i.options.getString('amount'), u.wallet);
    if (!amt) return bad(i, 'مبلغ غير صالح.');
    if (!payTx(i.user.id, target.id, amt)) return bad(i, 'رصيد المحفظة غير كافي.');
    return ok(i, `${i.user} حوّل **${fmt(amt)}** إلى ${target} ✅`, '💸 تحويل');
  },

  async rob(i) {
    const target = i.options.getUser('user');
    if (target.bot || target.id === i.user.id) return bad(i, 'ما تقدر تسرق هذا الشخص.');
    const me = getUser(i.user.id);
    const left = cooldownLeft(me, 'last_rob', ROB_COOLDOWN);
    if (left) return bad(i, `الشرطة تراقبك! جرب ${when(left)}.`);
    if (me.wallet < 200) return bad(i, 'لازم يكون معك 200 على الأقل في المحفظة عشان تسرق.');
    const victim = getUser(target.id);
    if (victim.wallet < 100) return bad(i, 'الضحية مفلس، ما يستاهل.');

    setCooldown(i.user.id, 'last_rob');

    if (getQty(target.id, 'padlock') > 0) {
      addItem(target.id, 'padlock', -1);
      return info(i, `🔒 ${target} كان عنده قفل حماية! فشلت السرقة وانكسر القفل.`, '🚨 سرقة فاشلة');
    }

    if (Math.random() < 0.5) {
      const amt = Math.max(1, Math.floor(victim.wallet * (rand(10, 30) / 100)));
      payTx(target.id, i.user.id, amt);
      return ok(i, `🦹 سرقت **${fmt(amt)}** من ${target}!`, 'سرقة ناجحة');
    }
    const fine = Math.min(me.wallet, rand(100, 200));
    payTx(i.user.id, target.id, fine);
    return i.reply({
      embeds: [embed(`🚓 انمسكت! دفعت غرامة **${fmt(fine)}** إلى ${target}.`, 0xe74c3c, 'سرقة فاشلة')],
    });
  },

  async coinflip(i) {
    const u = getUser(i.user.id);
    const amt = parseAmount(i.options.getString('amount'), u.wallet);
    if (!amt) return bad(i, 'مبلغ غير صالح.');
    if (amt > u.wallet) return bad(i, 'رصيد المحفظة غير كافي.');
    const side = i.options.getString('side');
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const label = result === 'heads' ? 'صورة' : 'كتابة';
    if (side === result) {
      betTx(i.user.id, amt);
      return ok(i, `طلعت **${label}** 🪙 وربحت **${fmt(amt)}**!`, 'قلب العملة');
    }
    betTx(i.user.id, -amt);
    return i.reply({ embeds: [embed(`طلعت **${label}** 🪙 وخسرت **${fmt(amt)}**.`, 0xe74c3c, 'قلب العملة')] });
  },

  async slots(i) {
    const u = getUser(i.user.id);
    const amt = parseAmount(i.options.getString('amount'), u.wallet);
    if (!amt) return bad(i, 'مبلغ غير صالح.');
    if (amt > u.wallet) return bad(i, 'رصيد المحفظة غير كافي.');
    const syms = ['🍒', '🍋', '🍇', '🔔', '💎', '7️⃣'];
    const r = [0, 0, 0].map(() => syms[rand(0, syms.length - 1)]);
    const line = r.join(' | ');
    const unique = new Set(r).size;
    if (unique === 1) {
      const win = amt * 9;
      betTx(i.user.id, win);
      return ok(i, `${line}\n\n🎉 جاكبوت! ربحت **${fmt(win)}**`, '🎰 سلوتس');
    }
    if (unique === 2) {
      const win = Math.max(1, Math.floor(amt * 0.5));
      betTx(i.user.id, win);
      return ok(i, `${line}\n\nاثنين متطابقين! ربحت **${fmt(win)}**`, '🎰 سلوتس');
    }
    betTx(i.user.id, -amt);
    return i.reply({ embeds: [embed(`${line}\n\nخسرت **${fmt(amt)}**`, 0xe74c3c, '🎰 سلوتس')] });
  },

  async leaderboard(i) {
    await i.deferReply();
    const rows = db.prepare('SELECT id, wallet + bank AS total FROM users ORDER BY total DESC LIMIT 10').all();
    if (!rows.length) return i.editReply('ما فيه بيانات بعد.');
    const medals = ['🥇', '🥈', '🥉'];
    const lines = [];
    for (let n = 0; n < rows.length; n++) {
      const user = await client.users.fetch(rows[n].id).catch(() => null);
      lines.push(`${medals[n] || `**${n + 1}.**`} ${user ? user.username : rows[n].id} — ${fmt(rows[n].total)}`);
    }
    return i.editReply({ embeds: [embed(lines.join('\n'), 0xf1c40f, '🏆 المتصدرين')] });
  },

  async shop(i) {
    const lines = Object.entries(SHOP).map(
      ([k, v]) => `${v.emoji} **${v.name}** — ${fmt(v.price)}\n└ ${v.desc}`
    );
    return info(i, lines.join('\n\n') + '\n\nللشراء: `/buy`', '🛒 المتجر');
  },

  async buy(i) {
    const key = i.options.getString('item');
    const qty = i.options.getInteger('qty') || 1;
    const item = SHOP[key];
    if (!item) return bad(i, 'غرض غير موجود.');
    const cost = item.price * qty;
    if (!buyTx(i.user.id, key, qty, cost)) return bad(i, `تحتاج ${fmt(cost)} في المحفظة.`);
    return ok(i, `اشتريت ${qty}× ${item.emoji} **${item.name}** بسعر **${fmt(cost)}**`, 'تمت العملية');
  },

  async inventory(i) {
    const rows = db.prepare('SELECT item, qty FROM inventory WHERE user_id = ? AND qty > 0').all(i.user.id);
    if (!rows.length) return info(i, 'حقيبتك فاضية. جرب `/shop`', '🎒 الحقيبة');
    const lines = rows.map((r) => `${SHOP[r.item]?.emoji || '📦'} ${SHOP[r.item]?.name || r.item} × **${r.qty}**`);
    return info(i, lines.join('\n'), '🎒 الحقيبة');
  },

  async give(i) {
    if (i.user.id !== OWNER_ID) return bad(i, 'هذا الأمر للمالك فقط.');
    const t = i.options.getUser('user');
    const amt = i.options.getInteger('amount');
    addWallet(t.id, amt);
    return ok(i, `تم إعطاء ${t} مبلغ **${fmt(amt)}**`);
  },

  async take(i) {
    if (i.user.id !== OWNER_ID) return bad(i, 'هذا الأمر للمالك فقط.');
    const t = i.options.getUser('user');
    const amt = i.options.getInteger('amount');
    const u = getUser(t.id);
    const real = Math.min(u.wallet, amt);
    db.prepare('UPDATE users SET wallet = wallet - ? WHERE id = ?').run(real, t.id);
    return ok(i, `تم سحب **${fmt(real)}** من ${t}`);
  },
};

// ======================= تشغيل البوت =======================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 شغال باسم: ${c.user.tag} | في ${c.guilds.cache.size} سيرفر`);
  c.user.setActivity('/daily | /work');
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ تم تسجيل الأوامر العامة');
  } catch (err) {
    console.error('خطأ في تسجيل الأوامر:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return interaction.reply({ content: 'استخدم البوت داخل سيرفر.', ephemeral: true });
  const handler = handlers[interaction.commandName];
  if (!handler) return;
  try {
    await handler(interaction);
  } catch (err) {
    console.error(err);
    const msg = { content: '❌ صار خطأ غير متوقع.', ephemeral: true };
    if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled:', err));
client.login(process.env.TOKEN);
