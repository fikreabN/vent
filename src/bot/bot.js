const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server is running on port " + PORT);
});

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

const Confession = require('../models/Confession');
const Comment = require('../models/Comment');
const Settings = require('../models/Settings');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const CHANNEL_ID = process.env.CHANNEL_ID;
const START_VENT_NUMBER = parseInt(process.env.START_VENT_NUMBER || '1', 10) || 1;

if (!BOT_TOKEN || !ADMIN_ID || !CHANNEL_ID || !process.env.MONGODB_URI) {
  console.error('❌ Missing required .env variables.');
  process.exit(1);
}



// ---------- MongoDB Connection ----------
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

const bot = new Telegraf(BOT_TOKEN);
let BOT_USERNAME = null;

// in-memory state
const pendingVents = new Map();     // userId -> true
const pendingComments = new Map();  // userId -> ventId

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

// ---------- Get bot username ----------
(async () => {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    console.log('🤖 Bot username:', BOT_USERNAME);
  } catch (err) {
    console.error('⚠️ Could not fetch bot username yet:', err.message);
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
  ctx.reply('📝 Type your vent and send, it will go through a review befor being posted.', persistentKeyboard());
});

bot.command('vent', (ctx) => {
  pendingVents.set(ctx.from.id, true);
  ctx.reply('📝 Type your vent and send, it will go through a review befor being posted.', persistentKeyboard());
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
// ---------- Admin Actions ----------
// ---------- Admin Actions ----------
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data || '';
  const actorId = String(ctx.from.id);

  try {
    // Admin approval or rejection
    if (data.startsWith('approve_') || data.startsWith('reject_')) {
      if (actorId !== ADMIN_ID) {
        return ctx.answerCbQuery('🚫 Unauthorized', { show_alert: true });
      }

      const [action, ventId] = data.split('_');
      const confession = await Confession.findById(ventId);
      if (!confession) return ctx.answerCbQuery('Not found.');

      if (action === 'approve') {
        // Step 1: Ensure settings doc exists
        let settings = await Settings.findOne({ key: 'nextVentNumber' });
        if (!settings) {
          settings = await Settings.create({
            key: 'nextVentNumber',
            value: START_VENT_NUMBER
          });
        }

        // Step 2: Assign and increment
        const assignedNumber = settings.value;
        settings.value += 1;
        await settings.save();

        // Step 3: Post to channel
        confession.approved = true;
        confession.rejected = false;
        confession.ventNumber = assignedNumber;

const channelText = `*Vent #${confession.ventNumber}*\n\n${confession.text}\n\n*AMU Vent (@amuvent)*`;

const sent = await bot.telegram.sendMessage(
  CHANNEL_ID,
  channelText,
  {
    parse_mode: 'Markdown',
    ...commentsButtonMarkup(confession._id.toString(), 0)
  }
        );

        confession.channelMessageId = sent.message_id;
        confession.commentsCount = 0;
        await confession.save();

        // Step 4: Remove buttons instead of deleting the whole message
        await ctx.editMessageReplyMarkup(undefined);

        // Step 5: Add confirmation text below
        await ctx.reply(`✅ Approved & posted (#${confession.ventNumber})`);

        // Step 6: Notify user who sent the vent (if possible)
        try {
          await bot.telegram.sendMessage(
            confession.userId,
            `✅ Your vent has been approved and posted as Vent #${confession.ventNumber}.\nThank you for sharing!`
          );
        } catch (err) {
          console.warn(`⚠️ Could not notify user ${confession.userId}:`, err.message);
        }

        await ctx.answerCbQuery('Posted!');
        console.log(`✅ Posted Vent #${confession.ventNumber}`);
        return;
      }

      if (action === 'reject') {
        // Mark as rejected instead of deleting
        confession.rejected = true;
        confession.approved = false;
        await confession.save();

        // Remove only buttons
        await ctx.editMessageReplyMarkup(undefined);

        // Send rejection notice below
        await ctx.reply('❌ Vent rejected.');

        // Notify user who sent the vent
        try {
          await bot.telegram.sendMessage(
            confession.userId,
            '❌ Your vent has been reviewed but was not approved for posting.'
          );
        } catch (err) {
          console.warn(`⚠️ Could not notify user ${confession.userId}:`, err.message);
        }

        await ctx.answerCbQuery('Rejected.');
        return;
      }
    }

    // ---------- Browsing comments ----------
    if (data.startsWith('browse_')) {
      const ventId = data.split('_')[1];
      const comments = await Comment.find({ ventId }).sort({ date: 1 }).lean();
      await ctx.answerCbQuery();
      if (!comments.length) return ctx.reply('No comments yet.');
      for (const c of comments) {
        const who = 'Anonymous';
        await ctx.reply(`💬 ${c.text}\n\n 👤 ${who}`);
      }
      return;
    }

    // ---------- Add comment ----------
    if (data.startsWith('addcomment_')) {
      const ventId = data.split('_')[1];
      pendingComments.set(ctx.from.id, ventId);
      await ctx.answerCbQuery();
      return ctx.reply('✍️ Send your comment now.');
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error('callback_query error:', err);
    ctx.answerCbQuery('Error occurred.');
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
        [
          Markup.button.callback('✅ Approve', `approve_${p._id}`),
          Markup.button.callback('❌ Reject', `reject_${p._id}`)
        ]
      ])
    );
  }
});


// ---------- Start ----------
bot.launch().then(() => console.log('🚀 Bot is live!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));




