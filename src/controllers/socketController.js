/**
 * Socket controller for handling WebSocket connections and events
 * Provides secure, optimized real-time communication with memory leak prevention
 */

const config = require('../config/config');
const logger = require('../utils/logger');
const memoryManager = require('../utils/memoryManager');
const securityValidator = require('../utils/security');
const rateLimiter = require('../middleware/rateLimiter');
const sessionManager = require('../services/sessionManager');
const canvasPersistence = require('../services/canvasPersistence');

class SocketController {
    constructor() {
        this.activeConnections = new Map(); // socketId -> connection data
        this.connectionStats = {
            totalConnections: 0,
            currentConnections: 0,
            totalMessages: 0,
            totalErrors: 0
        };
        
        // Register with memory manager
        memoryManager.registerObject('socketController', this, () => this.cleanup());
        
        logger.info('Socket controller initialized');
    }

    /**
     * Initialize socket server with optimized settings
     */
    initializeSocket(server) {
        const io = require('socket.io')(server, config.socketIO);
        
        // Apply global rate limiting
        io.use((socket, next) => {
            const rateLimitCheck = rateLimiter.createSocketRateLimiter('connection');
            rateLimitCheck(socket, next);
        });

        // Connection handler
        io.on('connection', (socket) => {
            this.handleConnection(socket, io);
        });

        // Global error handler
        io.engine.on('connection_error', (err) => {
            logger.error('Socket.IO connection error', {
                error: err.message,
                code: err.code,
                context: err.context
            });
        });

        this.io = io;
        logger.info('Socket.IO server initialized', {
            transports: config.socketIO.transports,
            cors: config.socketIO.cors
        });

        return io;
    }

    /**
     * Handle new socket connection
     */
    handleConnection(socket) {
        const connectionData = {
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            messageCount: 0,
            errorCount: 0,
            ip: socket.handshake.address,
            userAgent: socket.handshake.headers['user-agent'] || 'unknown'
        };

        this.activeConnections.set(socket.id, connectionData);
        this.connectionStats.totalConnections++;
        this.connectionStats.currentConnections++;

        logger.logConnection('connect', socket.id);

        // Set up event handlers
        this.setupEventHandlers(socket);

        // Connection timeout
        const timeout = setTimeout(() => {
            if (socket.connected && !this.getSocketUserId(socket)) {
                logger.warn('Socket connection timeout - no user association', {
                    socketId: socket.id,
                    duration: Date.now() - connectionData.connectedAt
                });
                socket.disconnect(true);
            }
        }, 60000); // 1 minute timeout

        socket.on('disconnect', () => {
            clearTimeout(timeout);
        });

        memoryManager.touchObject('socketController');
    }

    /**
     * Set up event handlers for a socket
     */
    setupEventHandlers(socket) {
        const userId = () => this.getSocketUserId(socket);
        
        // Anonymous browsing
        socket.on('anonymous-browse', () => {
            this.handleAnonymousBrowse(socket);
        });

        socket.on('request-canvas-state-anonymous', () => {
            this.handleCanvasStateRequest(socket, true);
        });

        // User session management
        socket.on('join-session', (data) => {
            this.handleJoinSession(socket, data);
        });

        socket.on('leave-session', () => {
            this.handleLeaveSession(socket);
        });

        // Drawing events with rate limiting
        socket.on('drawing-data', this.createRateLimitedHandler(
            socket, 'drawing', (data) => this.handleDrawingData(socket, data)
        ));

        // Chat events with rate limiting
        socket.on('chat-message', this.createRateLimitedHandler(
            socket, 'chat', (data) => this.handleChatMessage(socket, data)
        ));

        // WebRTC signaling with rate limiting
        socket.on('webrtc-signal', this.createRateLimitedHandler(
            socket, 'signaling', (data) => this.handleWebRTCSignal(socket, data)
        ));

        // Canvas state management
        socket.on('canvas-state', (data) => {
            this.handleCanvasState(socket, data);
        });

        socket.on('request-canvas-state', () => {
            this.handleCanvasStateRequest(socket, false);
        });

        // Cursor tracking (optional)
        socket.on('cursor-position', (data) => {
            this.handleCursorPosition(socket, data);
        });

        // User info updates
        socket.on('user-info-update', (data) => {
            this.handleUserInfoUpdate(socket, data);
        });

        // Heartbeat
        socket.on('ping', () => {
            socket.emit('pong');
            this.updateConnectionActivity(socket);
        });

        // Disconnect handler
        socket.on('disconnect', (reason) => {
            this.handleDisconnect(socket, reason);
        });

        // Error handler
        socket.on('error', (error) => {
            this.handleSocketError(socket, error);
        });
    }

    /**
     * Create rate-limited event handler
     */
    createRateLimitedHandler(socket, eventType, handler) {
        return (data) => {
            const allowed = this.checkRateLimit(socket, eventType);
            if (!allowed) {
                return; // Silently drop to avoid disrupting user experience
            }

            try {
                handler(data);
                this.updateConnectionActivity(socket);
            } catch (error) {
                this.handleEventError(socket, eventType, error);
            }
        };
    }

    /**
     * Check rate limit for socket event
     */
    checkRateLimit(socket, eventType) {
        const clientId = this.getClientId(socket);
        const limitConfig = config.security.rateLimiting[eventType];
        
        if (!limitConfig) {
            return true;
        }

        return rateLimiter.checkLimit(clientId, eventType, limitConfig);
    }

    /**
     * Get client ID for rate limiting
     */
    getClientId(socket) {
        const ip = socket.handshake.address;
        const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
        return `${ip}_${this.hashString(userAgent)}`;
    }

    /**
     * Hash string for client identification
     */
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * Handle anonymous browse request
     */
    handleAnonymousBrowse(socket) {
        try {
            sessionManager.addAnonymousBrowser(socket);
            socket.emit('anonymous-browse-confirmed');
            
            // Send current canvas state
            this.sendCanvasStateToSocket(socket, true);
            
            logger.debug('Anonymous browser connected', { socketId: socket.id });

        } catch (error) {
            logger.error('Error handling anonymous browse', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Handle join session request
     */
    handleJoinSession(socket, data) {
        try {
            if (!data || !data.userId || !data.nickname) {
                socket.emit('error', { message: 'Invalid join data' });
                return;
            }

            const result = sessionManager.joinSession(data.userId, socket, {
                nickname: data.nickname
            });

            if (!result.success) {
                socket.emit('error', { message: result.error });
                return;
            }

            // Send session joined confirmation
            socket.emit('session-joined', {
                sessionId: 'canvas-room',
                userId: data.userId,
                users: Array.from(sessionManager.users.values()).map(u => ({
                    userId: u.userId,
                    nickname: u.nickname,
                    joinedAt: u.joinedAt
                })),
                userCount: sessionManager.users.size
            });

            // Send message history
            if (sessionManager.messageBuffer.length > 0) {
                socket.emit('message-history', { 
                    messages: sessionManager.messageBuffer.slice(-50) // Last 50 messages
                });
            }

            // Send canvas state
            this.sendCanvasStateToSocket(socket, false);

            // Notify other users
            sessionManager.broadcastToAll('user-joined', {
                userId: data.userId,
                nickname: result.user.nickname,
                joinedAt: result.user.joinedAt,
                userCount: result.userCount
            }, data.userId);

            logger.info('User joined session', {
                userId: data.userId,
                nickname: result.user.nickname,
                socketId: socket.id
            });

        } catch (error) {
            logger.error('Error handling join session', { 
                socketId: socket.id, 
                error 
            });
            socket.emit('error', { message: 'Failed to join session' });
        }
    }

    /**
     * Handle leave session request
     */
    handleLeaveSession(socket) {
        try {
            const userId = this.getSocketUserId(socket);
            if (userId) {
                const success = sessionManager.leaveSession(userId, socket.id);
                if (success) {
                    sessionManager.broadcastToAll('user-left', {
                        userId,
                        timestamp: Date.now(),
                        userCount: sessionManager.users.size
                    }, userId);
                }
            }

        } catch (error) {
            logger.error('Error handling leave session', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Handle drawing data
     */
    handleDrawingData(socket, data) {
        try {
            const userId = this.getSocketUserId(socket);
            if (!userId) {
                return;
            }

            const result = sessionManager.processDrawingData(userId, data);
            if (!result.valid) {
                if (result.error !== 'Not in drawing state') { // Don't spam for normal state issues
                    socket.emit('drawing-correction', {
                        reason: result.error,
                        originalSequence: data.sequence,
                        timestamp: Date.now()
                    });
                }
                return;
            }

            const drawingMessage = {
                type: 'drawing-data',
                userId,
                data: result.data,
                timestamp: Date.now(),
                serverSequence: result.data.serverSequence
            };

            // Broadcast to all users and anonymous browsers
            sessionManager.broadcastToAll('drawing-data', drawingMessage);

            logger.logDrawingAction(userId, data.type, {
                strokeId: result.data.strokeId,
                sequence: result.data.serverSequence
            });

        } catch (error) {
            logger.error('Error handling drawing data', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Handle chat message
     */
    handleChatMessage(socket, data) {
        try {
            const userId = this.getSocketUserId(socket);
            if (!userId) {
                socket.emit('error', { message: 'Not in session' });
                return;
            }

            if (!data || !data.message) {
                socket.emit('error', { message: 'Invalid message data' });
                return;
            }

            const validation = securityValidator.validateInput(data.message, 'message');
            if (!validation.valid) {
                socket.emit('error', { message: validation.error });
                return;
            }

            const user = sessionManager.users.get(userId);
            if (!user) {
                socket.emit('error', { message: 'User not found' });
                return;
            }

            const chatMessage = {
                type: 'chat-message',
                userId,
                nickname: user.nickname,
                message: validation.sanitized,
                timestamp: Date.now(),
                messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            };

            const added = sessionManager.addMessage(chatMessage);
            if (!added) {
                return; // Duplicate message
            }

            // Broadcast to all users
            sessionManager.broadcastToAll('chat-message', chatMessage);

            logger.debug('Chat message sent', {
                userId,
                nickname: user.nickname,
                messageLength: validation.sanitized.length
            });

        } catch (error) {
            logger.error('Error handling chat message', { 
                socketId: socket.id, 
                error 
            });
            socket.emit('error', { message: 'Failed to send message' });
        }
    }

    /**
     * Handle WebRTC signaling
     */
    handleWebRTCSignal(socket, data) {
        try {
            const userId = this.getSocketUserId(socket);
            if (!userId) {
                return;
            }

            if (!data || !data.targetUserId || !data.signal) {
                socket.emit('error', { message: 'Invalid signaling data' });
                return;
            }

            const validTypes = ['offer', 'answer', 'ice-candidate', 'user-joined'];
            if (!validTypes.includes(data.signal.type)) {
                socket.emit('error', { message: 'Invalid signal type' });
                return;
            }

            const targetSocket = sessionManager.userSockets.get(data.targetUserId);
            if (targetSocket && targetSocket.connected) {
                targetSocket.emit('webrtc-signal', {
                    fromUserId: userId,
                    signal: data.signal
                });
            }

        } catch (error) {
            logger.error('Error handling WebRTC signal', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Handle canvas state save
     */
    async handleCanvasState(socket, data) {
        try {
            const userId = this.getSocketUserId(socket);
            if (!userId) {
                return;
            }

            if (data && data.imageData) {
                await canvasPersistence.saveCanvasState('main', {
                    imageData: data.imageData,
                    timestamp: Date.now(),
                    lastModifiedBy: userId
                });
            }

        } catch (error) {
            logger.error('Error handling canvas state', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Handle canvas state request
     */
    async handleCanvasStateRequest(socket, isAnonymous = false) {
        try {
            this.sendCanvasStateToSocket(socket, isAnonymous);

        } catch (error) {
            logger.error('Error handling canvas state request', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Send canvas state to socket
     */
    async sendCanvasStateToSocket(socket, isAnonymous = false) {
        try {
            const canvasState = await canvasPersistence.loadCanvasState('main');
            
            if (canvasState) {
                socket.emit('canvas-state', {
                    data: canvasState,
                    isServerState: true
                });
                logger.debug('Canvas state sent', { 
                    socketId: socket.id, 
                    isAnonymous 
                });
            } else {
                socket.emit('canvas-state', {
                    data: null,
                    isServerState: true,
                    isEmpty: true
                });
                logger.debug('Empty canvas state sent', { 
                    socketId: socket.id, 
                    isAnonymous 
                });
            }

        } catch (error) {
            logger.error('Error sending canvas state', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Handle cursor position updates
     */
    handleCursorPosition(socket, data) {
        try {
            const userId = this.getSocketUserId(socket);
            if (!userId) {
                return;
            }

            // Broadcast cursor position to other users
            sessionManager.broadcastToAll('cursor-position', {
                userId,
                ...data
            }, userId);

        } catch (error) {
            logger.error('Error handling cursor position', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Handle user info updates
     */
    handleUserInfoUpdate(socket, data) {
        try {
            const userId = this.getSocketUserId(socket);
            if (!userId) {
                return;
            }

            if (!data || !data.nickname) {
                return;
            }

            const validation = securityValidator.validateInput(data.nickname, 'nickname');
            if (!validation.valid) {
                socket.emit('error', { message: validation.error });
                return;
            }

            const user = sessionManager.users.get(userId);
            if (!user) {
                return;
            }

            user.nickname = validation.sanitized;
            user.lastSeen = Date.now();

            // Broadcast nickname change
            sessionManager.broadcastToAll('user-info-update', {
                userId,
                nickname: user.nickname,
                timestamp: user.lastSeen
            }, userId);

            logger.info('User info updated', {
                userId,
                newNickname: user.nickname
            });

        } catch (error) {
            logger.error('Error handling user info update', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Handle socket disconnect
     */
    handleDisconnect(socket, reason) {
        try {
            const connectionData = this.activeConnections.get(socket.id);
            const userId = this.getSocketUserId(socket);

            if (connectionData) {
                const duration = Date.now() - connectionData.connectedAt;
                
                logger.logConnection('disconnect', socket.id, userId);
                logger.debug('Socket disconnected', {
                    socketId: socket.id,
                    userId,
                    reason,
                    duration,
                    messageCount: connectionData.messageCount
                });

                this.activeConnections.delete(socket.id);
                this.connectionStats.currentConnections--;
            }

            // Clean up user session
            if (userId) {
                sessionManager.leaveSession(userId, socket.id);
                
                sessionManager.broadcastToAll('user-left', {
                    userId,
                    timestamp: Date.now(),
                    userCount: sessionManager.users.size
                }, userId);
            }

            // Clean up anonymous browser
            sessionManager.removeAnonymousBrowser(socket);

        } catch (error) {
            logger.error('Error handling disconnect', { 
                socketId: socket.id, 
                error 
            });
        }
    }

    /**
     * Handle socket errors
     */
    handleSocketError(socket, error) {
        const connectionData = this.activeConnections.get(socket.id);
        if (connectionData) {
            connectionData.errorCount++;
        }
        
        this.connectionStats.totalErrors++;

        logger.error('Socket error', {
            socketId: socket.id,
            error: error.message || error,
            userId: this.getSocketUserId(socket)
        });
    }

    /**
     * Handle event processing errors
     */
    handleEventError(socket, eventType, error) {
        logger.error('Event processing error', {
            socketId: socket.id,
            eventType,
            error: error.message || error,
            userId: this.getSocketUserId(socket)
        });

        socket.emit('error', {
            message: 'Processing error',
            type: 'PROCESSING_ERROR'
        });
    }

    /**
     * Update connection activity
     */
    updateConnectionActivity(socket) {
        const connectionData = this.activeConnections.get(socket.id);
        if (connectionData) {
            connectionData.lastActivity = Date.now();
            connectionData.messageCount++;
        }
        this.connectionStats.totalMessages++;
    }

    /**
     * Get user ID associated with socket
     */
    getSocketUserId(socket) {
        return sessionManager.socketUsers.get(socket.id);
    }

    /**
     * Get connection statistics
     */
    getStats() {
        return {
            ...this.connectionStats,
            activeConnections: this.activeConnections.size,
            memoryUsage: this.estimateMemoryUsage(),
            rateLimiterStats: rateLimiter.getStats()
        };
    }

    /**
     * Estimate memory usage
     */
    estimateMemoryUsage() {
        let totalSize = 0;
        
        for (const [socketId, data] of this.activeConnections.entries()) {
            totalSize += socketId.length * 2;
            totalSize += 128; // Estimate for connection data
        }
        
        return Math.round(totalSize / 1024); // Return in KB
    }

    /**
     * Graceful cleanup for shutdown
     */
    async cleanup() {
        logger.info('Socket controller cleanup initiated');
        
        try {
            // Disconnect all sockets
            if (this.io) {
                this.io.disconnectSockets(true);
                this.io.close();
            }

            // Clear connection data
            this.activeConnections.clear();

            logger.info('Socket controller cleanup completed');

        } catch (error) {
            logger.error('Error during socket controller cleanup', { error });
        }
    }
}

// Create singleton instance
const socketController = new SocketController();

module.exports = socketController;
