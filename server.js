const express = require('express');
const path = require('path');

const app = express();

// Enable JSON parsing
app.use(express.json());

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage for active sessions (in production, use Redis or database)
let activeSessions = new Map();
let sessionMessages = new Map();

// Clean up old sessions (older than 30 minutes)
setInterval(() => {
    const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
    for (const [sessionId, session] of activeSessions.entries()) {
        if (session.lastActivity < thirtyMinutesAgo) {
            activeSessions.delete(sessionId);
            sessionMessages.delete(sessionId);
        }
    }
}, 5 * 60 * 1000); // Clean every 5 minutes

// API Routes for signaling
app.post('/api/join-session', (req, res) => {
    const { userId, sessionId = 'default' } = req.body;
    
    if (!activeSessions.has(sessionId)) {
        activeSessions.set(sessionId, new Map());
        sessionMessages.set(sessionId, []);
    }
    
    const session = activeSessions.get(sessionId);
    session.set(userId, {
        userId,
        joinedAt: Date.now(),
        lastActivity: Date.now()
    });
    
    // Get list of other users in session
    const otherUsers = Array.from(session.keys()).filter(id => id !== userId);
    
    res.json({
        success: true,
        otherUsers,
        userCount: session.size
    });
});

app.post('/api/leave-session', (req, res) => {
    const { userId, sessionId = 'default' } = req.body;
    
    if (activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);
        session.delete(userId);
        
        if (session.size === 0) {
            activeSessions.delete(sessionId);
            sessionMessages.delete(sessionId);
        }
    }
    
    res.json({ success: true });
});

app.post('/api/send-signal', (req, res) => {
    const { fromUserId, toUserId, signal, sessionId = 'default' } = req.body;
    
    if (!sessionMessages.has(sessionId)) {
        sessionMessages.set(sessionId, []);
    }
    
    const messages = sessionMessages.get(sessionId);
    messages.push({
        id: Date.now() + Math.random(),
        fromUserId,
        toUserId,
        signal,
        timestamp: Date.now()
    });
    
    // Keep only last 100 messages
    if (messages.length > 100) {
        messages.splice(0, messages.length - 100);
    }
    
    res.json({ success: true });
});

app.get('/api/get-signals/:userId', (req, res) => {
    const { userId } = req.params;
    const { sessionId = 'default', since = '0' } = req.query;
    
    if (!sessionMessages.has(sessionId)) {
        return res.json({ signals: [] });
    }
    
    const messages = sessionMessages.get(sessionId);
    const sinceTimestamp = parseInt(since);
    
    const relevantSignals = messages.filter(msg => 
        msg.toUserId === userId && msg.timestamp > sinceTimestamp
    );
    
    res.json({ signals: relevantSignals });
});

app.post('/api/broadcast-drawing', (req, res) => {
    const { fromUserId, drawingData, sessionId = 'default' } = req.body;
    
    if (!sessionMessages.has(sessionId)) {
        sessionMessages.set(sessionId, []);
    }
    
    const messages = sessionMessages.get(sessionId);
    messages.push({
        id: Date.now() + Math.random(),
        type: 'drawing',
        fromUserId,
        toUserId: 'all',
        data: drawingData,
        timestamp: Date.now()
    });
    
    // Keep only last 200 drawing messages
    const drawingMessages = messages.filter(m => m.type === 'drawing');
    if (drawingMessages.length > 200) {
        const toRemove = drawingMessages.slice(0, drawingMessages.length - 200);
        toRemove.forEach(msg => {
            const index = messages.indexOf(msg);
            if (index > -1) messages.splice(index, 1);
        });
    }
    
    res.json({ success: true });
});

app.get('/api/get-drawing-updates/:userId', (req, res) => {
    const { userId } = req.params;
    const { sessionId = 'default', since = '0' } = req.query;
    
    if (!sessionMessages.has(sessionId)) {
        return res.json({ updates: [] });
    }
    
    const messages = sessionMessages.get(sessionId);
    const sinceTimestamp = parseInt(since);
    
    const drawingUpdates = messages.filter(msg => 
        msg.type === 'drawing' && 
        msg.fromUserId !== userId && 
        msg.timestamp > sinceTimestamp
    );
    
    res.json({ updates: drawingUpdates });
});

app.get('/api/session-info/:sessionId?', (req, res) => {
    const sessionId = req.params.sessionId || 'default';
    
    if (!activeSessions.has(sessionId)) {
        return res.json({ userCount: 0, users: [] });
    }
    
    const session = activeSessions.get(sessionId);
    const users = Array.from(session.values());
    
    res.json({
        userCount: session.size,
        users: users.map(u => ({ userId: u.userId, joinedAt: u.joinedAt }))
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        activeSessions: activeSessions.size,
        totalUsers: Array.from(activeSessions.values()).reduce((sum, session) => sum + session.size, 0)
    });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Only start server if not in Vercel environment
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🎨 WebRTC Canvas Server running on port ${PORT}`);
        console.log(`🌐 Open http://localhost:${PORT} in your browser`);
        console.log(`📱 Open the same URL on multiple devices/tabs to test collaboration`);
    });
}

module.exports = app;
