const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const sessions = {};

function randomKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/public/index.html' : '/public' + req.url;
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(session, msg, exclude) {
  session.players.forEach(p => {
    if (p !== exclude && p.readyState === WebSocket.OPEN)
      p.send(JSON.stringify(msg));
  });
}
function prunePlayers(session) {
  session.players = session.players.filter(
    p => p.readyState === WebSocket.OPEN || p.readyState === WebSocket.CONNECTING
  );
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ── CREATE SESSION ──────────────────────────────────────────
    if (data.type === 'create') {
      let key = randomKey();
      while (sessions[key]) key = randomKey();
      sessions[key] = { players: [ws], mapVotes: {} };
      ws.sessionKey = key;
      ws.playerIndex = 0;
      send(ws, { type: 'created', key });
    }

    // ── JOIN SESSION ────────────────────────────────────────────
    else if (data.type === 'join') {
      const key = (data.key || '').toUpperCase().trim();
      const s = sessions[key];
      if (!s) { send(ws, { type: 'error', msg: 'Session not found — check the code' }); return; }
      prunePlayers(s);
      if (s.players.length >= 2) { send(ws, { type: 'error', msg: 'Session is full' }); return; }
      s.players.push(ws);
      ws.sessionKey = key;
      ws.playerIndex = 1;
      send(ws, { type: 'joined', key });
      broadcast(s, { type: 'opponentJoined' }, ws);
    }

    // ── HOST STARTS THE GAME (triggers map vote for both) ───────
    else if (data.type === 'triggerStart') {
      const s = sessions[ws.sessionKey];
      if (!s || ws.playerIndex !== 0) return; // only host
      s.mapVotes = {}; // reset votes
      s.players.forEach(p => send(p, { type: 'beginMapVote' }));
    }

    // ── SKIN / WEAPON SELECTION (relay only) ────────────────────
    else if (data.type === 'selection') {
      const s = sessions[ws.sessionKey];
      if (!s) return;
      broadcast(s, { type: 'opponentSelection', data: data.data }, ws);
    }

    // ── MAP VOTE ────────────────────────────────────────────────
    else if (data.type === 'mapVote') {
      const s = sessions[ws.sessionKey];
      if (!s) return;
      s.mapVotes[ws.playerIndex] = data.map;
      broadcast(s, { type: 'opponentMapVote', map: data.map }, ws);

      // Both voted — server picks the map and starts
      const votes = Object.values(s.mapVotes);
      if (votes.length >= 2) {
        const chosen = votes[0] === votes[1]
          ? votes[0]
          : votes[Math.floor(Math.random() * votes.length)];
        s.mapVotes = {};
        s.players.forEach(p => send(p, { type: 'startGame', map: chosen }));
      }
    }

    // ── GAME STATE RELAY ─────────────────────────────────────────
    else if (data.type === 'state') {
      const s = sessions[ws.sessionKey];
      if (!s) return;
      broadcast(s, { ...data, from: ws.playerIndex }, ws);
    }
  });

  ws.on('close', () => {
    if (!ws.sessionKey) return;
    const s = sessions[ws.sessionKey];
    if (!s) return;
    broadcast(s, { type: 'opponentLeft' }, ws);
    prunePlayers(s);
    if (s.players.length === 0) delete sessions[ws.sessionKey];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ARENA 2D on port ${PORT}`));
