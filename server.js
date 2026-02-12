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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());

// --- DB CONNECTION FIX ---
// Uses MONGODB_URI (Matches your Railway screenshot)
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/sticknduel';
console.log("🔌 Connecting to DB at:", MONGO_URI.substring(0, 20) + "...");

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected!'))
    .catch(err => console.error('❌ DB Connection Error:', err));

// --- USER MODEL (Merged here to fix "Missing Module" crash) ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, match: /^[A-Za-z0-9]{3,12}$/ },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 },
    role: { type: String, default: 'user' },
    banned: { type: Boolean, default: false },
    color: { type: String, default: '#00ff00' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!/^[A-Za-z0-9]{3,12}$/.test(username)) return res.status(400).json({ error: "User: 3-12 chars, letters/nums only" });
    if (password.length < 5) return res.status(400).json({ error: "Pass: Min 5 chars" });

    try {
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "Username taken" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirst = (await User.countDocuments({})) === 0;
        const color = ["#00ffff", "#00ff00", "#ffff00", "#ff00ff", "#ff4444"][Math.floor(Math.random()*5)];
        
        await new User({ 
            username, password: hashedPassword, role: isFirst ? 'admin' : 'user', color
        }).save();
        res.status(201).json({ message: "Registered" });
    } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "Invalid credentials" });
        if (user.banned) return res.status(403).json({ error: "BANNED" });

        const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret');
        res.cookie('token', token, { httpOnly: true }).json({ 
            user: { username: user.username, role: user.role, balance: user.balance } 
        });
    } catch (e) { res.status(500).json({ error: "Login failed" }); }
});

app.post('/api/logout', (req, res) => res.clearCookie('token').json({ success: true }));

// --- GAME SOCKETS ---
let players = {};
let duel = {
    l: null, r: null, game: 'coin', mode: 'bo3', bet: 0, status: 'open', pot: 0,
    lLock: false, rLock: false, score: { l: 0, r: 0 }, actions: { l: false, r: false }, specBets: {}
};

io.on('connection', (socket) => {
    socket.on('join', async (name) => {
        const u = await User.findOne({ username: name });
        if(u) {
            players[socket.id] = { id: socket.id, dbId: u._id, name: u.username, balance: u.balance, color: u.color, role: u.role };
            broadcast();
        }
    });
    
    // ... (Game Logic)
    socket.on('seat', (side) => {
        if(side==='l' && !duel.l) duel.l = socket.id;
        if(side==='r' && !duel.r) duel.r = socket.id;
        resetLocks(); broadcast();
    });
    
    socket.on('update_settings', (d) => {
        if(socket.id === duel.l || socket.id === duel.r) {
            duel.bet = parseInt(d.bet); duel.game = d.game; duel.mode = d.mode;
            resetLocks(); broadcast();
        }
    });

    socket.on('lock', async () => {
        const p = players[socket.id];
        const u = await User.findById(p.dbId);
        if(u.balance < duel.bet) return; 

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

    socket.on('disconnect', () => {
        if(duel.l === socket.id || duel.r === socket.id) resetGame();
        delete players[socket.id];
        broadcast();
    });
});

function broadcast() { io.emit('state', { players, duel }); }
function resetLocks() { duel.lLock=false; duel.rLock=false; duel.status='open'; duel.score={l:0,r:0}; duel.actions={l:false,r:false}; }
function resetGame() { resetLocks(); duel.l=null; duel.r=null; duel.pot=0; duel.res=null; }

async function startMatch() {
    duel.status = 'locked'; duel.pot = duel.bet * 2;
    await User.findByIdAndUpdate(players[duel.l].dbId, { $inc: { balance: -duel.bet } });
    await User.findByIdAndUpdate(players[duel.r].dbId, { $inc: { balance: -duel.bet } });
    players[duel.l].balance -= duel.bet; players[duel.r].balance -= duel.bet;
    broadcast();
    setTimeout(() => { 
        duel.actions = {l:false, r:false};
        duel.status = (duel.game === 'coin') ? 'rolling' : 'act';
        if(duel.game === 'coin') resolveRound(); else broadcast();
    }, 2000);
}

function resolveRound() {
    duel.status = 'rolling';
    let winL = Math.random() > 0.5;
    let res = {};
    if(duel.game === 'coin') res.val = winL ? 'HEADS' : 'TAILS';
    else if(duel.game === 'dice') {
        const r = () => Math.floor(Math.random()*6)+1;
        res.l = [r(),r(),r()]; res.r = [r(),r(),r()];
        const sumL = res.l.reduce((a,b)=>a+b);
        const sumR = res.r.reduce((a,b)=>a+b);
        winL = sumL >= sumR; 
    } else { 
        res.val = winL ? "LEFT" : "RIGHT";
    }
    duel.res = res; broadcast();

    setTimeout(async () => {
        if(winL) duel.score.l++; else duel.score.r++;
        const target = duel.mode.includes('3') ? 2 : 3;
        
        if(duel.score.l >= target || duel.score.r >= target) {
            duel.status = 'win';
            const winnerId = duel.score.l >= target ? duel.l : duel.r;
            const winner = players[winnerId];
            await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: duel.pot } });
            winner.balance += duel.pot;
            broadcast();
            setTimeout(() => { resetGame(); broadcast(); }, 5000);
        } else {
            duel.status = 'act'; duel.actions = {l:false, r:false};
            if(duel.game === 'coin') setTimeout(resolveRound, 2000); else broadcast();
        }
    }, 3000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
