/**
 * LanBeam signaling server.
 *
 * This server ONLY relays WebRTC signaling (SDP offers/answers and ICE
 * candidates) so two devices can find each other. File bytes travel
 * directly between devices over an encrypted WebRTC DataChannel and
 * NEVER touch this server. Nothing is stored, logged, or uploaded.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 30 * 60 * 1000; // rooms die 30 min after creation

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// code -> { sender, receiver, createdAt }
const rooms = new Map();

function makeCode() {
  // unambiguous characters only (no 0/O, 1/I/l)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from(crypto.randomBytes(6))
      .map((b) => alphabet[b % alphabet.length])
      .join('');
  } while (rooms.has(code));
  return code;
}

function peerOf(room, ws) {
  if (!room) return null;
  return ws === room.sender ? room.receiver : room.sender;
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const peer of [room.sender, room.receiver]) {
    if (peer && peer.readyState === 1) {
      peer.send(JSON.stringify({ type: 'peer-left' }));
    }
  }
  rooms.delete(code);
}

// ---- static file server ----
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));

  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

// ---- signaling ----
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'create') {
      const code = makeCode();
      rooms.set(code, { sender: ws, receiver: null, createdAt: Date.now() });
      ws.roomCode = code;
      ws.role = 'sender';
      ws.send(JSON.stringify({ type: 'created', code }));
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check the code and try again.' }));
        return;
      }
      if (room.receiver) {
        ws.send(JSON.stringify({ type: 'error', message: 'This room already has a receiver.' }));
        return;
      }
      room.receiver = ws;
      ws.roomCode = code;
      ws.role = 'receiver';
      ws.send(JSON.stringify({ type: 'joined', code }));
      if (room.sender && room.sender.readyState === 1) {
        room.sender.send(JSON.stringify({ type: 'peer-joined', role: 'receiver' }));
      }
      return;
    }

    if (msg.type === 'signal') {
      const room = rooms.get(ws.roomCode);
      const peer = peerOf(room, ws);
      if (peer && peer.readyState === 1) {
        peer.send(JSON.stringify({ type: 'signal', payload: msg.payload }));
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const peer = peerOf(room, ws);
    if (peer && peer.readyState === 1) {
      peer.send(JSON.stringify({ type: 'peer-left' }));
      peer.close();
    }
    rooms.delete(ws.roomCode);
  });
});

// sweep stale rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) destroyRoom(code);
  }
}, 60 * 1000);

function lanIPs() {
  const { networkInterfaces } = require('os');
  const ips = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  return ips;
}

server.listen(PORT, () => {
  console.log('\n  ⚡ LanBeam is live\n');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of lanIPs()) console.log(`  Network: http://${ip}:${PORT}`);
  console.log('\n  Files move device-to-device over encrypted WebRTC.');
  console.log('  This server only relays signaling — it never sees your files.\n');
});
