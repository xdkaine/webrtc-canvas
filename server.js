const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const compression = require('compression');
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);

// Clean up function to clear all data on startup
const cleanupOnStartup = async () => {
    try {
        // Clear canvas data on startup for fresh state
        const dataDir = path.join(__dirname, 'canvas-data');
        try {
            const dataFiles = await fs.readdir(dataDir);
            for (const file of dataFiles) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(dataDir, file);
                    await fs.unlink(filePath);
                    console.log(`Deleted canvas data file: ${file}`);
                }
            }
            console.log('Cleared canvas data');
        } catch (error) {
            console.log('No canvas data directory found, starting fresh');
        }
        
    } catch (error) {
        console.error('Error during startup cleanup:', error);
    }
};

cleanupOnStartup();

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

// Global canvas storage - simplified to single canvas
class CanvasPersistence {
    constructor() {
        this.dataDir = path.join(__dirname, 'canvas-data');
        this.ensureDataDirectory();
        this.canvasState = null; // Single canvas state
        console.log('Canvas persistence initialized with fresh state');
    }
    
    async ensureDataDirectory() {
        try {
            await fs.mkdir(this.dataDir, { recursive: true });
        } catch (error) {
            console.error('Failed to create data directory:', error);
        }
    }
    
    async loadCanvasState() {
        try {
            const filePath = path.join(this.dataDir, 'canvas-state.json');
            const data = await fs.readFile(filePath, 'utf8');
            this.canvasState = JSON.parse(data);
            console.log('Loaded canvas state');
        } catch (error) {
            console.log('No existing canvas state found');
        }
    }
    
    async saveCanvasState(canvasData) {
        try {
            this.canvasState = canvasData;
            const filePath = path.join(this.dataDir, 'canvas-state.json');
            await fs.writeFile(filePath, JSON.stringify(canvasData, null, 2));
            console.log('Canvas state saved');
        } catch (error) {
            console.error('Failed to save canvas state:', error);
        }
    }
    
    getCanvasState() {
        return this.canvasState;
    }
    
    hasCanvasState() {
        return this.canvasState !== null;
    }
}

const canvasPersistence = new CanvasPersistence();

// Simplified session management for single canvas
class SessionManager {
    constructor() {
        this.users = new Map(); // userId -> user info
        this.userSockets = new Map(); // userId -> socket
        this.socketUsers = new Map(); // socketId -> userId
        this.drawingStates = new Map(); // userId -> current drawing state
        this.sequenceNumbers = new Map(); // userId -> last sequence number
        this.messageBuffer = []; // Recent messages for late joiners
        this.drawingActions = []; // Store all drawing actions for persistence
        this.activeStrokes = new Map(); // strokeId -> stroke data for conflict resolution
        this.lastSequence = 0; // Server sequence counter for authoritative ordering
        this.createdAt = Date.now();
        this.lastActivity = Date.now();
        
        // Clean up old sessions every 5 minutes
        setInterval(() => this.cleanupInactiveUsers(), 5 * 60 * 1000);
    }
    
    joinSession(userId, socket, userInfo) {
        // Update user mappings
        this.userSockets.set(userId, socket);
        this.socketUsers.set(socket.id, userId);
        
        // Add user to session
        this.users.set(userId, {
            ...userInfo,
            userId,
            joinedAt: Date.now(),
            lastSeen: Date.now(),
            socketId: socket.id
        });
        
        this.lastActivity = Date.now();
        
        // Join socket room (using single room name)
        socket.join('canvas-room');
        
        // Initialize user drawing state
        this.drawingStates.set(userId, {
            isDrawing: false,
            currentStroke: null,
            lastPosition: null,
            lastSequence: 0
        });
        this.sequenceNumbers.set(userId, 0);
        
        return this;
    }
    
    leaveSession(userId, socketId) {
        this.users.delete(userId);
        
        // Clean up mappings
        this.userSockets.delete(userId);
        this.socketUsers.delete(socketId);
        this.drawingStates.delete(userId);
        this.sequenceNumbers.delete(userId);
        
        this.lastActivity = Date.now();
    }
    
    broadcastToAll(event, data, excludeUserId = null) {
        // Broadcast to session members
        this.users.forEach((user, userId) => {
            if (userId !== excludeUserId) {
                const socket = this.userSockets.get(userId);
                if (socket && socket.connected) {
                    socket.emit(event, data);
                }
            }
        });
        
        // Also broadcast certain events to anonymous browsers
        const anonymousBrowserEvents = ['drawing-data', 'canvas-state', 'canvasCleared'];
        if (anonymousBrowserEvents.includes(event) && this.anonymousBrowsers) {
            this.anonymousBrowsers.forEach(socket => {
                if (socket.connected) {
                    socket.emit(event, data);
                }
            });
        }
    }
    
    // Authoritative drawing validation and conflict resolution
    validateAndProcessDrawing(userId, drawingData) {
        const userState = this.drawingStates.get(userId);
        
        if (!userState) {
            return null; // Invalid state
        }
        
        // Validate sequence number to prevent out-of-order packets
        if (drawingData.sequence && userState.lastSequence > 0 && 
            drawingData.sequence < userState.lastSequence - 10) {
            console.log(`Rejecting significantly out-of-order drawing data from ${userId} (received: ${drawingData.sequence}, expected: >${userState.lastSequence})`);
            return null;
        }
        
        const now = Date.now();
        this.lastSequence++;
        
        // Validate drawing data structure
        if (!this.isValidDrawingData(drawingData)) {
            console.log(`Rejecting invalid drawing data from ${userId}`);
            return null;
        }
        
        let processedData = {
            ...drawingData,
            userId,
            serverSequence: this.lastSequence,
            serverTimestamp: now
        };
        
        // Handle different drawing types with validation
        switch (drawingData.type) {
            case 'startDrawing':
                return this.processStartDrawing(userId, userState, processedData);
                
            case 'draw':
                return this.processDrawing(userId, userState, processedData);
                
            case 'endDrawing':
                return this.processEndDrawing(userId, userState, processedData);
                
            case 'clear-canvas':
                return this.processClearCanvas(userId, processedData);
                
            default:
                console.log(`Unknown drawing type: ${drawingData.type}`);
                return null;
        }
    }
    
    isValidDrawingData(data) {
        // Basic validation
        if (!data || typeof data !== 'object') return false;
        if (!data.type || typeof data.type !== 'string') return false;
        
        // Type-specific validation
        switch (data.type) {
            case 'startDrawing':
            case 'draw':
                return typeof data.normalizedX === 'number' && 
                       typeof data.normalizedY === 'number' &&
                       data.normalizedX >= 0 && data.normalizedX <= 1 &&
                       data.normalizedY >= 0 && data.normalizedY <= 1;
                       
            case 'endDrawing':
            case 'clear-canvas':
                return true;
                
            default:
                return false;
        }
    }
    
    processStartDrawing(userId, userState, data) {
        // Validate position bounds
        if (data.normalizedX < 0 || data.normalizedX > 1 || 
            data.normalizedY < 0 || data.normalizedY > 1) {
            return null;
        }
        
        // Force end any existing stroke
        if (userState.isDrawing) {
            userState.isDrawing = false;
            userState.currentStroke = null;
        }
        
        // Create new stroke
        const strokeId = `${userId}_${Date.now()}_${Math.random()}`;
        userState.isDrawing = true;
        userState.currentStroke = strokeId;
        userState.lastPosition = {
            x: data.normalizedX,
            y: data.normalizedY
        };
        userState.lastSequence = data.sequence || 0;
        
        // Store stroke in session
        this.activeStrokes.set(strokeId, {
            userId,
            startTime: Date.now(),
            points: [{
                x: data.normalizedX,
                y: data.normalizedY,
                timestamp: Date.now()
            }],
            color: data.color || '#000000',
            size: data.size || 5
        });
        
        return {
            ...data,
            strokeId,
            validated: true
        };
    }
    
    processDrawing(userId, userState, data) {
        if (!userState.isDrawing || !userState.currentStroke) {
            // User not in drawing state, reject
            return null;
        }
        
        // Validate position bounds
        if (data.normalizedX < 0 || data.normalizedX > 1 || 
            data.normalizedY < 0 || data.normalizedY > 1) {
            return null;
        }
        
        const stroke = this.activeStrokes.get(userState.currentStroke);
        if (!stroke) {
            // Stroke doesn't exist, force start new one
            userState.isDrawing = false;
            return null;
        }
        
        // Check for unrealistic jumps (prevents long lines from connection issues)
        const lastPos = userState.lastPosition;
        if (lastPos) {
            const distance = Math.sqrt(
                Math.pow(data.normalizedX - lastPos.x, 2) + 
                Math.pow(data.normalizedY - lastPos.y, 2)
            );
            
            // If jump is too large (more than 20% of canvas), reject
            if (distance > 0.2) {
                console.log(`Rejecting large jump in drawing from ${userId}: ${distance}`);
                return null;
            }
        }
        
        // Add point to stroke
        stroke.points.push({
            x: data.normalizedX,
            y: data.normalizedY,
            timestamp: Date.now()
        });
        
        userState.lastPosition = {
            x: data.normalizedX,
            y: data.normalizedY
        };
        userState.lastSequence = data.sequence || 0;
        
        return {
            ...data,
            strokeId: userState.currentStroke,
            validated: true
        };
    }
    
    processEndDrawing(userId, userState, data) {
        if (!userState.isDrawing || !userState.currentStroke) {
            return null;
        }
        
        const stroke = this.activeStrokes.get(userState.currentStroke);
        if (stroke) {
            stroke.endTime = Date.now();
            
            // Move completed stroke to drawing actions for persistence
            this.drawingActions.push({
                type: 'completed-stroke',
                strokeId: userState.currentStroke,
                stroke: stroke,
                timestamp: Date.now(),
                serverSequence: this.lastSequence
            });
        }
        
        // Clear user drawing state
        userState.isDrawing = false;
        userState.currentStroke = null;
        userState.lastPosition = null;
        userState.lastSequence = data.sequence || 0;
        
        return {
            ...data,
            strokeId: userState.currentStroke,
            validated: true
        };
    }
    
    processClearCanvas(userId, data) {
        // Clear all active strokes and drawing actions
        this.activeStrokes.clear();
        this.drawingActions = [];
        
        // Reset all user drawing states
        this.users.forEach((user, uId) => {
            const userState = this.drawingStates.get(uId);
            if (userState) {
                userState.isDrawing = false;
                userState.currentStroke = null;
                userState.lastPosition = null;
            }
        });
        
        return {
            ...data,
            validated: true
        };
    }

    cleanupInactiveUsers() {
        const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
        
        for (const [userId, user] of this.users.entries()) {
            if (user.lastSeen < thirtyMinutesAgo) {
                // Clean up inactive user
                this.userSockets.delete(userId);
                this.users.delete(userId);
                this.drawingStates.delete(userId);
                this.sequenceNumbers.delete(userId);
                
                console.log(`Cleaned up inactive user: ${userId}`);
            }
        }
    }
}

const sessionManager = new SessionManager();

// WebSocket connection handling with optimized signaling
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    
    let currentUserId = null;
    
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
    
    // Anonymous browsing - allows viewing without joining session
    socket.on('anonymous-browse', () => {
        console.log('Anonymous browser connected');
        
        // Add socket to anonymous browsers list for receiving drawing events
        if (!sessionManager.anonymousBrowsers) {
            sessionManager.anonymousBrowsers = new Set();
        }
        sessionManager.anonymousBrowsers.add(socket);
        
        // Confirm anonymous browsing mode
        socket.emit('anonymous-browse-confirmed');
        
        // Immediately send current canvas state to new anonymous browser
        try {
            const canvasState = canvasPersistence.getCanvasState();
            if (canvasState) {
                console.log('Sending canvas state to new anonymous browser');
                socket.emit('canvas-state', { 
                    data: canvasState,
                    isServerState: true 
                });
            } else {
                console.log('No saved state, sending empty state to new anonymous browser');
                socket.emit('canvas-state', { 
                    data: null,
                    isServerState: true,
                    isEmpty: true
                });
            }
        } catch (error) {
            console.error('Error sending canvas state to new anonymous browser:', error);
        }
        
        // Clean up on disconnect
        socket.on('disconnect', () => {
            if (sessionManager.anonymousBrowsers) {
                sessionManager.anonymousBrowsers.delete(socket);
            }
        });
    });
    
    // Handle canvas state requests for anonymous browsers
    socket.on('request-canvas-state-anonymous', () => {
        try {
            const canvasState = canvasPersistence.getCanvasState();
            if (canvasState) {
                console.log('Sending canvas state to anonymous browser');
                socket.emit('canvas-state', { 
                    data: canvasState,
                    isServerState: true 
                });
            } else {
                console.log('No saved state, sending empty state to anonymous browser');
                socket.emit('canvas-state', { 
                    data: null,
                    isServerState: true,
                    isEmpty: true
                });
            }
        } catch (error) {
            console.error('Error sending canvas state to anonymous browser:', error);
        }
    });

    // Join session - simplified to single canvas
    socket.on('join-session', (data) => {
        try {
            const { userId, nickname } = data;
            
            if (!userId) {
                socket.emit('error', { message: 'Invalid join data' });
                return;
            }
            
            // Require a proper nickname - no anonymous users
            if (!nickname || nickname.trim() === '' || nickname.toLowerCase().includes('anonymous')) {
                socket.emit('error', { message: 'Please provide a valid name to join the canvas' });
                return;
            }
            
            currentUserId = userId;
            
            sessionManager.joinSession(userId, socket, {
                nickname: nickname.substring(0, 20).trim(), // Limit nickname length
                joinedAt: Date.now()
            });
            
            // Send current session state to new user
            socket.emit('session-joined', {
                sessionId: 'canvas-room',
                userId,
                users: Array.from(sessionManager.users.values()).map(u => ({
                    userId: u.userId,
                    nickname: u.nickname,
                    joinedAt: u.joinedAt
                })),
                userCount: sessionManager.users.size
            });
            
            // Send recent messages to new user
            if (sessionManager.messageBuffer.length > 0) {
                socket.emit('message-history', { messages: sessionManager.messageBuffer });
            }
            
            // Send canvas state to new user
            const savedCanvasState = canvasPersistence.getCanvasState();
            if (savedCanvasState) {
                console.log(`Sending saved canvas state to user ${userId}`);
                socket.emit('canvas-state', { 
                    data: savedCanvasState,
                    isServerState: true 
                });
            } else {
                console.log(`No saved state, sending empty canvas to user ${userId}`);
                socket.emit('canvas-state', { 
                    data: null,
                    isServerState: true,
                    isEmpty: true
                });
            }
            
            // Notify other users about new user
            sessionManager.broadcastToAll('user-joined', {
                userId,
                nickname: nickname.substring(0, 20).trim(),
                joinedAt: Date.now(),
                userCount: sessionManager.users.size
            }, userId);
            
            console.log(`User ${userId} (${nickname}) joined canvas`);
            
        } catch (error) {
            console.error('Error in join-session:', error);
            socket.emit('error', { message: 'Failed to join session' });
        }
    });
    
    // Leave session handler
    socket.on('leave-session', () => {
        try {
            if (currentUserId) {
                sessionManager.leaveSession(currentUserId, socket.id);
                console.log(`User ${currentUserId} left canvas`);
            }
        } catch (error) {
            console.error('Error in leave-session:', error);
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
    
    // High-performance drawing data with server authority and conflict resolution
    socket.on('drawing-data', (data) => {
        if (!checkRateLimit('drawing', 120)) { // Higher limit for drawing
            return; // Silently drop to avoid disrupting drawing
        }
        
        try {
            if (!currentUserId) return;
            
            // Validate and process drawing data through authoritative system
            const validatedData = sessionManager.validateAndProcessDrawing(currentUserId, data);
            
            if (!validatedData) {
                // Send correction back to client if needed
                socket.emit('drawing-correction', {
                    reason: 'invalid_data',
                    originalSequence: data.sequence,
                    timestamp: Date.now()
                });
                return;
            }
            
            const drawingMessage = {
                type: 'drawing-data',
                userId: currentUserId,
                data: validatedData,
                timestamp: Date.now(),
                serverSequence: validatedData.serverSequence
            };
            
            // Broadcast validated drawing data to all users
            sessionManager.broadcastToAll('drawing-data', drawingMessage);
            
            sessionManager.lastActivity = Date.now();
            
            // Keep only last 2000 drawing actions to prevent memory issues
            if (sessionManager.drawingActions.length > 2000) {
                sessionManager.drawingActions = sessionManager.drawingActions.slice(-2000);
            }
            
        } catch (error) {
            console.error('Error in drawing-data:', error);
        }
    });
    
    // Optimized chat messaging with improved validation and race condition handling
    socket.on('chat-message', (data) => {
        if (!checkRateLimit('chat', 5)) { // Reduced rate limit for better control
            socket.emit('error', { message: 'Rate limit exceeded for chat' });
            return;
        }
        
        try {
            const { message } = data;
            
            if (!message || !currentUserId) {
                socket.emit('error', { message: 'Invalid chat data' });
                return;
            }
            
            // Enhanced message validation
            if (typeof message !== 'string') {
                socket.emit('error', { message: 'Message must be a string' });
                return;
            }
            
            // Sanitize and validate message with strict length limit
            const sanitizedMessage = message
                .replace(/[\r\n\t]/g, ' ') // Replace line breaks with spaces
                .replace(/\s+/g, ' ') // Collapse multiple spaces
                .trim()
                .substring(0, 300); // Increased limit but still reasonable
            
            if (sanitizedMessage === '' || sanitizedMessage.length < 1) {
                socket.emit('error', { message: 'Message cannot be empty' });
                return;
            }
            
            const user = sessionManager.users.get(currentUserId);
            if (!user) {
                socket.emit('error', { message: 'User not found in session' });
                return;
            }
            
            const chatMessage = {
                type: 'chat-message',
                userId: currentUserId,
                nickname: user.nickname,
                message: sanitizedMessage,
                timestamp: Date.now(),
                messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}` // Unique ID for deduplication
            };
            
            // Check for duplicate messages (race condition prevention)
            const recentMessages = sessionManager.messageBuffer.slice(-10);
            const isDuplicate = recentMessages.some(msg => 
                msg.userId === currentUserId && 
                msg.message === sanitizedMessage && 
                (Date.now() - msg.timestamp) < 1000 // Within 1 second
            );
            
            if (isDuplicate) {
                console.log(`Duplicate message detected from ${currentUserId}, ignoring`);
                return;
            }
            
            // Add to message buffer with size management
            sessionManager.messageBuffer.push(chatMessage);
            if (sessionManager.messageBuffer.length > 100) {
                sessionManager.messageBuffer = sessionManager.messageBuffer.slice(-100); // Keep last 100 messages
            }
            
            // Broadcast to all users
            sessionManager.broadcastToAll('chat-message', chatMessage);
            
            sessionManager.lastActivity = Date.now();
            
            console.log(`Chat message from ${user.nickname}: ${sanitizedMessage.substring(0, 50)}...`);
            
        } catch (error) {
            console.error('Error in chat-message:', error);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });
    
    // Canvas state synchronization - simplified for single canvas
    socket.on('canvas-state', (data) => {
        try {
            if (!currentUserId) return;
            
            // Save canvas state to persistent storage
            if (data.imageData) {
                canvasPersistence.saveCanvasState({
                    imageData: data.imageData,
                    timestamp: Date.now(),
                    lastModifiedBy: currentUserId
                });
            }
            
            sessionManager.lastActivity = Date.now();
            
        } catch (error) {
            console.error('Error in canvas-state:', error);
        }
    });
    
    // Handle explicit canvas state requests
    socket.on('request-canvas-state', (data) => {
        try {
            if (!currentUserId) return;
            
            const canvasState = canvasPersistence.getCanvasState();
            if (canvasState) {
                console.log(`Sending requested canvas state to user ${currentUserId}`);
                socket.emit('canvas-state', { 
                    data: canvasState,
                    isServerState: true 
                });
            } else {
                console.log(`No saved state, sending empty state to user ${currentUserId}`);
                socket.emit('canvas-state', { 
                    data: null,
                    isServerState: true,
                    isEmpty: true
                });
            }
            
        } catch (error) {
            console.error('Error in request-canvas-state:', error);
        }
    });
    
    // Cursor position updates (optional, for showing remote cursors)
    socket.on('cursor-position', (data) => {
        try {
            if (!currentUserId) return;
            
            // Broadcast cursor position to other users
            sessionManager.broadcastToAll('cursor-position', {
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
            if (!currentUserId) return;
            
            const { nickname, timestamp } = data;
            if (!nickname) return;
            
            const user = sessionManager.users.get(currentUserId);
            if (!user) return;
            
            // Update user info
            user.nickname = nickname.substring(0, 20); // Limit length
            user.lastSeen = timestamp || Date.now();
            
            sessionManager.lastActivity = Date.now();
            
            // Broadcast nickname change to other users
            sessionManager.broadcastToAll('user-info-update', {
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
        
        if (currentUserId) {
            // Notify other users about disconnection
            sessionManager.broadcastToAll('user-left', {
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

// Health check endpoint with enhanced metrics
app.get('/health', (req, res) => {
    const totalUsers = sessionManager.users.size;
    
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        totalUsers,
        connectedSockets: io.engine.clientsCount,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Canvas metrics
app.get('/api/metrics', (req, res) => {
    res.json({
        userCount: sessionManager.users.size,
        createdAt: sessionManager.createdAt,
        lastActivity: sessionManager.lastActivity,
        messageCount: sessionManager.messageBuffer.length,
        users: Array.from(sessionManager.users.values()).map(u => ({
            userId: u.userId,
            nickname: u.nickname,
            joinedAt: u.joinedAt,
            lastSeen: u.lastSeen
        }))
    });
});

// Legacy API endpoint for backwards compatibility
app.get('/api/session-info', (req, res) => {
    res.json({
        userCount: sessionManager.users.size,
        users: Array.from(sessionManager.users.values()).map(u => ({
            userId: u.userId,
            nickname: u.nickname,
            joinedAt: u.joinedAt
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
