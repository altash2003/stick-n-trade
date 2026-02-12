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

// --- FIX: DATABASE CONNECTION ---
// This now checks ALL possible variable names to ensure it connects.
const DB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/sticknduel';

console.log("🔌 Connecting to Database...");
mongoose.connect(DB_URI)
    .then(() => console.log('✅ MongoDB Connected Successfully!'))
    .catch(err => {
        console.error('❌ DB Connection Error:', err.message);
        console.error('👉 CHECK RAILWAY VARIABLES: Ensure MONGODB_URI is set.');
    });

// --- DATA MODELS ---
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

// --- ROUTES ---

// REGISTER
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    
    // 1. Check DB Connection State
    if (mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: "Database not connected. Contact Admin." });
    }

    if (!/^[A-Za-z0-9]{3,12}$/.test(username)) return res.status(400).json({ error: "Username: 3-12 chars, letters/nums only." });
    if (password.length < 5) return res.status(400).json({ error: "Password must be at least 5 chars." });

    try {
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "Username is already taken." });

        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirst = (await User.countDocuments({})) === 0;
        const color = ["#00ffff", "#00ff00", "#ffff00", "#ff00ff", "#ff4444"][Math.floor(Math.random()*5)];
        
        await new User({ 
            username, 
            password: hashedPassword, 
            role: isFirst ? 'admin' : 'user',
            color
        }).save();
        
        res.status(201).json({ message: "Registered successfully" });
    } catch (e) {
        console.error("Register Error:", e);
        res.status(500).json({ error: "Server Error during registration." });
    }
});

// LOGIN
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: "Database not connected." });
    }

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: "User not found." });
        
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ error: "Invalid password." });
        
        if (user.banned) return res.status(403).json({ error: "Account Banned." });

        const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret');
        res.cookie('token', token, { httpOnly: true }).json({ 
            user: { username: user.username, role: user.role, balance: user.balance } 
        });
    } catch (e) {
        console.error("Login Error:", e);
        res.status(500).json({ error: "Login failed. Check server logs." });
    }
});

app.post('/api/logout', (req, res) => res.clearCookie('token').json({ success: true }));

// Admin API
app.get('/api/admin/users', adminAuth, async (req, res) => {
    try {
        const users = await User.find({}).select('-password').sort({ balance: -1 });
        res.json(users);
    } catch(e) { res.status(500).json({ error: "DB Error" }); }
});

app.post('/api/admin/action', adminAuth, async (req, res) => {
    const { userId, type, amount, status } = req.body;
    try {
        if(type === 'balance') {
            const val = parseInt(amount);
            await User.findByIdAndUpdate(userId, { $inc: { balance: val } });
            
            const socketId = Object.keys(players).find(id => players[id].dbId === userId);
            if(socketId) {
                const u = await User.findById(userId);
                players[socketId].balance = u.balance;
                io.to(socketId).emit('balance_update', u.balance);
                io.to(socketId).emit('msg', { name: 'SYSTEM', text: `Admin Credit Update: ${val}`, color: '#ffd700' });
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

// --- GAME LOGIC ---
let players = {};
let duel = {
    l: null, r: null, game: 'dice', mode: 'bo3', bet: 0, 
    status: 'open', pot: 0, lLock: false, rLock: false, 
    score: { l: 0, r: 0 }, actions: { l: false, r: false }, specBets: {} 
};

io.on('connection', (socket) => {
    socket.on('join', async (name) => {
        const u = await User.findOne({ username: name });
        if(u) {
            players[socket.id] = { id: socket.id, dbId: u._id.toString(), name: u.username, balance: u.balance, color: u.color, role: u.role };
            io.emit('msg', { name: 'SYSTEM', text: `${u.username} joined.`, color: '#ccc' });
            broadcast();
        }
    });

    socket.on('chat', (text) => {
        const p = players[socket.id];
        if(p) io.emit('msg', { name: p.name, text, color: p.color });
    });

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
    duel.status = 'locked'; duel.pot = duel.bet * 2;
    const p1 = players[duel.l]; const p2 = players[duel.r];
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
            
            for(let sid in duel.specBets) {
                const bet = duel.specBets[sid];
                if(bet.side === (duel.score.l >= target ? 'l' : 'r') && players[sid]) {
                    const winAmt = bet.amt * 2;
                    await User.findByIdAndUpdate(players[sid].dbId, { $inc: { balance: winAmt } });
                    players[sid].balance += winAmt;
                    io.to(sid).emit('balance_update', players[sid].balance);
                }
            }
            broadcast();
            setTimeout(() => { resetGame(); broadcast(); }, 5000);
        } else {
            duel.status = 'act'; duel.actions = {l:false, r:false};
            if(duel.game === 'coin') setTimeout(resolveRound, 2000); else broadcast();
        }
    }, 3000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
