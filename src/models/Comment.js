const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  ventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Confession', required: true },
  userId: { type: String, required: true },
  username: { type: String },
  name: { type: String },
  text: { type: String, required: true },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Comment', commentSchema);
