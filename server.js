require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// --- CRITICAL FIX: LOWERCASE IMPORTS TO MATCH GITHUB ---
const User = require('./models/user');     
const Ticket = require('./models/ticket'); 
const Log = require('./models/log');       

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- DB CONNECTION ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error(err));

// --- GLOBAL STATE ---
const STATE = {
    activePlayers: {}, // socketId -> { username, role, room }
    duel: {
        seats: { left: null, right: null },
        proposal: null,
        match: null 
    },
    chatHistory: []
};

// --- AUTH MIDDLEWARE FOR ADMIN ---
const isAdmin = async (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        if (user && user.role === 'admin') {
            req.user = user;
            next();
        } else {
            res.status(403).json({ error: 'Admins only' });
        }
    } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
};

// --- API ROUTES ---

// Register
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!/^[a-zA-Z0-9]{3,12}$/.test(username)) return res.status(400).json({ error: 'Username 3-12 chars' });
        const existing = await User.findOne({ username });
        if(existing) return res.status(400).json({ error: 'Username taken' });

        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ username, password: hashedPassword });
        res.json({ message: 'Registered' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user._id, username: user.username, role: user.role }, process.env.JWT_SECRET);
    res.json({ token, role: user.role });
});

// --- ADMIN API ---

// 1. Get Dashboard Data
app.get('/api/admin/data', isAdmin, async (req, res) => {
    const users = await User.find({}, 'username credits role isOnline lastSeen');
    const tickets = await Ticket.find({}).sort({ timestamp: -1 });
    res.json({ users, tickets });
});

// 2. Direct Topup (Syncs Instantly)
app.post('/api/admin/topup', isAdmin, async (req, res) => {
    const { username, amount, note } = req.body;
    const user = await User.findOneAndUpdate({ username }, { $inc: { credits: amount } }, { new: true });
    
    if(user) {
        // Log it
        await Log.create({ action: 'ADMIN_TOPUP', username, details: `${amount} TC - ${note}` });

        // Real-time Sync: Find user's socket and update their balance
        const socketId = Object.keys(STATE.activePlayers).find(key => STATE.activePlayers[key].username === username);
        if(socketId) {
            io.to(socketId).emit('balance_update', user.credits);
            io.to(socketId).emit('duel_event', { msg: `ADMIN SENT YOU ${amount} TC` });
        }
        res.json({ success: true, newBalance: user.credits });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// 3. Reply to Ticket
app.post('/api/admin/ticket/reply', isAdmin, async (req, res) => {
    const { id, reply } = req.body;
    const ticket = await Ticket.findByIdAndUpdate(id, { 
        adminReply: reply,
        status: 'open' 
    }, { new: true });
    res.json({ success: true, ticket });
});

// 4. Close Ticket
app.post('/api/admin/ticket/close', isAdmin, async (req, res) => {
    const { id } = req.body;
    await Ticket.findByIdAndUpdate(id, { status: 'closed' });
    res.json({ success: true });
});


// --- SOCKET.IO GAME LOGIC ---
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Auth error'));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = await User.findById(decoded.id);
        next();
    } catch (e) { next(new Error('Auth error')); }
});

io.on('connection', (socket) => {
    const user = socket.user;
    STATE.activePlayers[socket.id] = { username: user.username, role: user.role };
    
    // Send initial snapshot
    socket.emit('init', {
        user: { username: user.username, credits: user.credits, role: user.role },
        state: STATE,
        chat: STATE.chatHistory
    });
    
    // Broadcast presence
    broadcastState();

    // Chat
    socket.on('chat_msg', (msg) => {
        if (!msg || msg.length > 100) return;
        const chatMsg = { username: user.username, text: msg };
        STATE.chatHistory.push(chatMsg);
        if (STATE.chatHistory.length > 50) STATE.chatHistory.shift();
        io.emit('chat_new', chatMsg);
    });

    // Duel: Sit
    socket.on('duel_sit', (side) => {
        if (STATE.duel.seats[side]) return; 
        if (Object.values(STATE.duel.seats).some(s => s?.username === user.username)) return;
        STATE.duel.seats[side] = { username: user.username, socketId: socket.id };
        broadcastState();
    });

    // Duel: Leave
    socket.on('duel_leave', () => {
        if (STATE.duel.seats.left?.username === user.username) STATE.duel.seats.left = null;
        if (STATE.duel.seats.right?.username === user.username) STATE.duel.seats.right = null;
        STATE.duel.proposal = null;
        broadcastState();
    });

    // Duel: Propose
    socket.on('duel_propose', (data) => {
        if (!STATE.duel.seats.left || !STATE.duel.seats.right) return;
        STATE.duel.proposal = {
            from: user.username,
            to: (user.username === STATE.duel.seats.left.username) ? STATE.duel.seats.right.username : STATE.duel.seats.left.username,
            game: data.game,
            bet: parseInt(data.bet),
            rounds: parseInt(data.rounds)
        };
        broadcastState();
    });

    // Duel: Respond & Match Logic
    socket.on('duel_respond', async (response) => {
        if (!STATE.duel.proposal || STATE.duel.proposal.to !== user.username) return;

        if (response === 'DECLINE') {
            STATE.duel.proposal = null;
            broadcastState();
        } else {
            // ACCEPT - Start Match
            const p1 = await User.findOne({username: STATE.duel.seats.left.username});
            const p2 = await User.findOne({username: STATE.duel.seats.right.username});
            const bet = STATE.duel.proposal.bet;

            if (p1.credits < bet || p2.credits < bet) {
                STATE.duel.proposal = null;
                return io.emit('duel_event', { msg: 'MATCH CANCELLED: INSUFFICIENT FUNDS' });
            }

            // Deduct Funds
            p1.credits -= bet; await p1.save();
            p2.credits -= bet; await p2.save();
            
            // Sync Balance Instantly
            io.to(STATE.duel.seats.left.socketId).emit('balance_update', p1.credits);
            io.to(STATE.duel.seats.right.socketId).emit('balance_update', p2.credits);

            STATE.duel.match = {
                active: true,
                game: STATE.duel.proposal.game,
                pot: bet * 2,
                round: 1,
                target: parseInt(STATE.duel.proposal.rounds), 
                scores: { left: 0, right: 0 }
            };
            STATE.duel.proposal = null;
            
            // Run Game Loop
            runDuelMatch();
            broadcastState();
        }
    });
    
    // Support Ticket (User Side)
    socket.on('create_ticket', async (data) => {
        await Ticket.create({ username: user.username, type: data.type, message: data.message });
        socket.emit('duel_event', { msg: 'TICKET SUBMITTED' });
    });

    socket.on('disconnect', () => {
        delete STATE.activePlayers[socket.id];
        if (STATE.duel.seats.left?.socketId === socket.id) STATE.duel.seats.left = null;
        if (STATE.duel.seats.right?.socketId === socket.id) STATE.duel.seats.right = null;
        broadcastState();
    });
});

// Broadcast Global State
const broadcastState = () => {
    io.emit('state_update', {
        duel: STATE.duel,
        onlineCount: Object.keys(STATE.activePlayers).length,
        players: Object.values(STATE.activePlayers)
    });
};

// Simple Duel Logic (50/50 Coin Flip for demo)
async function runDuelMatch() {
    setTimeout(async () => {
        const winner = Math.random() > 0.5 ? 'left' : 'right';
        const winSeat = STATE.duel.seats[winner];
        
        if (winSeat) {
            await User.findOneAndUpdate({ username: winSeat.username }, { $inc: { credits: STATE.duel.match.pot } });
            
            // Sync Winner Balance
            const dbUser = await User.findOne({username:winSeat.username});
            if(dbUser) io.to(winSeat.socketId).emit('balance_update', dbUser.credits);
        }

        io.emit('duel_event', { msg: `WINNER: ${winSeat ? winSeat.username : 'Unknown'}` });
        STATE.duel.match = null;
        broadcastState();
    }, 4000); // 4 seconds delay for suspense
}

server.listen(process.env.PORT || 3000, () => console.log('Server Running'));
