const socket = io();
let me = "";

// AUTH
async function auth(type) {
    const u = document.getElementById('u').value;
    const p = document.getElementById('p').value;
    const err = document.getElementById('auth-err');
    
    if(!u || !p) return err.innerText = "Fill fields!";
    
    const res = await fetch(`/api/${type}`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({username:u, password:p})
    });
    const data = await res.json();
    
    if(res.ok) {
        if(type==='register') { alert("Registered! Login now."); }
        else {
            me = data.user.username;
            document.getElementById('auth-modal').style.display = 'none';
            socket.emit('join', me);
        }
    } else err.innerText = data.error;
}

// CHAT
document.getElementById('chat-in').onkeypress = (e) => {
    if(e.key === 'Enter') { socket.emit('chat', e.target.value); e.target.value=''; }
};
socket.on('msg', m => {
    const d = document.createElement('div');
    d.innerHTML = `<span style="color:${m.color}">${m.name}:</span> <span style="color:#fff">${m.text}</span>`;
    const h = document.getElementById('chat-hist');
    h.appendChild(d); h.scrollTop = h.scrollHeight;
});

// GAME STATE
socket.on('state', ({players, duel}) => {
    // 1. Player List
    document.getElementById('plist').innerHTML = Object.values(players).map(p => 
        `<div style="color:${p.color}; border-bottom:1px solid #333;">${p.name} <span class="yellow-t">$${p.balance}</span></div>`
    ).join('');

    // 2. Scores & Pot
    document.getElementById('sc-l').innerText = duel.score.l;
    document.getElementById('sc-r').innerText = duel.score.r;
    document.getElementById('pot').innerText = `POT: ${duel.pot}`;

    // 3. Seats
    renderSeat('seat-l', 'l', duel, players);
    renderSeat('seat-r', 'r', duel, players);

    // 4. Visuals & Action Button
    const center = document.getElementById('vis-text');
    if(duel.status === 'rolling') center.innerText = "ROLLING...";
    else if(duel.res) {
        if(duel.game === 'coin') center.innerText = duel.res.val;
        else {
            const sumL = duel.res.l.reduce((a,b)=>a+b);
            const sumR = duel.res.r.reduce((a,b)=>a+b);
            center.innerText = `${sumL} - ${sumR}`;
        }
    } else center.innerText = "VS";

    const isDuelist = players[socket.id] && (socket.id === duel.l || socket.id === duel.r);
    const mySide = socket.id === duel.l ? 'l' : 'r';
    const myTurn = duel.status === 'act' && isDuelist && !duel.actions[mySide];
    document.getElementById('act-btn').style.display = myTurn ? 'block' : 'none';

    // 5. Spectator
    const seated = duel.l === socket.id || duel.r === socket.id;
    document.getElementById('spec-bet').style.display = (!seated && (duel.status==='open')) ? 'flex' : 'none';
});

socket.on('balance_update', bal => {
    // Optional local balance update if needed
});

function renderSeat(id, side, duel, players) {
    const el = document.getElementById(id);
    const p = players[duel[side]];
    const locked = duel[side+'Lock'];
    const winner = duel.status === 'win' && duel.winnerId === duel[side]; // Logic correction here if needed, simplified for demo
    
    el.className = `seat ${p?'occupied':''} ${winner?'winner':''}`;

    if(!p) {
        el.innerHTML = `<button onclick="socket.emit('seat','${side}')" class="blue">SIT HERE</button>`;
    } else {
        const me = p.name === me;
        let controls = '';
        if(p.name === me) {
            controls = `
            <div style="width:100%; margin-top:auto;">
                <input id="bet" placeholder="BET" onchange="upd()" class="pixel-input">
                <select id="game" onchange="upd()" style="width:100%; background:#000; color:#fff;">
                    <option value="coin">Coin</option><option value="dice">Dice</option><option value="wheel">Wheel</option>
                </select>
                <select id="mode" onchange="upd()" style="width:100%; background:#000; color:#fff;">
                    <option value="bo3">BO3</option><option value="race3">Race to 3</option>
                </select>
                <button onclick="socket.emit('lock')" class="${locked?'green':'blue'}">${locked?'LOCKED':'LOCK'}</button>
                <button onclick="socket.emit('leave')" class="red">LEAVE</button>
            </div>`;
        } else {
            controls = `<div style="margin-top:auto; font-size:24px; color:${locked?'#0f0':'#555'}">${locked?'READY':'WAITING'}</div>`;
        }

        el.innerHTML = `
            <img src="https://api.dicebear.com/7.x/pixel-art/svg?seed=${p.name}" class="avatar" style="border-color:${p.color}">
            <div style="font-size:24px; color:${p.color}">${p.name}</div>
            <div class="yellow-t">$${p.balance}</div>
            ${controls}
        `;
        
        // Sync values if open
        if(p.name === me && duel.status === 'open') {
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
