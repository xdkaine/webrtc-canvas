Live collaborative drawing with WebRTC (data channels) and WebSocket signaling.

## Getting Started

1. Install Node.js 18+
2. Install dependencies and start the server:

```powershell
npm install
npm start
```

Or simply:

```powershell
node server.js
```

Open http://localhost:5173. Enter a room id and press Join, or share the link with `?room=ROOMID` to draw together.

## Features

- WebRTC DataChannel is used for low-latency stroke sync. Falls back to WebSocket relay if needed.
- No persistence; canvas resets on refresh.