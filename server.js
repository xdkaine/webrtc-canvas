import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Map<roomId, Set<ws>>
const rooms = new Map();
// Map<ws, {roomId, clientId}>
const peers = new Map();

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(roomId, message, exceptWs) {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const client of set) {
    if (client !== exceptWs && client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }

    const { type } = msg;

    if (type === 'join') {
      const roomId = msg.roomId || nanoid();
      const clientId = nanoid();
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const set = rooms.get(roomId);
      // Collect existing peer IDs in this room
      const existing = [];
      for (const c of set) {
        if (c._clientId) existing.push(c._clientId);
      }
      set.add(ws);
      peers.set(ws, { roomId, clientId });
      ws._clientId = clientId;

      send(ws, 'joined', { roomId, clientId, peers: existing });

      // Announce to others
      const payload = JSON.stringify({ type: 'peer-join', clientId });
      broadcast(roomId, payload, ws);
      return;
    }

    const peer = peers.get(ws);
    if (!peer) return;

    // Signaling and data relay
    switch (type) {
      case 'signal': {
        // Forward to specific peer if provided; otherwise to all others
        const targetId = msg.targetId;
        const payload = JSON.stringify({ type: 'signal', from: peer.clientId, data: msg.data });
        const set = rooms.get(peer.roomId);
        if (!set) return;
        if (targetId) {
          for (const client of set) {
            if (client._clientId === targetId && client.readyState === client.OPEN) {
              client.send(payload);
              break;
            }
          }
        } else {
          // Broadcast to everyone else
          for (const client of set) {
            if (client !== ws && client.readyState === client.OPEN) client.send(payload);
          }
        }
        break;
      }
      case 'draw': {
        // Lightweight broadcast for drawing events (for non-RTC fallback)
        const payload = JSON.stringify({ type: 'draw', from: peer.clientId, data: msg.data });
        broadcast(peer.roomId, payload, ws);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    const peer = peers.get(ws);
    if (!peer) return;
    const { roomId, clientId } = peer;
    peers.delete(ws);
    const set = rooms.get(roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(roomId);
      else broadcast(roomId, JSON.stringify({ type: 'peer-leave', clientId }), ws);
    }
  });
});

const PORT = process.env.PORT || 5173;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
