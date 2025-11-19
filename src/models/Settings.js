// backend/src/models/Settings.js
const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Number, required: true }
});

module.exports = mongoose.model('Settings', settingsSchema);
