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
const MONGO_URI = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/sticknduel';
console.log("🔌 Connecting to DB...");
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected!'))
    .catch(err => console.error('❌ DB Error:', err.message));

// --- DATA MODELS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, match: /^[A-Za-z0-9]{3,12}$/ },
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

// Auth
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!/^[A-Za-z0-9]{3,12}$/.test(username)) return res.status(400).json({ error: "User: 3-12 chars, letters/nums only" });
    if (password.length < 3) return res.status(400).json({ error: "Password too short" });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirst = (await User.countDocuments({})) === 0;
        // Assign Random Neon Color
        const colors = ["#ff0055", "#00ccff", "#00ff99", "#ffff00", "#ff9900", "#cc00ff"];
        const color = colors[Math.floor(Math.random() * colors.length)];
        
        await new User({ 
            username, 
            password: hashedPassword, 
            role: isFirst ? 'admin' : 'user',
            color
        }).save();
        res.status(201).json({ message: "Registered" });
    } catch (e) { res.status(500).json({ error: "Username taken" }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "Invalid credentials" });
        if (user.banned) return res.status(403).json({ error: "BANNED" });

        const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret');
        res.cookie('token', token, { httpOnly: true }).json({ 
            user: { username: user.username, role: user.role, balance: user.balance, color: user.color } 
        });
    } catch (e) { res.status(500).json({ error: "Login failed" }); }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token').json({ success: true });
});

// Admin
app.get('/api/admin/users', adminAuth, async (req, res) => {
    const users = await User.find({}).select('-password').sort({ balance: -1 });
    res.json(users);
});

app.post('/api/admin/action', adminAuth, async (req, res) => {
    const { userId, type, amount, status } = req.body;
    try {
        if(type === 'balance') {
            const val = parseInt(amount);
            await User.findByIdAndUpdate(userId, { $inc: { balance: val } });
            
            // Real-time update
            const socketId = Object.keys(players).find(id => players[id].dbId === userId);
            if(socketId) {
                const u = await User.findById(userId);
                players[socketId].balance = u.balance;
                io.to(socketId).emit('balance_update', u.balance);
                io.to(socketId).emit('msg', { name: 'SYSTEM', text: `Admin sent credits: ${val}`, color: '#ffd700' });
            }
        } 
        else if (type === 'ban') {
            await User.findByIdAndUpdate(userId, { banned: status });
            const socketId = Object.keys(players).find(id => players[id].dbId === userId);
            if(socketId && status) io.sockets.sockets.get(socketId)?.disconnect(true);
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Action failed" }); }
});

// --- GAME STATE ---
let players = {};
let duel = {
    l: null, r: null, 
    game: 'dice', mode: 'bo3', bet: 0, 
    status: 'open', pot: 0,
    lLock: false, rLock: false, 
    actions: { l: false, r: false },
    score: { l: 0, r: 0 },
    specBets: {} 
};

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    
    socket.on('join', async (username) => {
        const u = await User.findOne({ username });
        if(!u) return;
        players[socket.id] = { id: socket.id, dbId: u._id.toString(), name: u.username, balance: u.balance, color: u.color, role: u.role };
        io.emit('msg', { name: 'SYSTEM', text: `${u.username} connected.`, color: '#ccc' });
        broadcast();
    });

    socket.on('seat', (side) => {
        if (duel.status !== 'open') return;
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
        duel.bet = parseInt(data.bet) || 0;
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
        if(p) io.emit('msg', { name: p.name, text, color: p.color, role: p.role });
    });

    socket.on('disconnect', () => {
        if(duel.l === socket.id || duel.r === socket.id) resetGame();
        delete players[socket.id];
        broadcast();
    });
});

function broadcast() { io.emit('state', { players, duel }); }
function resetLocks() { duel.lLock=false; duel.rLock=false; duel.status='open'; duel.score={l:0,r:0}; duel.actions={l:false,r:false}; duel.specBets={}; }
function resetGame() { resetLocks(); duel.l=null; duel.r=null; duel.pot=0; duel.res=null; }

async function startMatch() {
    duel.status = 'locked';
    duel.pot = duel.bet * 2;
    // Deduct Funds
    const p1 = players[duel.l]; const p2 = players[duel.r];
    await User.findByIdAndUpdate(p1.dbId, { $inc: { balance: -duel.bet } });
    await User.findByIdAndUpdate(p2.dbId, { $inc: { balance: -duel.bet } });
    p1.balance -= duel.bet; p2.balance -= duel.bet;
    
    broadcast();
    setTimeout(() => { 
        duel.actions = {l:false, r:false};
        duel.status = (duel.game === 'coin') ? 'rolling' : 'act';
        if(duel.game === 'coin') resolveRound();
        else broadcast();
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
    } else { // Wheel
        res.val = winL ? "LEFT" : "RIGHT";
    }
    duel.res = res;
    broadcast();

    setTimeout(async () => {
        if(winL) duel.score.l++; else duel.score.r++;
        const target = duel.mode.includes('3') ? (duel.mode.startsWith('race')?3:2) : (duel.mode.startsWith('race')?5:3);
        
        if(duel.score.l >= target || duel.score.r >= target) {
            duel.status = 'win';
            const winnerId = duel.score.l >= target ? duel.l : duel.r;
            const winSide = duel.score.l >= target ? 'l' : 'r';
            
            // Payout Winner
            const winner = players[winnerId];
            await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: duel.pot } });
            winner.balance += duel.pot;

            // Payout Specs
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
            if(duel.game === 'coin') setTimeout(resolveRound, 2000);
            else broadcast();
        }
    }, 3000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
