Live collaborative drawing with WebRTC (data channels) and WebSocket signaling.

Now optimized for Vercel:

- Static assets in `public/` are served by Vercel's CDN.
- Signaling runs as an Edge WebSocket function at `/api/ws`.

Local dev

1. Install Node.js 18+.
2. Install deps and run Vercel dev.

```powershell
npm install
npx vercel dev
```

Open http://localhost:3000. Enter a room id and press Join, or share the link with `?room=ROOMID` to draw together.

Deploy

```powershell
npx vercel --prod
```

Notes

- WebRTC DataChannel is used for low-latency stroke sync. Falls back to WebSocket relay if needed.
- No persistence; canvas resets on refresh.