const mongoose = require('mongoose');

const LogSchema = new mongoose.Schema({
    action: String, // e.g., "BET_PLACED", "DUEL_WIN", "LOGIN"
    details: String,
    username: String,
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Log', LogSchema);
