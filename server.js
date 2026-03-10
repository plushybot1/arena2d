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

function broadcast(session, msg, exclude) {
  session.players.forEach(p => {
    if (p !== exclude && p.readyState === WebSocket.OPEN)
      p.send(JSON.stringify(msg));
  });
}
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'create') {
      let key = randomKey();
      while (sessions[key]) key = randomKey();
      sessions[key] = { players: [ws], selections: [{}, {}], readyCount: 0 };
      ws.sessionKey = key;
      ws.playerIndex = 0;
      send(ws, { type: 'created', key, playerIndex: 0 });
    }

    else if (data.type === 'join') {
      const s = sessions[data.key];
      if (!s) { send(ws, { type: 'error', msg: 'Session not found' }); return; }
      if (s.players.length >= 2) { send(ws, { type: 'error', msg: 'Session is full' }); return; }
      s.players.push(ws);
      ws.sessionKey = data.key;
      ws.playerIndex = 1;
      send(ws, { type: 'joined', key: data.key, playerIndex: 1 });
      broadcast(s, { type: 'opponentJoined' }, ws);
    }

    else if (data.type === 'selection') {
      const s = sessions[ws.sessionKey];
      if (!s) return;
      s.selections[ws.playerIndex] = { ...s.selections[ws.playerIndex], ...data.data };
      broadcast(s, { type: 'opponentSelection', data: data.data, from: ws.playerIndex }, ws);
    }

    else if (data.type === 'ready') {
      const s = sessions[ws.sessionKey];
      if (!s) return;
      s.readyCount = (s.readyCount || 0) + 1;
      broadcast(s, { type: 'opponentReady' }, ws);
      if (s.readyCount >= 2) {
        s.players.forEach(p => send(p, { type: 'startGame', selections: s.selections }));
        s.readyCount = 0;
      }
    }

    else if (['input', 'state', 'roundEnd', 'chat'].includes(data.type)) {
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
    delete sessions[ws.sessionKey];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ARENA 2D running on port ${PORT}`));
