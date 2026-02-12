const socket = io();
let me = "";

// AUTH
async function auth(type) {
    const u = document.getElementById('u').value;
    const p = document.getElementById('p').value;
    const res = await fetch(`/api/${type}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username:u, password:p})
    });
    const data = await res.json();
    if(res.ok) {
        if(type==='register') alert("Registered! Login now.");
        else {
            me = data.user.username;
            document.getElementById('auth-modal').style.display='none';
            socket.emit('join', me);
        }
    } else document.getElementById('err').innerText = data.error;
}

function logout() { fetch('/api/logout', {method:'POST'}).then(()=>location.reload()); }

// CHAT
document.getElementById('chat-in').onkeypress = e => {
    if(e.key==='Enter') { socket.emit('chat', e.target.value); e.target.value=''; }
};
socket.on('msg', m => {
    const d = document.createElement('div');
    d.innerHTML = `<span style="color:${m.color}">${m.name}:</span> ${m.text}`;
    document.getElementById('chat-hist').appendChild(d);
});

// GAME
socket.on('state', ({players, duel}) => {
    // Players
    document.getElementById('plist').innerHTML = Object.values(players).map(p => 
        `<div class="p-bar ${p.role==='admin'?'admin':''}">
            <img src="https://api.dicebear.com/7.x/pixel-art/svg?seed=${p.name}" class="p-icon">
            ${p.name} <span style="margin-left:auto; color:#ffd700">$${p.balance}</span>
        </div>`
    ).join('');

    // Game Info
    document.getElementById('pot').innerText = `POT: ${duel.pot}`;
    document.getElementById('sc-l').innerText = duel.score.l;
    document.getElementById('sc-r').innerText = duel.score.r;

    // Seats
    renderSeat('seat-l', 'l', duel, players);
    renderSeat('seat-r', 'r', duel, players);

    // Center Visuals
    const vis = document.getElementById('vis');
    if(duel.status === 'rolling') vis.innerText = "ROLLING...";
    else if(duel.res) {
        if(duel.game === 'coin') vis.innerText = duel.res.val;
        else if(duel.game === 'dice') vis.innerText = `${duel.res.l.reduce((a,b)=>a+b)} - ${duel.res.r.reduce((a,b)=>a+b)}`;
        else vis.innerText = duel.res.val;
    } else vis.innerText = "VS";

    // Action Button
    const isMe = (duel.l && players[duel.l]?.name===me) || (duel.r && players[duel.r]?.name===me);
    const mySide = duel.l && players[duel.l]?.name===me ? 'l' : 'r';
    const showAct = duel.status==='act' && isMe && !duel.actions[mySide];
    document.getElementById('act-btn').style.display = showAct ? 'block' : 'none';
    document.getElementById('act-btn').innerText = duel.game==='dice' ? 'ROLL!' : 'SPIN!';

    // Spectator
    const seated = isMe;
    document.getElementById('spec-ui').style.display = (!seated && duel.status==='open') ? 'flex' : 'none';
});

function renderSeat(id, side, duel, players) {
    const el = document.getElementById(id);
    const p = players[duel[side]];
    const lock = duel[side+'Lock'];
    
    el.className = `seat ${p?'occupied':''} ${duel.status==='win'&&duel.res&&duel.res.winnerId===duel[side]?'winner':''}`;

    if(!p) {
        el.innerHTML = `<button onclick="socket.emit('seat','${side}')" class="blue">SIT HERE</button>`;
    } else {
        const isMe = p.name === me;
        let ctrls = '';
        if(isMe) {
            ctrls = `
            <div class="controls">
                <input id="bet" placeholder="BET" onchange="upd()">
                <select id="game" onchange="upd()"><option value="dice">Dice</option><option value="coin">Coin</option><option value="wheel">Wheel</option></select>
                <select id="mode" onchange="upd()"><option value="bo3">Best of 3</option><option value="race3">Race to 3</option></select>
                <button onclick="socket.emit('lock')" class="${lock?'green':'blue'}">${lock?'READY':'LOCK'}</button>
                <button onclick="socket.emit('leave')" class="red">LEAVE</button>
            </div>`;
        } else {
            ctrls = `<div style="margin-top:auto; font-size:24px; color:${lock?'#0f0':'#888'}">${lock?'READY':'WAITING...'}</div>`;
        }

        el.innerHTML = `
            <img src="https://api.dicebear.com/7.x/pixel-art/svg?seed=${p.name}" width="80" style="border:2px solid ${p.color}">
            <div style="font-size:24px; color:${p.color}">${p.name}</div>
            <div style="color:#ffd700">$${p.balance}</div>
            ${ctrls}
        `;
        if(isMe && duel.status==='open') {
            if(document.activeElement.id!=='bet') document.getElementById('bet').value = duel.bet;
            if(document.activeElement.id!=='game') document.getElementById('game').value = duel.game;
            if(document.activeElement.id!=='mode') document.getElementById('mode').value = duel.mode;
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
    if(amt>0) socket.emit('spec_bet', {side, amt}); 
}
