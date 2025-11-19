const mongoose = require('mongoose');

const confessionSchema = new mongoose.Schema({
  userId: String,
  username: String,
  name: String,
  text: String,
  approved: Boolean,
  ventNumber: Number,
  channelMessageId: Number,
  commentsCount: { type: Number, default: 0 },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Confession', confessionSchema);
