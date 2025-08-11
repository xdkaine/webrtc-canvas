const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const compression = require('compression');

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with optimized settings
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    upgradeTimeout: 30000,
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // 1MB max message size
    compression: true,
    // Optimize for low latency
    allowEIO3: true
});

// Enable compression and JSON parsing
app.use(compression());
app.use(express.json({ limit: '10mb' }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Optimized session management with better data structures
class SessionManager {
    constructor() {
        this.sessions = new Map(); // sessionId -> Session object
        this.userSockets = new Map(); // userId -> socket
        this.socketUsers = new Map(); // socketId -> userId
        this.userSessions = new Map(); // userId -> sessionId
        
        // Clean up old sessions every 5 minutes
        setInterval(() => this.cleanupSessions(), 5 * 60 * 1000);
    }
    
    createSession(sessionId) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                id: sessionId,
                users: new Map(), // userId -> user info
                createdAt: Date.now(),
                lastActivity: Date.now(),
                messageBuffer: [], // Recent messages for late joiners
                drawingState: null // Compressed canvas state
            });
        }
        return this.sessions.get(sessionId);
    }
    
    joinSession(sessionId, userId, socket, userInfo) {
        const session = this.createSession(sessionId);
        
        // Update user mappings
        this.userSockets.set(userId, socket);
        this.socketUsers.set(socket.id, userId);
        this.userSessions.set(userId, sessionId);
        
        // Add user to session
        session.users.set(userId, {
            ...userInfo,
            userId,
            joinedAt: Date.now(),
            lastSeen: Date.now(),
            socketId: socket.id
        });
        
        session.lastActivity = Date.now();
        
        // Join socket room
        socket.join(sessionId);
        
        return session;
    }
    
    leaveSession(userId, socketId) {
        const sessionId = this.userSessions.get(userId);
        if (!sessionId) return;
        
        const session = this.sessions.get(sessionId);
        if (session) {
            session.users.delete(userId);
            
            // Remove session if empty
            if (session.users.size === 0) {
                this.sessions.delete(sessionId);
            }
        }
        
        // Clean up mappings
        this.userSockets.delete(userId);
        this.socketUsers.delete(socketId);
        this.userSessions.delete(userId);
    }
    
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    
    getUserSession(userId) {
        const sessionId = this.userSessions.get(userId);
        return sessionId ? this.sessions.get(sessionId) : null;
    }
    
    broadcastToSession(sessionId, event, data, excludeUserId = null) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        
        session.users.forEach((user, userId) => {
            if (userId !== excludeUserId) {
                const socket = this.userSockets.get(userId);
                if (socket && socket.connected) {
                    socket.emit(event, data);
                }
            }
        });
    }
    
    cleanupSessions() {
        const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
        
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.lastActivity < thirtyMinutesAgo) {
                // Clean up all users in this session
                session.users.forEach((user, userId) => {
                    this.userSockets.delete(userId);
                    this.userSessions.delete(userId);
                });
                
                this.sessions.delete(sessionId);
                console.log(`Cleaned up inactive session: ${sessionId}`);
            }
        }
    }
}

const sessionManager = new SessionManager();

// WebSocket connection handling with optimized signaling
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    
    let currentUserId = null;
    let currentSessionId = null;
    
    // Rate limiting per socket
    const rateLimiter = {
        drawing: { count: 0, resetTime: Date.now() + 1000 },
        chat: { count: 0, resetTime: Date.now() + 1000 },
        signaling: { count: 0, resetTime: Date.now() + 1000 }
    };
    
    const checkRateLimit = (type, maxPerSecond = 60) => {
        const now = Date.now();
        const limiter = rateLimiter[type];
        
        if (now > limiter.resetTime) {
            limiter.count = 0;
            limiter.resetTime = now + 1000;
        }
        
        if (limiter.count >= maxPerSecond) {
            return false;
        }
        
        limiter.count++;
        return true;
    };
    
    // Join session with optimized user management
    socket.on('join-session', (data) => {
        try {
            const { userId, sessionId = 'default', nickname = 'Anonymous' } = data;
            
            if (!userId || !sessionId) {
                socket.emit('error', { message: 'Invalid join data' });
                return;
            }
            
            currentUserId = userId;
            currentSessionId = sessionId;
            
            const session = sessionManager.joinSession(sessionId, userId, socket, {
                nickname: nickname.substring(0, 20), // Limit nickname length
                joinedAt: Date.now()
            });
            
            // Send current session state to new user
            socket.emit('session-joined', {
                sessionId,
                userId,
                users: Array.from(session.users.values()).map(u => ({
                    userId: u.userId,
                    nickname: u.nickname,
                    joinedAt: u.joinedAt
                })),
                userCount: session.users.size
            });
            
            // Send recent messages to new user
            if (session.messageBuffer.length > 0) {
                socket.emit('message-history', { messages: session.messageBuffer });
            }
            
            // Send canvas state if available
            if (session.drawingState) {
                socket.emit('canvas-state', { data: session.drawingState });
            }
            
            // Notify other users about new user
            sessionManager.broadcastToSession(sessionId, 'user-joined', {
                userId,
                nickname: nickname.substring(0, 20),
                joinedAt: Date.now(),
                userCount: session.users.size
            }, userId);
            
            console.log(`User ${userId} joined session ${sessionId}`);
            
        } catch (error) {
            console.error('Error in join-session:', error);
            socket.emit('error', { message: 'Failed to join session' });
        }
    });
    
    // Optimized WebRTC signaling with validation
    socket.on('webrtc-signal', (data) => {
        if (!checkRateLimit('signaling', 30)) {
            socket.emit('error', { message: 'Rate limit exceeded for signaling' });
            return;
        }
        
        try {
            const { targetUserId, signal } = data;
            
            if (!targetUserId || !signal || !currentUserId) {
                socket.emit('error', { message: 'Invalid signaling data' });
                return;
            }
            
            // Validate signal type
            const validTypes = ['offer', 'answer', 'ice-candidate', 'user-joined'];
            if (!validTypes.includes(signal.type)) {
                socket.emit('error', { message: 'Invalid signal type' });
                return;
            }
            
            const targetSocket = sessionManager.userSockets.get(targetUserId);
            if (targetSocket && targetSocket.connected) {
                targetSocket.emit('webrtc-signal', {
                    fromUserId: currentUserId,
                    signal
                });
            }
            
        } catch (error) {
            console.error('Error in webrtc-signal:', error);
            socket.emit('error', { message: 'Failed to send signal' });
        }
    });
    
    // High-performance drawing data with batching
    socket.on('drawing-data', (data) => {
        if (!checkRateLimit('drawing', 120)) { // Higher limit for drawing
            return; // Silently drop to avoid disrupting drawing
        }
        
        try {
            if (!currentSessionId || !currentUserId) return;
            
            // Validate drawing data
            if (!data || typeof data !== 'object') return;
            
            const drawingMessage = {
                type: 'drawing-data',
                userId: currentUserId,
                data,
                timestamp: Date.now()
            };
            
            // Broadcast to all users in session except sender
            sessionManager.broadcastToSession(currentSessionId, 'drawing-data', drawingMessage, currentUserId);
            
            // Update session activity
            const session = sessionManager.getSession(currentSessionId);
            if (session) {
                session.lastActivity = Date.now();
            }
            
        } catch (error) {
            console.error('Error in drawing-data:', error);
        }
    });
    
    // Optimized chat messaging with history
    socket.on('chat-message', (data) => {
        if (!checkRateLimit('chat', 10)) {
            socket.emit('error', { message: 'Rate limit exceeded for chat' });
            return;
        }
        
        try {
            const { message } = data;
            
            if (!message || !currentSessionId || !currentUserId) {
                socket.emit('error', { message: 'Invalid chat data' });
                return;
            }
            
            // Sanitize and validate message
            const sanitizedMessage = message.toString().substring(0, 200).trim();
            if (sanitizedMessage === '') return;
            
            const session = sessionManager.getSession(currentSessionId);
            if (!session) return;
            
            const user = session.users.get(currentUserId);
            if (!user) return;
            
            const chatMessage = {
                type: 'chat-message',
                userId: currentUserId,
                nickname: user.nickname,
                message: sanitizedMessage,
                timestamp: Date.now()
            };
            
            // Add to message buffer (keep last 50 messages)
            session.messageBuffer.push(chatMessage);
            if (session.messageBuffer.length > 50) {
                session.messageBuffer.shift();
            }
            
            // Broadcast to all users in session
            sessionManager.broadcastToSession(currentSessionId, 'chat-message', chatMessage);
            
            session.lastActivity = Date.now();
            
        } catch (error) {
            console.error('Error in chat-message:', error);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });
    
    // Canvas state synchronization
    socket.on('canvas-state', (data) => {
        try {
            if (!currentSessionId || !currentUserId) return;
            
            const session = sessionManager.getSession(currentSessionId);
            if (!session) return;
            
            // Store compressed canvas state
            session.drawingState = data;
            session.lastActivity = Date.now();
            
            // Optionally broadcast to new users only
            // (existing users already have the canvas state)
            
        } catch (error) {
            console.error('Error in canvas-state:', error);
        }
    });
    
    // Cursor position updates (optional, for showing remote cursors)
    socket.on('cursor-position', (data) => {
        try {
            if (!currentSessionId || !currentUserId) return;
            
            // Broadcast cursor position to other users
            sessionManager.broadcastToSession(currentSessionId, 'cursor-position', {
                userId: currentUserId,
                ...data
            }, currentUserId);
            
        } catch (error) {
            console.error('Error in cursor-position:', error);
        }
    });
    
    // Handle user info updates (like nickname changes)
    socket.on('user-info-update', (data) => {
        try {
            if (!currentSessionId || !currentUserId) return;
            
            const { nickname, timestamp } = data;
            if (!nickname) return;
            
            const session = sessionManager.getSession(currentSessionId);
            if (!session || !session.users.has(currentUserId)) return;
            
            // Update user info in session
            const user = session.users.get(currentUserId);
            user.nickname = nickname.substring(0, 20); // Limit length
            user.lastSeen = timestamp || Date.now();
            
            session.lastActivity = Date.now();
            
            // Broadcast nickname change to other users
            sessionManager.broadcastToSession(currentSessionId, 'user-info-update', {
                userId: currentUserId,
                nickname: user.nickname,
                timestamp: user.lastSeen
            }, currentUserId);
            
            console.log(`User ${currentUserId} changed nickname to: ${user.nickname}`);
            
        } catch (error) {
            console.error('Error in user-info-update:', error);
        }
    });
    
    // Heartbeat for connection monitoring
    socket.on('ping', () => {
        socket.emit('pong');
    });
    
    // Handle disconnection
    socket.on('disconnect', (reason) => {
        console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
        
        if (currentUserId && currentSessionId) {
            // Notify other users about disconnection
            sessionManager.broadcastToSession(currentSessionId, 'user-left', {
                userId: currentUserId,
                timestamp: Date.now()
            }, currentUserId);
            
            // Remove user from session
            sessionManager.leaveSession(currentUserId, socket.id);
        }
    });
    
    // Error handling
    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });
});

// Legacy API endpoints for backwards compatibility (optional)
app.get('/api/session-info/:sessionId?', (req, res) => {
    const sessionId = req.params.sessionId || 'default';
    const session = sessionManager.getSession(sessionId);
    
    if (!session) {
        return res.json({ userCount: 0, users: [] });
    }
    
    res.json({
        userCount: session.users.size,
        users: Array.from(session.users.values()).map(u => ({
            userId: u.userId,
            nickname: u.nickname,
            joinedAt: u.joinedAt
        }))
    });
});

// Health check endpoint with enhanced metrics
app.get('/health', (req, res) => {
    const totalSessions = sessionManager.sessions.size;
    const totalUsers = Array.from(sessionManager.sessions.values())
        .reduce((sum, session) => sum + session.users.size, 0);
    
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        activeSessions: totalSessions,
        totalUsers,
        connectedSockets: io.engine.clientsCount,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// WebSocket connection metrics
app.get('/api/metrics', (req, res) => {
    res.json({
        sessions: Array.from(sessionManager.sessions.entries()).map(([id, session]) => ({
            sessionId: id,
            userCount: session.users.size,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
            messageCount: session.messageBuffer.length
        }))
    });
});

// SEO and PWA routes
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml');
    res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

app.get('/site.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.sendFile(path.join(__dirname, 'public', 'site.webmanifest'));
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = 3003;

// Start server with WebSocket support
if (!process.env.VERCEL) {
    server.listen(PORT, () => {
        console.log(`🎨 WebRTC Canvas Server running on port ${PORT}`);
        console.log(`🌐 Open http://localhost:${PORT} in your browser`);
        console.log(`📱 Open the same URL on multiple devices/tabs to test collaboration`);
        console.log(`🚀 WebSocket support enabled for real-time communication`);
    });
} else {
    // For Vercel, export the server
    module.exports = server;
}
