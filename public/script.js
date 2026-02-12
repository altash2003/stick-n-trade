const socket = io();
let me = "";

// --- AUTH FUNCTION (FIXED) ---
async function attemptAuth(type) {
    const u = document.getElementById('u').value.trim();
    const p = document.getElementById('p').value.trim();
    const status = document.getElementById('auth-status');
    const btn = type === 'login' ? document.getElementById('btn-login') : document.getElementById('btn-reg');

    // 1. Basic Validation
    if (!u || !p) {
        status.innerText = "Please enter Username and Password.";
        return;
    }

    // 2. UI Feedback
    status.innerText = "Processing...";
    status.style.color = "yellow";
    btn.disabled = true;

    try {
        // 3. Send Request
        console.log(`Sending ${type} request for ${u}...`);
        
        const res = await fetch(`/api/${type}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });

        const data = await res.json();

        // 4. Handle Response
        if (res.ok) {
            if (type === 'register') {
                status.innerText = "Account Created! Please Login.";
                status.style.color = "#00ff00";
            } else {
                // Login Success
                me = data.user.username;
                document.getElementById('auth-modal').style.display = 'none';
                socket.emit('join', me);
                console.log("Login successful!");
            }
        } else {
            // Server Error Message
            status.innerText = data.error || "Request Failed";
            status.style.color = "red";
        }
    } catch (e) {
        console.error(e);
        status.innerText = "Server Connection Error. Refresh Page.";
        status.style.color = "red";
    } finally {
        btn.disabled = false;
    }
}

// --- GAME LOGIC ---

document.getElementById('chat-in').onkeypress = (e) => {
    if (e.key === 'Enter') {
        socket.emit('chat', e.target.value);
        e.target.value = '';
    }
};

socket.on('msg', m => {
    const d = document.createElement('div');
    d.innerHTML = `<span style="color:${m.color}">${m.name}:</span> ${m.text}`;
    const h = document.getElementById('chat-hist');
    h.appendChild(d);
    h.scrollTop = h.scrollHeight;
});

socket.on('state', ({ players, duel }) => {
    // Player List
    document.getElementById('plist').innerHTML = Object.values(players).map(p =>
        `<div style="border-bottom:1px solid #333; padding:5px; color:${p.color}">
            ${p.name} <span style="float:right; color:#ffd700">$${p.balance}</span>
        </div>`
    ).join('');

    // Game Data
    document.getElementById('pot').innerText = `POT: ${duel.pot}`;
    document.getElementById('sc-l').innerText = duel.score.l;
    document.getElementById('sc-r').innerText = duel.score.r;

    renderSeat('seat-l', 'l', duel, players);
    renderSeat('seat-r', 'r', duel, players);

    // Visuals
    const vis = document.getElementById('vis-text');
    if (duel.status === 'rolling') vis.innerText = "ROLLING...";
    else if (duel.res) {
        if (duel.game === 'coin') vis.innerText = duel.res.val;
        else if (duel.game === 'dice') {
            const lSum = duel.res.l.reduce((a, b) => a + b, 0);
            const rSum = duel.res.r.reduce((a, b) => a + b, 0);
            vis.innerText = `${lSum} - ${rSum}`;
        } else vis.innerText = duel.res.val;
    } else vis.innerText = "VS";

    // Action Button
    const isMe = (duel.l && players[duel.l]?.name === me) || (duel.r && players[duel.r]?.name === me);
    const mySide = (duel.l && players[duel.l]?.name === me) ? 'l' : 'r';
    const myTurn = duel.status === 'act' && isMe && !duel.actions[mySide];
    
    document.getElementById('act-btn').style.display = myTurn ? 'block' : 'none';
    document.getElementById('act-btn').innerText = duel.game === 'dice' ? "ROLL!" : "SPIN!";

    // Spectator
    const seated = (duel.l && players[duel.l]?.name === me) || (duel.r && players[duel.r]?.name === me);
    document.getElementById('spec-bet').style.display = (!seated && duel.status === 'open') ? 'flex' : 'none';
});

function renderSeat(id, side, duel, players) {
    const el = document.getElementById(id);
    const p = players[duel[side]];
    
    el.className = `seat ${p ? 'occupied' : ''} ${duel.status==='win' && duel.winnerId === duel[side] ? 'winner' : ''}`;

    if (!p) {
        el.innerHTML = `<button onclick="socket.emit('seat','${side}')" style="width:100%; height:100%; background:transparent; border:none; color:#555; cursor:pointer; font-size:20px;">SIT HERE</button>`;
    } else {
        const isMe = p.name === me;
        let controls = '';
        
        if (isMe) {
            controls = `
            <div style="margin-top:auto; width:100%;">
                <input id="bet" placeholder="BET" onchange="upd()" style="width:100%; background:#000; color:#0f0; border:1px solid #555;">
                <select id="game" onchange="upd()" style="width:100%; background:#000; color:#fff; margin:5px 0;">
                    <option value="coin">Coin</option><option value="dice">Dice</option><option value="wheel">Wheel</option>
                </select>
                <select id="mode" onchange="upd()" style="width:100%; background:#000; color:#fff; margin-bottom:5px;">
                    <option value="bo3">BO3</option><option value="race3">Race 3</option>
                </select>
                <button onclick="socket.emit('lock')" style="width:100%; background:${duel[side+'Lock']?'#00cc00':'#0088ff'}; color:white;">
                    ${duel[side+'Lock']?'READY':'LOCK'}
                </button>
                <button onclick="socket.emit('leave')" style="width:100%; background:#cc0000; color:white; margin-top:5px;">LEAVE</button>
            </div>`;
        } else {
            controls = `<div style="margin-top:auto; color:${duel[side+'Lock']?'#00ff00':'#888'}; font-size:24px;">${duel[side+'Lock']?'READY':'WAITING'}</div>`;
        }

        el.innerHTML = `
            <img src="https://api.dicebear.com/7.x/pixel-art/svg?seed=${p.name}" style="width:80px; height:80px; border:2px solid ${p.color}; image-rendering:pixelated;">
            <div style="font-size:24px; color:${p.color}">${p.name}</div>
            <div style="color:#ffd700">$${p.balance}</div>
            ${controls}
        `;
        
        if(isMe && duel.status === 'open') {
             if(document.activeElement.id !== 'bet') document.getElementById('bet').value = duel.bet;
             if(document.activeElement.id !== 'game') document.getElementById('game').value = duel.game;
             if(document.activeElement.id !== 'mode') document.getElementById('mode').value = duel.mode;
        }
    }
}

function upd() {
    socket.emit('update_settings', {
        bet: document.getElementById('bet').value,
        game: document.getElementById('game').value,
        mode: document.getElementById('mode').value
    });
}
function act() { socket.emit('act'); }
function spec(side) { 
    const amt = document.getElementById('s-amt').value;
    if(amt > 0) socket.emit('spec_bet', { side, amt }); 
}
