require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('./models/User');
const Ticket = require('./models/Ticket');
const Log = require('./models/Log');

// --- SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- DB CONNECT ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error(err));

// --- GLOBAL STATE ---
// In a production app, this might be in Redis. For this project, memory is fine.
const STATE = {
    classic: {
        timer: 30,
        phase: 'BETTING', // BETTING, ROLLING, RESULT
        history: [], // Last 15 results
        bets: [] // Current round bets: { username, type, amount }
    },
    duel: {
        seats: { left: null, right: null }, // { username, avatar, socketId }
        proposal: null, // { from, to, game, rounds, bet, pot }
        match: null, // { active: bool, game: str, scores: {left:0, right:0}, round: 1, history: [] }
        spectatorBets: []
    },
    activePlayers: {}, // socketId -> username
    chatHistory: [] // last 50 messages
};

// --- UTILS ---
const getPHTime = () => new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });

const logAction = async (action, username, details) => {
    try { await Log.create({ action, username, details }); } catch(e){}
};

const broadcastState = () => {
    // Send public state to everyone
    io.emit('state_update', {
        classic: { ...STATE.classic, bets: STATE.classic.bets.map(b => ({...b, amount: 'HIDDEN'})) }, // Hide bet amounts for privacy if needed, or show total
        duel: STATE.duel,
        onlineCount: Object.keys(STATE.activePlayers).length,
        players: Object.values(STATE.activePlayers)
    });
};

// --- GAME LOOPS ---
// Classic Casino Loop
setInterval(async () => {
    if (STATE.classic.timer > 0) {
        STATE.classic.timer--;
        if (STATE.classic.timer === 0) {
            // Phase Change logic
            if (STATE.classic.phase === 'BETTING') {
                STATE.classic.phase = 'ROLLING';
                STATE.classic.timer = 5; // Roll animation time
                io.emit('classic_phase', { phase: 'ROLLING', timer: 5 });
            } else if (STATE.classic.phase === 'ROLLING') {
                await resolveClassicRound();
                STATE.classic.phase = 'RESULT';
                STATE.classic.timer = 5; // Show result time
                io.emit('classic_phase', { phase: 'RESULT', timer: 5, result: STATE.classic.history[0] });
            } else if (STATE.classic.phase === 'RESULT') {
                STATE.classic.phase = 'BETTING';
                STATE.classic.timer = 30;
                STATE.classic.bets = []; // Clear bets
                io.emit('classic_phase', { phase: 'BETTING', timer: 30 });
            }
        }
    }
}, 1000);

async function resolveClassicRound() {
    // COLOR GAME LOGIC (3 Dice: Red, Green, Blue, Yellow, Pink, White)
    const colors = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
    const dice = [
        colors[Math.floor(Math.random() * 6)],
        colors[Math.floor(Math.random() * 6)],
        colors[Math.floor(Math.random() * 6)]
    ];
    
    // Add to history
    STATE.classic.history.unshift({ type: 'COLOR', result: dice });
    if (STATE.classic.history.length > 15) STATE.classic.history.pop();

    // Payouts
    for (let bet of STATE.classic.bets) {
        let winMultiplier = 0;
        dice.forEach(d => { if(d === bet.selection) winMultiplier++; });
        
        if (winMultiplier > 0) {
            // Payout: Bet * Multiplier + Original Bet
            const winAmount = (bet.amount * winMultiplier) + bet.amount;
            await User.findOneAndUpdate({ username: bet.username }, { $inc: { credits: winAmount } });
            logAction('WIN_CLASSIC', bet.username, `Won ${winAmount} on ${bet.selection}`);
        }
    }
}

// --- REST API (AUTH) ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!/^[a-zA-Z0-9]{5,12}$/.test(username)) return res.status(400).json({ error: 'Invalid username' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ username, password: hashedPassword });
        res.json({ message: 'Registered' });
    } catch (e) { res.status(400).json({ error: 'Username taken' }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user._id, username: user.username, role: user.role }, process.env.JWT_SECRET);
    res.json({ token, role: user.role });
});

// Admin Bootstrap (Run once then delete/secure)
app.get('/api/admin-seed', async (req, res) => {
    if(req.query.key !== process.env.ADMIN_SECRET) return res.sendStatus(403);
    const hash = await bcrypt.hash('admin123', 10);
    try {
        await User.create({ username: 'admin', password: hash, role: 'admin', credits: 999999 });
        res.send('Admin Created');
    } catch(e) { res.send('Admin exists'); }
});

// --- SOCKET.IO ---
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = await User.findById(decoded.id);
        next();
    } catch (e) { next(new Error('Authentication error')); }
});

io.on('connection', (socket) => {
    const user = socket.user;
    STATE.activePlayers[socket.id] = { username: user.username, role: user.role, status: 'Browsing' };
    
    // Initial Sync
    socket.emit('init', {
        user: { username: user.username, credits: user.credits, role: user.role },
        state: STATE,
        chat: STATE.chatHistory
    });

    broadcastState();

    // --- GENERAL ---
    socket.on('chat_msg', (msg) => {
        if (!msg || msg.length > 100) return;
        const chatMsg = { username: user.username, text: msg, time: getPHTime() };
        STATE.chatHistory.push(chatMsg);
        if (STATE.chatHistory.length > 50) STATE.chatHistory.shift();
        io.emit('chat_new', chatMsg);
    });

    // Voice Signaling
    socket.on('voice_signal', (data) => {
        // Broadcast to everyone else (simple mesh)
        socket.broadcast.emit('voice_signal_relay', { from: user.username, data: data });
    });

    // --- CLASSIC GAME ---
    socket.on('place_bet_classic', async (data) => {
        if (STATE.classic.phase !== 'BETTING') return;
        const amount = parseInt(data.amount);
        if (isNaN(amount) || amount <= 0) return;

        const dbUser = await User.findById(user._id);
        if (dbUser.credits < amount) return socket.emit('error', 'Insufficient funds');

        // Deduct
        dbUser.credits -= amount;
        await dbUser.save();
        socket.emit('balance_update', dbUser.credits);

        STATE.classic.bets.push({ username: user.username, selection: data.selection, amount });
        logAction('BET_CLASSIC', user.username, `${amount} on ${data.selection}`);
        
        // Broadcast updated pot info (without revealing exact amounts if desired, but here we keep it simple)
        io.emit('classic_bets_update', STATE.classic.bets);
    });

    // --- DUEL ARENA ---
    socket.on('duel_sit', (side) => {
        if (STATE.duel.seats[side]) return; // Taken
        // Check if already seated
        if (Object.values(STATE.duel.seats).some(s => s?.username === user.username)) return;

        STATE.duel.seats[side] = { username: user.username, socketId: socket.id, score: 0 };
        broadcastState();
    });

    socket.on('duel_leave', () => {
        if (STATE.duel.seats.left?.username === user.username) STATE.duel.seats.left = null;
        if (STATE.duel.seats.right?.username === user.username) STATE.duel.seats.right = null;
        STATE.duel.proposal = null;
        broadcastState();
    });

    socket.on('duel_propose', (data) => {
        // data: { game, bet }
        // Only host (first seated usually, or anyone seated) can propose to opponent
        if (!STATE.duel.seats.left || !STATE.duel.seats.right) return socket.emit('error', 'Need opponent');
        
        STATE.duel.proposal = {
            from: user.username,
            to: (user.username === STATE.duel.seats.left.username) ? STATE.duel.seats.right.username : STATE.duel.seats.left.username,
            game: data.game,
            bet: parseInt(data.bet),
            status: 'PENDING'
        };
        broadcastState();
    });

    socket.on('duel_respond', async (response) => { // 'ACCEPT' or 'DECLINE'
        if (!STATE.duel.proposal || STATE.duel.proposal.to !== user.username) return;

        if (response === 'DECLINE') {
            // Kick decliner
            if (STATE.duel.seats.left.username === user.username) STATE.duel.seats.left = null;
            else STATE.duel.seats.right = null;
            STATE.duel.proposal = null;
        } else {
            // Accept - Validate Funds for BOTH
            const p1 = await User.findOne({username: STATE.duel.seats.left.username});
            const p2 = await User.findOne({username: STATE.duel.seats.right.username});
            const bet = STATE.duel.proposal.bet;

            if (p1.credits < bet || p2.credits < bet) {
                STATE.duel.proposal = null;
                return io.emit('error', 'Duel cancelled: Insufficient funds');
            }

            // Deduct
            p1.credits -= bet; await p1.save();
            p2.credits -= bet; await p2.save();
            
            // Notify clients to update balance
            io.to(STATE.duel.seats.left.socketId).emit('balance_update', p1.credits);
            io.to(STATE.duel.seats.right.socketId).emit('balance_update', p2.credits);

            // Start Match
            STATE.duel.match = {
                active: true,
                game: STATE.duel.proposal.game,
                pot: bet * 2,
                round: 1,
                scores: { left: 0, right: 0 },
                phase: 'PLAYING' // PLAYING, RESOLVING
            };
            STATE.duel.proposal = null; // Clear proposal
            
            runDuelMatch(STATE.duel.match.game);
        }
        broadcastState();
    });

    // --- SUPPORT ---
    socket.on('create_ticket', async (data) => {
        await Ticket.create({ username: user.username, type: data.type, message: data.msg, amount: data.amount });
        socket.emit('toast', 'Ticket Created');
    });

    socket.on('disconnect', () => {
        delete STATE.activePlayers[socket.id];
        // If in duel seat, leave logic
        if (STATE.duel.seats.left?.socketId === socket.id) STATE.duel.seats.left = null;
        if (STATE.duel.seats.right?.socketId === socket.id) STATE.duel.seats.right = null;
        broadcastState();
    });
});

// --- DUEL LOGIC ---
async function runDuelMatch(gameType) {
    // Simple Auto-Resolve for Dice for demo purposes
    // A real implementation would wait for socket inputs (e.g. Rock Paper Scissors reveals)
    
    // Simulate a delay for suspense
    setTimeout(async () => {
        let winnerSide = null; // 'left' or 'right'

        if (gameType === '3DICE') {
            const roll1 = Math.floor(Math.random() * 18) + 3;
            const roll2 = Math.floor(Math.random() * 18) + 3;
            winnerSide = roll1 > roll2 ? 'left' : 'right';
            if (roll1 === roll2) winnerSide = 'tie';
            
            io.emit('duel_event', { msg: `Left rolled ${roll1}, Right rolled ${roll2}` });
        } else {
            // Default coin flip
            winnerSide = Math.random() > 0.5 ? 'left' : 'right';
        }

        if (winnerSide && winnerSide !== 'tie') {
            // Payout
            const winnerSeat = STATE.duel.seats[winnerSide];
            if (winnerSeat) {
                await User.findOneAndUpdate({ username: winnerSeat.username }, { $inc: { credits: STATE.duel.match.pot } });
                io.emit('duel_event', { msg: `${winnerSeat.username} WINS the duel!` });
                io.to(winnerSeat.socketId).emit('balance_refresh_request'); // Force client to fetch balance
            }
        } else {
            // Tie - Refund
            const p1 = STATE.duel.seats.left;
            const p2 = STATE.duel.seats.right;
            const refund = STATE.duel.match.pot / 2;
             if(p1) await User.findOneAndUpdate({ username: p1.username }, { $inc: { credits: refund } });
             if(p2) await User.findOneAndUpdate({ username: p2.username }, { $inc: { credits: refund } });
             io.emit('duel_event', { msg: `It's a TIE! Money refunded.` });
        }

        // Reset Duel
        STATE.duel.match = null;
        broadcastState();

    }, 5000); // 5 second dramatic pause
}

// --- ADMIN ROUTES ---
app.get('/api/admin/data', async (req, res) => {
    // Basic protection (in prod use middleware)
    // We rely on admin.html doing a specific socket check or separate auth, 
    // for this demo we'll just check a header secret or keep it open for the "Admin" role via Socket
});

server.listen(process.env.PORT, () => console.log(`Server running on port ${process.env.PORT}`));