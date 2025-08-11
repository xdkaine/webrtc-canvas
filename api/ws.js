// Edge WebSocket signaling server for Vercel
// Runtime: Edge

export const config = {
  runtime: 'edge',
};

// Global in-memory room/peer registries (lives with the edge instance)
// Map<roomId, Set<WebSocket>>
const rooms = globalThis.__rooms || new Map();
// Map<WebSocket, { roomId: string, clientId: string }>
const peers = globalThis.__peers || new Map();
globalThis.__rooms = rooms;
globalThis.__peers = peers;

function send(ws, type, payload = {}) {
  try {
    ws.send(JSON.stringify({ type, ...payload }));
  } catch {}
}

function broadcast(roomId, data, exceptWs) {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const client of set) {
    if (client !== exceptWs) {
      try { client.send(data); } catch {}
    }
  }
}

function genId() {
  // Short, URL-friendly id similar to nanoid(8)
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export default function handler(request) {
  if (request.headers.get('upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  const clientId = genId();

  server.accept();

  server.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const { type } = msg || {};
    if (type === 'join') {
      let roomId = msg.roomId || genId();
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const set = rooms.get(roomId);

      // Gather existing peer IDs
      const existing = [];
      for (const s of set) {
        const meta = peers.get(s);
        if (meta?.clientId) existing.push(meta.clientId);
      }

      set.add(server);
      peers.set(server, { roomId, clientId });

      send(server, 'joined', { roomId, clientId, peers: existing });

      const announce = JSON.stringify({ type: 'peer-join', clientId });
      broadcast(roomId, announce, server);
      return;
    }

    const meta = peers.get(server);
    if (!meta) return;
    const { roomId } = meta;

    switch (type) {
      case 'signal': {
        const payload = JSON.stringify({ type: 'signal', from: meta.clientId, data: msg.data });
        const targetId = msg.targetId;
        const set = rooms.get(roomId);
        if (!set) return;
        if (targetId) {
          for (const c of set) {
            const m = peers.get(c);
            if (m?.clientId === targetId) {
              try { c.send(payload); } catch {}
              break;
            }
          }
        } else {
          broadcast(roomId, payload, server);
        }
        break;
      }
      case 'draw': {
        const payload = JSON.stringify({ type: 'draw', from: meta.clientId, data: msg.data });
        broadcast(roomId, payload, server);
        break;
      }
      default:
        break;
    }
  });

  server.addEventListener('close', () => {
    const meta = peers.get(server);
    if (!meta) return;
    const { roomId, clientId } = meta;
    peers.delete(server);
    const set = rooms.get(roomId);
    if (set) {
      set.delete(server);
      if (set.size === 0) rooms.delete(roomId);
      else broadcast(roomId, JSON.stringify({ type: 'peer-leave', clientId }), server);
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}
