const socket = io();
let me = "";

async function auth(type) {
    const u = document.getElementById('u').value.trim();
    const p = document.getElementById('p').value.trim();
    const err = document.getElementById('err');
    
    if(!u || !p) return err.innerText = "Please fill all fields.";
    
    err.innerText = "Processing...";
    
    try {
        const res = await fetch(`/api/${type}`, {
            method: 'POST', 
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({username:u, password:p})
        });
        const data = await res.json();
        
        if(res.ok) {
            if(type==='register') {
                err.style.color = "#00ff00";
                err.innerText = "Success! Please Login.";
            } else {
                me = data.user.username;
                document.getElementById('auth-modal').style.display='none';
                socket.emit('join', me);
            }
        } else {
            err.style.color = "red";
            err.innerText = data.error;
        }
    } catch(e) { err.innerText = "Server Error. Check Database."; }
}

function logout() { fetch('/api/logout', {method:'POST'}).then(()=>location.reload()); }

socket.on('state', ({players, duel}) => {
    document.getElementById('plist').innerHTML = Object.values(players).map(p => 
        `<div class="p-bar"><span style="color:${p.color}">${p.name}</span> <span class="neon">$${p.balance}</span></div>`
    ).join('');

    document.getElementById('pot').innerText = `POT: ${duel.pot}`;
    document.getElementById('sc-l').innerText = duel.score.l;
    document.getElementById('sc-r').innerText = duel.score.r;

    seat('seat-l', 'l', duel, players);
    seat('seat-r', 'r', duel, players);

    // Visuals
    const vis = document.getElementById('vis');
    if(duel.status==='rolling') vis.innerText = "ROLLING...";
    else if(duel.res) {
        if(duel.game === 'coin') vis.innerText = duel.res.val;
        else if(duel.game === 'dice') vis.innerText = `${duel.res.l.reduce((a,b)=>a+b)} - ${duel.res.r.reduce((a,b)=>a+b)}`;
    } else vis.innerText = "VS";

    const isMe = (duel.l && players[duel.l]?.name===me) || (duel.r && players[duel.r]?.name===me);
    const mySide = (duel.l && players[duel.l]?.name===me) ? 'l' : 'r';
    const myTurn = duel.status==='act' && isMe && !duel.actions[mySide];
    
    document.getElementById('act-btn').style.display = myTurn ? 'block' : 'none';
    document.getElementById('act-btn').innerText = duel.game==='dice' ? 'ROLL!' : 'SPIN!';
});

function seat(id, side, duel, players) {
    const el = document.getElementById(id);
    const p = players[duel[side]];
    
    el.className = `seat ${p?'occupied':''} ${duel.status==='win'&&duel.res&&duel.winnerId===duel[side]?'winner':''}`;

    if(!p) el.innerHTML = `<button onclick="socket.emit('seat','${side}')" class="blue">SIT HERE</button>`;
    else {
        const isMe = p.name === me;
        el.innerHTML = `
            <img src="https://api.dicebear.com/7.x/pixel-art/svg?seed=${p.name}" width="80" style="border:2px solid ${p.color}; margin-bottom:10px;">
            <div style="font-size:24px; color:${p.color}">${p.name}</div>
            <div class="neon">$${p.balance}</div>
            ${isMe && duel.status==='open' ? `
                <div style="width:100%; margin-top:auto;">
                    <input id="bet" placeholder="BET" onchange="upd()" value="${duel.bet}">
                    <select id="game" onchange="upd()" style="margin:5px 0;">
                        <option value="coin">Coin</option><option value="dice">Dice</option>
                    </select>
                    <button onclick="socket.emit('lock')" class="${duel[side+'Lock']?'green':'blue'}">${duel[side+'Lock']?'READY':'LOCK'}</button>
                    <button onclick="socket.emit('leave')" class="red" style="margin-top:5px;">LEAVE</button>
                </div>
            ` : `<div style="margin-top:auto; font-size:24px; color:${duel[side+'Lock']?'#0f0':'#888'}">${duel[side+'Lock']?'READY':'WAITING'}</div>`}
        `;
    }
}

function upd() { socket.emit('update_settings', { bet: document.getElementById('bet').value, game: document.getElementById('game').value, mode: 'bo3' }); }
function act() { socket.emit('act'); }
