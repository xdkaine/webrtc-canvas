const $ = (s) => document.querySelector(s);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const colorInput = $('#color');
const sizeInput = $('#size');
const clearBtn = $('#clear');
const statusEl = $('#status');
const peersEl = $('#peers');
const shareLink = $('#shareLink');
const copyLink = $('#copyLink');
const roomInput = $('#room');
const joinBtn = $('#join');
const meSpan = $('#me');

let roomId = new URL(location.href).searchParams.get('room') || '';
if (roomId) roomInput.value = roomId;

// Resize canvas to fill section
function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  redraw();
}
window.addEventListener('resize', resize);

// Simple in-memory strokes for redraw on resize/clear
const strokes = []; // {id, color, size, points:[{x,y}]}
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.beginPath();
    const pts = s.points;
    if (!pts.length) continue;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
}

let drawing = false;
let currentStroke = null;
function startDraw(x, y) {
  drawing = true;
  currentStroke = { id: crypto.randomUUID(), color: colorInput.value, size: +sizeInput.value, points: [{ x, y }] };
  strokes.push(currentStroke);
  sendDraw({ type: 'begin', id: currentStroke.id, color: currentStroke.color, size: currentStroke.size, x, y });
}
function moveDraw(x, y) {
  if (!drawing) return;
  currentStroke.points.push({ x, y });
  sendDraw({ type: 'point', id: currentStroke.id, x, y });
  drawSegment(currentStroke.color, currentStroke.size, currentStroke.points);
}
function endDraw() {
  if (!drawing) return;
  drawing = false;
  sendDraw({ type: 'end', id: currentStroke.id });
  currentStroke = null;
}

function drawSegment(color, size, pts) {
  const n = pts.length;
  if (n < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.beginPath();
  ctx.moveTo(pts[n - 2].x, pts[n - 2].y);
  ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
  ctx.stroke();
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  if (e.touches) e = e.touches[0];
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (e) => { const p = getPos(e); startDraw(p.x, p.y); });
canvas.addEventListener('pointermove', (e) => { const p = getPos(e); moveDraw(p.x, p.y); });
window.addEventListener('pointerup', endDraw);

clearBtn.addEventListener('click', () => {
  strokes.length = 0; redraw();
  broadcast({ kind: 'clear' });
});

joinBtn.addEventListener('click', () => joinRoom(roomInput.value.trim()));
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
copyLink.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareLink.value); setStatus('Link copied'); } catch {}
});

// --- Signaling via WebSocket ---
let ws; let clientId;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { if (roomId) ws.send(JSON.stringify({ type: 'join', roomId })); };
  ws.onmessage = (ev) => handleSignal(JSON.parse(ev.data));
  ws.onclose = () => setStatus('Disconnected');
}

function setStatus(text) { statusEl.textContent = text; }
function setPeers(peers) {
  peersEl.innerHTML = '';
  for (const id of peers) {
    const div = document.createElement('div');
    div.className = 'pill';
    div.textContent = id === clientId ? `me:${id}` : id;
    peersEl.appendChild(div);
  }
}

function joinRoom(id) {
  roomId = id || '';
  if (!roomId) return alert('Enter a room id to join');
  shareLink.value = `${location.origin}?room=${roomId}`;
  ws?.close();
  connectWS();
  // join once ws opens
}

const peersSet = new Set();
const pcs = new Map(); // peerId -> RTCPeerConnection
const dcs = new Map(); // peerId -> RTCDataChannel

function ensurePeerConnection(peerId, isInitiator = false) {
  if (pcs.has(peerId)) return pcs.get(peerId);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pcs.set(peerId, pc);
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate }, peerId); };
  pc.onconnectionstatechange = () => setStatus(`RTC(${peerId.slice(0,4)}): ${pc.connectionState}`);
  pc.ondatachannel = (e) => setupDC(peerId, e.channel);
  if (isInitiator) {
    const dc = pc.createDataChannel('draw', { ordered: true });
    setupDC(peerId, dc);
  }
  return pc;
}

function setupDC(peerId, channel) {
  dcs.set(peerId, channel);
  channel.onopen = () => setStatus('Ready to draw');
  channel.onmessage = (e) => handleRTCMessage(JSON.parse(e.data));
  channel.onclose = () => dcs.delete(peerId);
}

function sendSignal(data, targetId) {
  ws?.send(JSON.stringify({ type: 'signal', data, targetId }));
}

async function createOffer(peerId) {
  const pc = ensurePeerConnection(peerId, true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ sdp: pc.localDescription }, peerId);
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'joined': {
      clientId = msg.clientId; meSpan.textContent = `me: ${clientId}`;
      roomId = msg.roomId; shareLink.value = `${location.origin}?room=${roomId}`;
      setStatus('Joined room');
      peersSet.add(clientId);
      for (const p of (msg.peers || [])) peersSet.add(p);
      setPeers(peersSet);
      break;
    }
    case 'peer-join': {
      if (msg.clientId === clientId) break;
      peersSet.add(msg.clientId); setPeers(peersSet);
      await createOffer(msg.clientId);
      break;
    }
    case 'peer-leave': {
  peersSet.delete(msg.clientId); setPeers(peersSet);
  const pc = pcs.get(msg.clientId); if (pc) { try { pc.close(); } catch {} }
  pcs.delete(msg.clientId);
  dcs.delete(msg.clientId);
      break;
    }
    case 'signal': {
      const from = msg.from; const data = msg.data;
      const pc = ensurePeerConnection(from);
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ sdp: pc.localDescription }, from);
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
      }
      break;
    }
    case 'draw': {
      // fallback broadcast relay payload: { kind: 'draw'|'clear', evt? }
      const payload = msg.data;
      if (payload.kind === 'draw') applyRemoteDraw(payload.evt);
      if (payload.kind === 'clear') { strokes.length = 0; redraw(); }
      break;
    }
    default:
      break;
  }
}

function setupCanvas() {
  const section = document.querySelector('section.stage');
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(section);
  resize();
}

function broadcast(payload) {
  let sentRTC = false;
  for (const [, channel] of dcs) {
    if (channel.readyState === 'open') { channel.send(JSON.stringify(payload)); sentRTC = true; }
  }
  if (!sentRTC) ws?.send(JSON.stringify({ type: 'draw', data: payload }));
}

function sendDraw(evt) { broadcast({ kind: 'draw', evt }); }

function handleRTCMessage(msg) {
  if (msg.kind === 'draw') applyRemoteDraw(msg.evt);
  if (msg.kind === 'clear') { strokes.length = 0; redraw(); }
}

function applyRemoteDraw(evt) {
  if (evt.type === 'begin') {
    const s = { id: evt.id, color: evt.color, size: evt.size, points: [{ x: evt.x, y: evt.y }] };
    strokes.push(s);
  } else if (evt.type === 'point') {
    const s = strokes.find((x) => x.id === evt.id); if (!s) return;
    s.points.push({ x: evt.x, y: evt.y });
    drawSegment(s.color, s.size, s.points);
  }
}

setupCanvas();
if (roomId) connectWS();

// Optional: auto-join with prompt
if (!roomId) {
  roomId = Math.random().toString(36).slice(2, 8);
  roomInput.value = roomId;
}

setStatus('Enter a room and Join, then share the link.');
