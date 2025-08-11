Live collaborative drawing with WebRTC (data channels) and WebSocket signaling.

Quick start

1. Install Node.js 18+.
2. Install deps and run the server.

```powershell
npm install
npm run start
```

Open http://localhost:5173 in your browser. Enter a room id and press Join, or share the link with `?room=ROOMID` to draw together.

Notes

- Uses Express to serve static files and ws for signaling.
- WebRTC DataChannel is used for low-latency stroke sync. Falls back to WebSocket relay if needed.
- No persistence; canvas resets on refresh.