const socket = io({ autoConnect: false });
let currentUser = null;
let currentMode = 'classic';

// --- AUTH ---
async function login() {
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({username: u, password: p})
        });
        const data = await res.json();
        if(data.token) {
            localStorage.setItem('token', data.token);
            document.getElementById('auth-overlay').classList.add('hidden');
            connectSocket(data.token);
        } else {
            document.getElementById('auth-msg').innerText = data.error;
        }
    } catch(e) { console.error(e); }
}

async function register() {
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    await fetch('/api/register', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: u, password: p})
    });
    alert('Registered! Please login.');
}

function connectSocket(token) {
    socket.auth = { token };
    socket.connect();
}

// --- SOCKET EVENTS ---
socket.on('connect', () => {
    document.getElementById('conn-status').innerText = "LIVE: PH";
    document.getElementById('conn-status').classList.add('text-green');
});

socket.on('init', (data) => {
    currentUser = data.user;
    document.getElementById('credit-bal').innerText = currentUser.credits;
    renderChat(data.chat);
    updateState(data.state);
});

socket.on('state_update', (state) => {
    updateState(state);
});

socket.on('chat_new', (msg) => {
    appendChat(msg);
});

socket.on('balance_update', (amt) => {
    document.getElementById('credit-bal').innerText = amt;
});

socket.on('classic_phase', (data) => {
    document.getElementById('status-text').innerText = data.phase;
    document.getElementById('timer-text').innerText = data.timer;
    if(data.result) {
        document.getElementById('classic-result').innerHTML = data.result.result.map(c => 
            `<span style="color:${c.toLowerCase()}">■</span>`
        ).join(' ');
    }
});

socket.on('duel_event', (data) => {
    alert(data.msg); // Use toast in real app
});

socket.on('error', (msg) => alert(msg));

// --- UI LOGIC ---
function updateState(state) {
    // Players List
    const list = document.getElementById('player-list');
    list.innerHTML = state.players.map(p => `<div>${p.username} <small>(${p.status})</small></div>`).join('');
    document.getElementById('player-count').innerText = state.onlineCount;

    // Classic Logic (Sync timer if just joined)
    if(currentMode === 'classic') {
        document.getElementById('timer-text').innerText = state.classic.timer;
        document.getElementById('status-text').innerText = state.classic.phase;
    }

    // Duel Logic
    renderDuelSeats(state.duel);
}

function switchMode(mode) {
    currentMode = mode;
    document.getElementById('view-classic').classList.toggle('hidden', mode !== 'classic');
    document.getElementById('view-duel').classList.toggle('hidden', mode !== 'duel');
}

// --- CLASSIC ---
function placeBet(color) {
    const amount = document.getElementById('bet-amount').value;
    if(!amount) return alert('Enter amount');
    socket.emit('place_bet_classic', { selection: color, amount });
}

// --- DUEL ---
function renderDuelSeats(duelState) {
    const left = duelState.seats.left;
    const right = duelState.seats.right;
    
    updateSeat('left', left);
    updateSeat('right', right);

    const controls = document.getElementById('duel-controls');
    controls.innerHTML = '';
    
    // Proposal Logic
    if (duelState.proposal && duelState.proposal.to === currentUser.username) {
        controls.classList.remove('hidden');
        controls.innerHTML = `
            <h3>Challenge from ${duelState.proposal.from}</h3>
            <p>Game: ${duelState.proposal.game} | Bet: ${duelState.proposal.bet}</p>
            <button onclick="socket.emit('duel_respond', 'ACCEPT')">ACCEPT</button>
            <button onclick="socket.emit('duel_respond', 'DECLINE')">DECLINE</button>
        `;
    } else if (left?.username === currentUser.username || right?.username === currentUser.username) {
        if (!duelState.proposal && !duelState.match) {
            controls.classList.remove('hidden');
            controls.innerHTML = `
                <button onclick="socket.emit('duel_leave')">LEAVE SEAT</button>
                <button onclick="proposeDuel()">PROPOSE MATCH</button>
            `;
        } else {
            controls.classList.add('hidden');
        }
    } else {
        controls.classList.add('hidden');
    }

    if(duelState.match) {
        document.getElementById('duel-info').innerHTML = `MATCH LIVE!<br>Pot: ${duelState.match.pot}`;
    }
}

function updateSeat(side, data) {
    const el = document.getElementById(`seat-${side}`);
    if(data) {
        el.classList.add('occupied');
        el.querySelector('.seat-name').innerText = data.username;
        el.querySelector('button').style.display = 'none';
    } else {
        el.classList.remove('occupied');
        el.querySelector('.seat-name').innerText = 'Empty';
        el.querySelector('button').style.display = 'block';
    }
}

function sitDuel(side) { socket.emit('duel_sit', side); }

function proposeDuel() {
    const bet = prompt("Bet Amount:");
    if(bet) socket.emit('duel_propose', { game: '3DICE', bet });
}

// --- CHAT ---
function renderChat(history) {
    const box = document.getElementById('chat-box');
    box.innerHTML = '';
    history.forEach(appendChat);
}

function appendChat(msg) {
    const box = document.getElementById('chat-box');
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<span class="chat-time">[${msg.time.split(',')[1].trim()}]</span> <span class="chat-user">${msg.username}:</span> ${msg.text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function sendChat() {
    const inp = document.getElementById('chat-input');
    socket.emit('chat_msg', inp.value);
    inp.value = '';
}

function refreshState() {
    socket.emit('request_snapshot'); // Would need backend handler, or just reconnect
    socket.disconnect();
    socket.connect();
}

function openTicketModal(type) {
    const amt = prompt("Amount:");
    if(amt) socket.emit('create_ticket', { type, amount: amt, msg: 'Request via UI' });
}

// --- VOICE (Placeholder Logic) ---
function toggleVoice() {
    alert("Voice Chat connects via WebRTC. (Implemented in backend signaling)");
}

// Check for token on load
if(localStorage.getItem('token')) {
    document.getElementById('auth-overlay').classList.add('hidden');
    connectSocket(localStorage.getItem('token'));
}