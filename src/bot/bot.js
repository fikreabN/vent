// ---------- Load Environment Variables ----------
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

// ---------- Express Server for Health Check ----------
const app = express();
app.get('/', (req, res) => res.send('AMU Vent Bot is alive!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// ---------- Environment Variables ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const CHANNEL_ID = process.env.CHANNEL_ID;
const START_VENT_NUMBER = parseInt(process.env.START_VENT_NUMBER || '1', 10) || 1;
const MONGODB_URI = process.env.MONGODB_URI;

if (!BOT_TOKEN || !ADMIN_ID || !CHANNEL_ID || !MONGODB_URI) {
  console.error('❌ Missing required .env variables.');
  process.exit(1);
}

// ---------- MongoDB Connection ----------
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// ---------- Import Models ----------
const Confession = require('./models/Confession');
const Comment = require('./models/Comment');
const Settings = require('./models/Settings');

// ---------- Telegraf Bot Setup ----------
const bot = new Telegraf(BOT_TOKEN);
let BOT_USERNAME = null;

// In-memory state
const pendingVents = new Map();
const pendingComments = new Map();

// ---------- Helper Functions ----------
function persistentKeyboard() {
  return Markup.keyboard([['🗣️ Vent Now']]).resize().oneTime(false);
}

function commentsButtonMarkup(ventId, count) {
  const deepLink = `https://t.me/${BOT_USERNAME}?start=comments_${ventId}`;
  return Markup.inlineKeyboard([
    [Markup.button.url(`💬 Comments (${count})`, deepLink)]
  ]);
}

// ---------- Get Bot Username ----------
(async () => {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    console.log('🤖 Bot username:', BOT_USERNAME);
  } catch (err) {
    console.error('⚠️ Could not fetch bot username:', err.message);
  }
})();

// ---------- /start Handler ----------
bot.start(async (ctx) => {
  const text = ctx.message?.text || '';
  const payload = text.split(' ')[1] || null;

  await ctx.reply(
    '👋 Welcome to AMU Vent!\nTap "🗣️ Vent Now" to send your anonymous vent.',
    persistentKeyboard()
  );

  if (payload && payload.startsWith('comments_')) {
    const ventId = payload.replace('comments_', '').trim();
    if (ventId) showCommentMenu(ctx, ventId);
  }
});

// ---------- Vent Creation ----------
bot.hears('🗣️ Vent Now', (ctx) => {
  pendingVents.set(ctx.from.id, true);
  ctx.reply(
    '📝 Type your vent and send, it will go through a review before being posted.',
    persistentKeyboard()
  );
});

bot.command('vent', (ctx) => {
  pendingVents.set(ctx.from.id, true);
  ctx.reply(
    '📝 Type your vent and send, it will go through a review before being posted.',
    persistentKeyboard()
  );
});

// ---------- Text Message Handler ----------
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  try {
    // User commenting
    if (pendingComments.has(userId)) {
      const ventId = pendingComments.get(userId);
      pendingComments.delete(userId);

      const comment = new Comment({
        ventId,
        userId,
        username: ctx.from.username || '',
        name: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
        text
      });
      await comment.save();

      const confession = await Confession.findById(ventId);
      if (confession) {
        confession.commentsCount = (confession.commentsCount || 0) + 1;
        await confession.save();

        if (confession.channelMessageId) {
          const newMarkup = commentsButtonMarkup(confession._id, confession.commentsCount);
          try {
            await bot.telegram.editMessageReplyMarkup(
              CHANNEL_ID,
              confession.channelMessageId,
              undefined,
              newMarkup.reply_markup
            );
          } catch (err) {
            console.warn('⚠️ Could not update channel message:', err.message);
          }
        }
      }

      await ctx.reply('✅ Your comment has been added!');
      return;
    }

    // User sending vent
    if (pendingVents.has(userId)) {
      pendingVents.delete(userId);

      const confession = new Confession({
        userId,
        username: ctx.from.username || '',
        name: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
        text,
        approved: false
      });
      await confession.save();

      await ctx.reply('✅ Vent received! Sent to admin for review.', persistentKeyboard());

      await bot.telegram.sendMessage(
        ADMIN_ID,
        `🆕 *New Vent Submission*\n\nFrom: ${confession.name} (${confession.username ? '@' + confession.username : 'no_username'})\nID: ${confession._id}\n\n${confession.text}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Approve', `approve_${confession._id}`),
              Markup.button.callback('❌ Reject', `reject_${confession._id}`)
            ]
          ])
        }
      );

      console.log(`🗣️ Vent received from ${confession.name}: ${confession.text}`);
      return;
    }

    // Unknown message
    return ctx.reply('❌ Unknown message. Use "🗣️ Vent Now" to start.', persistentKeyboard());
  } catch (err) {
    console.error('❌ Error:', err);
    ctx.reply('Something went wrong. Try again.');
  }
});

// ---------- Admin Actions ----------
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data || '';
  const actorId = String(ctx.from.id);

  try {
    // Admin approval or rejection
    if (data.startsWith('approve_') || data.startsWith('reject_')) {
      if (actorId !== ADMIN_ID) return ctx.answerCbQuery('🚫 Unauthorized', { show_alert: true });

      const [action, ventId] = data.split('_');
      const confession = await Confession.findById(ventId);
      if (!confession) return ctx.answerCbQuery('Not found.');

      if (action === 'approve') {
        let settings = await Settings.findOne({ key: 'nextVentNumber' });
        if (!settings) settings = await Settings.create({ key: 'nextVentNumber', value: START_VENT_NUMBER });

        const assignedNumber = settings.value;
        settings.value += 1;
        await settings.save();

        confession.approved = true;
        confession.rejected = false;
        confession.ventNumber = assignedNumber;

        const channelText = `*Vent #${confession.ventNumber}*\n\n${confession.text}\n\n*AMU Vent (@amuvent)*`;

        const sent = await bot.telegram.sendMessage(
          CHANNEL_ID,
          channelText,
          { parse_mode: 'Markdown', ...commentsButtonMarkup(confession._id.toString(), 0) }
        );

        confession.channelMessageId = sent.message_id;
        confession.commentsCount = 0;
        await confession.save();

        await ctx.editMessageReplyMarkup(undefined);
        await ctx.reply(`✅ Approved & posted (#${confession.ventNumber})`);

        try {
          await bot.telegram.sendMessage(confession.userId, `✅ Your vent has been approved and posted as Vent #${confession.ventNumber}.\nThank you for sharing!`);
        } catch {}

        await ctx.answerCbQuery('Posted!');
        return;
      }

      if (action === 'reject') {
        confession.rejected = true;
        confession.approved = false;
        await confession.save();
        await ctx.editMessageReplyMarkup(undefined);
        await ctx.reply('❌ Vent rejected.');
        try {
          await bot.telegram.sendMessage(confession.userId, '❌ Your vent has been reviewed but was not approved for posting.');
        } catch {}
        await ctx.answerCbQuery('Rejected.');
        return;
      }
    }

    // Browsing comments
    if (data.startsWith('browse_')) {
      const ventId = data.split('_')[1];
      const comments = await Comment.find({ ventId }).sort({ date: 1 }).lean();
      await ctx.answerCbQuery();
      if (!comments.length) return ctx.reply('No comments yet.');
      for (const c of comments) ctx.reply(`💬 ${c.text}\n\n👤 Anonymous`);
      return;
    }

    // Add comment
    if (data.startsWith('addcomment_')) {
      const ventId = data.split('_')[1];
      pendingComments.set(ctx.from.id, ventId);
      await ctx.answerCbQuery();
      return ctx.reply('✍️ Send your comment now.');
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error('callback_query error:', err);
    await ctx.answerCbQuery('Error occurred.');
  }
});

// ---------- Comment Menu ----------
async function showCommentMenu(ctx, ventId) {
  try {
    const confession = await Confession.findById(ventId).lean();
    if (!confession) return ctx.reply('Post not found.');

    const text = `Vent #${confession.ventNumber || '—'}\n\n${confession.text}\n\nAMU Vent (@amuvent)`;
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback('📖 Browse Comments', `browse_${ventId}`)],
      [Markup.button.callback('✍️ Add Comment', `addcomment_${ventId}`)]
    ]));
  } catch (err) {
    console.error('showCommentMenu error:', err);
    ctx.reply('Error showing comments.');
  }
}

// ---------- Admin: List Pending ----------
bot.command('pending', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
  const pending = await Confession.find({ approved: false }).sort({ date: -1 });
  if (!pending.length) return ctx.reply('No pending vents.');
  for (const p of pending) {
    await ctx.reply(
      `ID: ${p._id}\nFrom: ${p.name}\n\n${p.text}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve', `approve_${p._id}`), Markup.button.callback('❌ Reject', `reject_${p._id}`)]
      ])
    );
  }
});

// ---------- Launch Bot ----------
bot.launch().then(() => console.log('🚀 Bot is live!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
