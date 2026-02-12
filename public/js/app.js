const socket = io({ autoConnect: false });
let currentUser = null;
let currentGame = 'DICE';

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
            document.getElementById('app-container').classList.remove('hidden');
            connectSocket(data.token);
        } else {
            const err = document.getElementById('auth-msg');
            err.innerText = data.error;
            setTimeout(() => err.innerText = '', 3000);
        }
    } catch(e) { console.error(e); }
}

async function register() {
    // Reusing the same inputs for simplicity in this retro UI
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    if(!u || !p) return alert("Fill user/pass");
    await fetch('/api/register', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: u, password: p})
    });
    alert('REGISTERED! NOW LOGIN.');
}

function connectSocket(token) {
    socket.auth = { token };
    socket.connect();
}

function logout() {
    localStorage.removeItem('token');
    location.reload();
}

// --- STATE MANAGEMENT ---
socket.on('init', (data) => {
    currentUser = data.user;
    document.getElementById('my-username').innerText = currentUser.username;
    document.getElementById('credit-bal').innerText = currentUser.credits;
    document.getElementById('mini-bal').innerText = currentUser.credits; // sidebar
    renderChat(data.chat);
    updateState(data.state);
});

socket.on('state_update', updateState);
socket.on('balance_update', (amt) => {
    document.getElementById('credit-bal').innerText = amt;
    document.getElementById('mini-bal').innerText = amt;
});

socket.on('duel_event', (data) => {
    const display = document.getElementById('match-display');
    display.innerHTML = `<div class="text-gold blink" style="font-family:'Press Start 2P'; text-align:center">${data.msg}</div>`;
});

function updateState(state) {
    // 1. Players List
    const list = document.getElementById('player-list');
    list.innerHTML = state.players.map(p => {
        const badgeClass = p.role === 'admin' ? 'badge-admin' : 'badge-user';
        return `<div class="p-row"><span class="p-badge ${badgeClass}"></span> ${p.username}</div>`
    }).join('');
    document.getElementById('online-count').innerText = state.onlineCount;

    // 2. Duel Seats
    renderSeat('left', state.duel.seats.left);
    renderSeat('right', state.duel.seats.right);

    // 3. Match Logic / Controls
    const controls = document.getElementById('duel-controls');
    const alertBox = document.getElementById('proposal-alert');
    const status = document.getElementById('match-status');
    const display = document.getElementById('match-display');

    // Reset visibility defaults
    controls.classList.add('hidden');
    alertBox.classList.add('hidden');
    
    // Am I seated?
    const mySeat = (state.duel.seats.left?.username === currentUser.username) ? 'left' 
                 : (state.duel.seats.right?.username === currentUser.username) ? 'right' : null;

    if (state.duel.match) {
        status.innerText = "MATCH IN PROGRESS";
        status.classList.add('text-red');
        status.classList.add('blink');
        // If match is running, basic display (detailed anims would go here)
        if(!display.innerHTML.includes('text-gold')) { 
            display.innerHTML = `<div class="text-red" style="font-size:3rem">${state.duel.match.game}</div>`;
        }
    } else {
        status.innerText = "WAITING FOR PLAYERS...";
        status.classList.remove('text-red', 'blink');
        
        // Show controls if I am seated and no match is active
        if (mySeat) {
            controls.classList.remove('hidden');
            // If I have a proposal pending towards me
            if (state.duel.proposal && state.duel.proposal.to === currentUser.username) {
                alertBox.classList.remove('hidden');
                document.getElementById('proposal-details').innerText = 
                    `${state.duel.proposal.from} wants to play ${state.duel.proposal.game} for ${state.duel.proposal.bet} TC`;
            }
        }
    }
}

function renderSeat(side, data) {
    const pod = document.getElementById(`pod-${side}`);
    const nameEl = document.getElementById(`p${side === 'left' ? '1' : '2'}-name`);
    const btn = document.getElementById(`btn-sit-${side}`);
    const avatar = document.getElementById(`p${side === 'left' ? '1' : '2'}-avatar`);

    if (data) {
        // Occupied
        pod.style.borderColor = 'var(--neon-blue)';
        nameEl.innerText = data.username;
        btn.classList.add('hidden');
        avatar.style.backgroundColor = 'var(--neon-blue)';
    } else {
        // Empty
        pod.style.borderColor = '#333';
        nameEl.innerText = "EMPTY";
        btn.classList.remove('hidden');
        avatar.style.backgroundColor = '#111';
    }
}

// --- ACTIONS ---
function switchGame(game) {
    currentGame = game;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
}

function sitDuel(side) { socket.emit('duel_sit', side); }

function proposeDuel() {
    const bet = document.getElementById('proposal-bet').value;
    const rounds = document.getElementById('round-setting').value;
    if(!bet || bet <= 0) return alert("INVALID BET");
    socket.emit('duel_propose', { game: currentGame, bet, rounds });
}

function sendChat() {
    const inp = document.getElementById('chat-input');
    if(inp.value.trim()) {
        socket.emit('chat_msg', inp.value);
        inp.value = '';
    }
}

function renderChat(history) {
    const box = document.getElementById('chat-box');
    box.innerHTML = '';
    history.forEach(msg => {
        const d = document.createElement('div');
        d.className = 'chat-msg';
        d.innerHTML = `<span class="chat-user">${msg.username}:</span> ${msg.text}`;
        box.appendChild(d);
    });
    box.scrollTop = box.scrollHeight;
}

socket.on('chat_new', (msg) => {
    const box = document.getElementById('chat-box');
    const d = document.createElement('div');
    d.className = 'chat-msg';
    d.innerHTML = `<span class="chat-user">${msg.username}:</span> ${msg.text}`;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
});

// --- UI HELPERS ---
function toggleModal(id) {
    const m = document.getElementById(id);
    m.classList.toggle('hidden');
}

function refreshState() {
    location.reload(); 
}

// Check auth on load
if(localStorage.getItem('token')) {
    document.getElementById('auth-overlay').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    connectSocket(localStorage.getItem('token'));
}
