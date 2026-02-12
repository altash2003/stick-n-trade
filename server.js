require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require("socket.io");
const path = require('path');
const cors = require('cors');

// --- SERVER SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());

// --- DATABASE CONNECTION ---
console.log("🔌 Attempting to connect to DB...");
mongoose.connect(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/sticknduel')
    .then(() => console.log('✅ MongoDB Connected!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- DATA MODELS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, match: /^[A-Za-z0-9]{5,12}$/ },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 },
    role: { type: String, default: 'user' }, // 'admin' or 'user'
    banned: { type: Boolean, default: false },
    color: { type: String, default: '#00ff00' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- AUTH MIDDLEWARE ---
const adminAuth = async (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Access denied" });
    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const user = await User.findById(verified._id);
        if (user.role !== 'admin') return res.status(403).json({ error: "Admins only" });
        next();
    } catch (err) { res.status(400).json({ error: "Invalid Token" }); }
};

// --- API ROUTES ---

// Register
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!/^[A-Za-z0-9]{5,12}$/.test(username)) return res.status(400).json({ error: "User: 5-12 chars, letters/nums only" });
    if (password.length < 5 || password.length > 12) return res.status(400).json({ error: "Pass: 5-12 chars" });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        // First user is automatically Admin
        const isFirst = (await User.countDocuments({})) === 0;
        const color = ["#00ffff", "#00ff00", "#ffff00", "#ff00ff", "#ff4444"][Math.floor(Math.random()*5)];
        
        await new User({ 
            username, 
            password: hashedPassword, 
            role: isFirst ? 'admin' : 'user',
            color
        }).save();
        res.status(201).json({ message: "Registered" });
    } catch (e) { res.status(500).json({ error: "Username taken or DB error" }); }
});

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "Invalid credentials" });
        if (user.banned) return res.status(403).json({ error: "You are BANNED" });

        const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret');
        res.cookie('token', token, { httpOnly: true }).json({ 
            user: { username: user.username, role: user.role, balance: user.balance } 
        });
    } catch (e) { res.status(500).json({ error: "Login failed" }); }
});

// Admin: Get Users
app.get('/api/admin/users', adminAuth, async (req, res) => {
    const users = await User.find({}).select('-password').sort({ balance: -1 });
    res.json(users);
});

// Admin: Top-up / Withdraw / Ban
app.post('/api/admin/action', adminAuth, async (req, res) => {
    const { userId, type, amount, status } = req.body;
    try {
        if(type === 'balance') {
            const val = parseInt(amount); // Positive adds, negative removes
            await User.findByIdAndUpdate(userId, { $inc: { balance: val } });
            
            // Live Socket Update
            const socketId = Object.keys(players).find(id => players[id].dbId === userId);
            if(socketId) {
                const u = await User.findById(userId);
                players[socketId].balance = u.balance;
                io.to(socketId).emit('balance_update', u.balance);
                io.to(socketId).emit('msg', { name: 'SYSTEM', text: `Wallet updated: ${val > 0 ? '+' : ''}${val}`, color: '#ffd700' });
            }
        } 
        else if (type === 'ban') {
            await User.findByIdAndUpdate(userId, { banned: status });
            // Kick user if online
            const socketId = Object.keys(players).find(id => players[id].dbId === userId);
            if(socketId && status) io.sockets.sockets.get(socketId)?.disconnect(true);
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Action failed" }); }
});

// --- GAME LOGIC ---
let players = {};
let duel = {
    l: null, r: null, 
    game: 'coin', mode: 'bo3', bet: 0, 
    status: 'open', pot: 0,
    lLock: false, rLock: false, 
    actions: { l: false, r: false },
    score: { l: 0, r: 0 },
    specBets: {} 
};

io.on('connection', (socket) => {
    // Join Lobby
    socket.on('join', async (username) => {
        const u = await User.findOne({ username });
        if(!u) return;
        players[socket.id] = { id: socket.id, dbId: u._id.toString(), name: u.username, balance: u.balance, color: u.color, role: u.role };
        io.emit('msg', { name: 'SYSTEM', text: `${u.username} joined.`, color: '#fff' });
        broadcast();
    });

    // Game Actions
    socket.on('seat', (side) => {
        if (side === 'l' && !duel.l) duel.l = socket.id;
        if (side === 'r' && !duel.r) duel.r = socket.id;
        resetLocks(); broadcast();
    });

    socket.on('leave', () => {
        if(duel.l === socket.id) duel.l = null;
        if(duel.r === socket.id) duel.r = null;
        resetGame(); broadcast();
    });

    socket.on('update_settings', (data) => {
        if(socket.id !== duel.l && socket.id !== duel.r) return;
        duel.bet = parseInt(data.bet);
        duel.game = data.game;
        duel.mode = data.mode;
        resetLocks(); broadcast();
    });

    socket.on('lock', async () => {
        const p = players[socket.id];
        const u = await User.findById(p.dbId);
        if(u.balance < duel.bet) return socket.emit('msg', { name:'SYS', text:'Insufficient funds!', color:'red' });

        if(socket.id === duel.l) duel.lLock = !duel.lLock;
        if(socket.id === duel.r) duel.rLock = !duel.rLock;
        broadcast();

        if(duel.lLock && duel.rLock && duel.l && duel.r) startMatch();
    });

    socket.on('act', () => {
        if(duel.status !== 'act') return;
        if(socket.id === duel.l) duel.actions.l = true;
        if(socket.id === duel.r) duel.actions.r = true;
        broadcast();
        if(duel.actions.l && duel.actions.r) resolveRound();
    });

    // Spectator Betting
    socket.on('spec_bet', async (data) => {
        const p = players[socket.id];
        const u = await User.findById(p.dbId);
        if(u.balance >= data.amt && duel.status === 'open') {
            await User.findByIdAndUpdate(p.dbId, { $inc: { balance: -data.amt } });
            p.balance -= data.amt;
            duel.specBets[socket.id] = { side: data.side, amt: parseInt(data.amt) };
            socket.emit('balance_update', p.balance);
            io.emit('msg', { name:'SYS', text:`${p.name} bet ${data.amt} on ${data.side.toUpperCase()}`, color:'#aaa' });
        }
    });

    socket.on('chat', (text) => {
        const p = players[socket.id];
        if(p) io.emit('msg', { name: p.name, text, color: p.color });
    });

    socket.on('disconnect', () => {
        if(duel.l === socket.id || duel.r === socket.id) resetGame();
        delete players[socket.id];
        broadcast();
    });
});

// --- HELPERS ---
function broadcast() { io.emit('state', { players, duel }); }
function resetLocks() { duel.lLock=false; duel.rLock=false; duel.status='open'; duel.score={l:0,r:0}; duel.actions={l:false,r:false}; duel.specBets={}; }
function resetGame() { resetLocks(); duel.l=null; duel.r=null; duel.pot=0; duel.res=null; }

async function startMatch() {
    duel.status = 'locked';
    duel.pot = duel.bet * 2;
    // Deduct
    const p1 = players[duel.l]; const p2 = players[duel.r];
    await User.findByIdAndUpdate(p1.dbId, { $inc: { balance: -duel.bet } });
    await User.findByIdAndUpdate(p2.dbId, { $inc: { balance: -duel.bet } });
    p1.balance -= duel.bet; p2.balance -= duel.bet;
    
    broadcast();
    setTimeout(() => { 
        duel.actions = {l:false, r:false};
        if(duel.game === 'coin') { duel.status='rolling'; resolveRound(); }
        else { duel.status='act'; broadcast(); }
    }, 2000);
}

function resolveRound() {
    duel.status = 'rolling';
    let winL = Math.random() > 0.5;
    let res = {};
    
    if(duel.game === 'coin') res.val = winL ? 'HEADS' : 'TAILS';
    else {
        const r = () => Math.floor(Math.random()*6)+1;
        res.l = [r(),r(),r()]; res.r = [r(),r(),r()];
        const sumL = res.l.reduce((a,b)=>a+b);
        const sumR = res.r.reduce((a,b)=>a+b);
        winL = sumL > sumR; // Tie goes to Right for simplicity
        if(sumL === sumR) winL = Math.random() > 0.5; // True tie break
    }
    duel.res = res;
    broadcast();

    setTimeout(async () => {
        if(winL) duel.score.l++; else duel.score.r++;
        
        const target = duel.mode.includes('3') ? (duel.mode.startsWith('race')?3:2) : (duel.mode.startsWith('race')?5:3);
        
        if(duel.score.l >= target || duel.score.r >= target) {
            // Match Over
            duel.status = 'win';
            const winnerId = duel.score.l >= target ? duel.l : duel.r;
            const winSide = duel.score.l >= target ? 'l' : 'r';
            
            // Payout Winner
            const winner = players[winnerId];
            await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: duel.pot } });
            winner.balance += duel.pot;

            // Payout Specs (1:1)
            for(let sid in duel.specBets) {
                const bet = duel.specBets[sid];
                if(bet.side === winSide && players[sid]) {
                    const winAmt = bet.amt * 2;
                    await User.findByIdAndUpdate(players[sid].dbId, { $inc: { balance: winAmt } });
                    players[sid].balance += winAmt;
                    io.to(sid).emit('balance_update', players[sid].balance);
                }
            }
            broadcast();
            setTimeout(() => { resetGame(); broadcast(); }, 6000);
        } else {
            duel.status = 'act';
            duel.actions = {l:false, r:false};
            if(duel.game === 'coin') { setTimeout(resolveRound, 2000); }
            else broadcast();
        }
    }, 3000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
