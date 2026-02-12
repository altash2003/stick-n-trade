const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
    username: String,
    type: { type: String, enum: ['topup', 'withdraw', 'support'] },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'closed'], default: 'pending' },
    message: String,
    amount: Number, // Only for topup/withdraw
    adminReply: String,
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Ticket', TicketSchema);
