/**
 * Optimized session manager with memory leak prevention and cleanup
 * Provides efficient user and session management with automatic resource cleanup
 */

const EventEmitter = require('events');
const config = require('../config/config');
const logger = require('../utils/logger');
const memoryManager = require('../utils/memoryManager');
const securityValidator = require('../utils/security');

class SessionManager extends EventEmitter {
    constructor() {
        super();
        
        // Core data structures
        this.users = new Map(); // userId -> user data
        this.userSockets = new Map(); // userId -> socket
        this.socketUsers = new Map(); // socketId -> userId
        this.anonymousBrowsers = new Set(); // Set of anonymous socket connections
        
        // Drawing and messaging state
        this.drawingStates = new Map(); // userId -> drawing state
        this.activeStrokes = new Map(); // strokeId -> stroke data
        this.messageBuffer = []; // Recent messages
        this.drawingActions = []; // Historical drawing actions
        
        // Performance tracking
        this.sequenceNumbers = new Map(); // userId -> last sequence
        this.lastSequence = 0;
        this.createdAt = Date.now();
        this.lastActivity = Date.now();
        this.lastCleanup = Date.now();
        
        // Memory management
        this.maxUsers = config.security.sessions.maxUsersPerSession;
        this.sessionTimeout = config.security.sessions.sessionTimeoutMs;
        
        // Register with memory manager
        memoryManager.registerObject('sessionManager', this, () => this.cleanup());
        
        // Start cleanup intervals
        this.startCleanupSchedules();
        
        logger.info('Session manager initialized', {
            maxUsers: this.maxUsers,
            sessionTimeout: this.sessionTimeout
        });
    }

    /**
     * Start cleanup schedules
     */
    startCleanupSchedules() {
        // User cleanup every 5 minutes
        setInterval(() => {
            this.cleanupInactiveUsers();
        }, config.security.sessions.cleanupIntervalMs);

        // Stroke cleanup every 10 minutes
        setInterval(() => {
            this.cleanupOldStrokes();
        }, config.memory.cleanupIntervalMs);

        // Message buffer cleanup every 15 minutes
        setInterval(() => {
            this.cleanupMessageBuffer();
        }, 15 * 60 * 1000);

        // Anonymous browser cleanup every 5 minutes
        setInterval(() => {
            this.cleanupAnonymousBrowsers();
        }, 5 * 60 * 1000);
    }

    /**
     * Join a user to the session with validation
     */
    joinSession(userId, socket, userInfo) {
        try {
            // Validate inputs
            const userValidation = securityValidator.validateUserId(userId);
            if (!userValidation.valid) {
                logger.warn('Invalid user ID in join session', {
                    userId,
                    error: userValidation.error
                });
                return { success: false, error: userValidation.error };
            }

            const nicknameValidation = securityValidator.validateInput(userInfo.nickname, 'nickname');
            if (!nicknameValidation.valid) {
                logger.warn('Invalid nickname in join session', {
                    userId,
                    nickname: userInfo.nickname,
                    error: nicknameValidation.error
                });
                return { success: false, error: nicknameValidation.error };
            }

            // Check session capacity
            if (this.users.size >= this.maxUsers) {
                logger.warn('Session at capacity', {
                    currentUsers: this.users.size,
                    maxUsers: this.maxUsers,
                    attemptingUserId: userId
                });
                return { success: false, error: 'Session is full' };
            }

            // Check if user is blocked
            if (securityValidator.isUserBlocked(userId)) {
                logger.warn('Blocked user attempted to join', { userId });
                return { success: false, error: 'Access denied' };
            }

            const sanitizedUserId = userValidation.sanitized;
            const sanitizedNickname = nicknameValidation.sanitized;

            // Handle existing user (reconnection)
            if (this.users.has(sanitizedUserId)) {
                const existingUser = this.users.get(sanitizedUserId);
                
                // Update socket mappings
                const oldSocket = this.userSockets.get(sanitizedUserId);
                if (oldSocket && oldSocket.id !== socket.id) {
                    this.socketUsers.delete(oldSocket.id);
                }
                
                this.userSockets.set(sanitizedUserId, socket);
                this.socketUsers.set(socket.id, sanitizedUserId);
                
                // Update user info
                existingUser.lastSeen = Date.now();
                existingUser.socketId = socket.id;
                existingUser.reconnectCount = (existingUser.reconnectCount || 0) + 1;
                
                logger.info('User reconnected', {
                    userId: sanitizedUserId,
                    nickname: sanitizedNickname,
                    reconnectCount: existingUser.reconnectCount
                });
            } else {
                // New user
                this.users.set(sanitizedUserId, {
                    userId: sanitizedUserId,
                    nickname: sanitizedNickname,
                    joinedAt: Date.now(),
                    lastSeen: Date.now(),
                    socketId: socket.id,
                    messageCount: 0,
                    drawingCount: 0,
                    reconnectCount: 0
                });

                // Initialize drawing state
                this.drawingStates.set(sanitizedUserId, {
                    isDrawing: false,
                    currentStroke: null,
                    lastPosition: null,
                    strokeCount: 0,
                    lastDrawTime: 0
                });

                this.sequenceNumbers.set(sanitizedUserId, 0);

                logger.info('New user joined session', {
                    userId: sanitizedUserId,
                    nickname: sanitizedNickname,
                    totalUsers: this.users.size
                });
            }

            // Update socket mappings
            this.userSockets.set(sanitizedUserId, socket);
            this.socketUsers.set(socket.id, sanitizedUserId);

            // Join socket room
            socket.join('canvas-room');

            this.lastActivity = Date.now();
            memoryManager.touchObject('sessionManager');

            // Emit event
            this.emit('userJoined', {
                userId: sanitizedUserId,
                nickname: sanitizedNickname,
                userCount: this.users.size
            });

            return {
                success: true,
                user: this.users.get(sanitizedUserId),
                userCount: this.users.size
            };

        } catch (error) {
            logger.error('Error in joinSession', { userId, error });
            return { success: false, error: 'Internal server error' };
        }
    }

    /**
     * Remove user from session with cleanup
     */
    leaveSession(userId, socketId = null) {
        try {
            if (!userId || !this.users.has(userId)) {
                return false;
            }

            const user = this.users.get(userId);
            
            // Clean up all user data
            this.users.delete(userId);
            this.userSockets.delete(userId);
            this.drawingStates.delete(userId);
            this.sequenceNumbers.delete(userId);
            
            if (socketId) {
                this.socketUsers.delete(socketId);
            }

            // Clean up any active strokes by this user
            this.cleanupUserStrokes(userId);

            this.lastActivity = Date.now();
            memoryManager.touchObject('sessionManager');

            logger.info('User left session', {
                userId,
                nickname: user.nickname,
                sessionDuration: Date.now() - user.joinedAt,
                messageCount: user.messageCount,
                drawingCount: user.drawingCount,
                remainingUsers: this.users.size
            });

            // Emit event
            this.emit('userLeft', {
                userId,
                nickname: user.nickname,
                userCount: this.users.size
            });

            return true;

        } catch (error) {
            logger.error('Error in leaveSession', { userId, error });
            return false;
        }
    }

    /**
     * Add anonymous browser
     */
    addAnonymousBrowser(socket) {
        try {
            this.anonymousBrowsers.add(socket);
            
            logger.debug('Anonymous browser added', {
                socketId: socket.id,
                totalAnonymous: this.anonymousBrowsers.size
            });

            memoryManager.touchObject('sessionManager');

        } catch (error) {
            logger.error('Error adding anonymous browser', { error });
        }
    }

    /**
     * Remove anonymous browser
     */
    removeAnonymousBrowser(socket) {
        try {
            this.anonymousBrowsers.delete(socket);
            
            logger.debug('Anonymous browser removed', {
                socketId: socket.id,
                totalAnonymous: this.anonymousBrowsers.size
            });

        } catch (error) {
            logger.error('Error removing anonymous browser', { error });
        }
    }

    /**
     * Broadcast to all session members and anonymous browsers
     */
    broadcastToAll(event, data, excludeUserId = null) {
        try {
            let sentCount = 0;
            let errorCount = 0;

            // Broadcast to session members
            for (const [userId, user] of this.users.entries()) {
                if (userId !== excludeUserId) {
                    const socket = this.userSockets.get(userId);
                    if (socket && socket.connected) {
                        try {
                            socket.emit(event, data);
                            sentCount++;
                        } catch (error) {
                            logger.warn('Error broadcasting to user', { userId, error });
                            errorCount++;
                        }
                    }
                }
            }

            // Broadcast to anonymous browsers for certain events
            const anonymousBrowserEvents = ['drawing-data', 'canvas-state', 'canvasCleared'];
            if (anonymousBrowserEvents.includes(event)) {
                for (const socket of this.anonymousBrowsers) {
                    if (socket.connected) {
                        try {
                            socket.emit(event, data);
                            sentCount++;
                        } catch (error) {
                            logger.warn('Error broadcasting to anonymous browser', {
                                socketId: socket.id,
                                error
                            });
                            errorCount++;
                            // Remove disconnected socket
                            this.anonymousBrowsers.delete(socket);
                        }
                    }
                }
            }

            if (errorCount > 0) {
                logger.warn('Broadcast completed with errors', {
                    event,
                    sentCount,
                    errorCount
                });
            }

            this.lastActivity = Date.now();

        } catch (error) {
            logger.error('Error in broadcastToAll', { event, error });
        }
    }

    /**
     * Process and validate drawing data
     */
    processDrawingData(userId, drawingData) {
        try {
            const user = this.users.get(userId);
            const drawingState = this.drawingStates.get(userId);
            
            if (!user || !drawingState) {
                return { valid: false, error: 'User not found' };
            }

            // Validate drawing data
            const validation = securityValidator.validateDrawingData(drawingData);
            if (!validation.valid) {
                logger.warn('Invalid drawing data', {
                    userId,
                    error: validation.error
                });
                return validation;
            }

            const now = Date.now();
            this.lastSequence++;
            
            let processedData = {
                ...validation.data,
                userId,
                serverSequence: this.lastSequence,
                serverTimestamp: now
            };

            // Process based on drawing type
            switch (drawingData.type) {
                case 'startDrawing':
                    return this.processStartDrawing(userId, drawingState, processedData);
                    
                case 'draw':
                    return this.processDrawing(userId, drawingState, processedData);
                    
                case 'endDrawing':
                    return this.processEndDrawing(userId, drawingState, processedData);
                    
                case 'clear-canvas':
                    return this.processClearCanvas(userId, processedData);
                    
                default:
                    return { valid: false, error: 'Unknown drawing type' };
            }

        } catch (error) {
            logger.error('Error processing drawing data', { userId, error });
            return { valid: false, error: 'Processing error' };
        }
    }

    /**
     * Process start drawing event
     */
    processStartDrawing(userId, drawingState, data) {
        // Validate position bounds
        if (data.normalizedX < 0 || data.normalizedX > 1 || 
            data.normalizedY < 0 || data.normalizedY > 1) {
            return { valid: false, error: 'Coordinates out of bounds' };
        }

        // End any existing stroke
        if (drawingState.isDrawing) {
            this.forceEndStroke(userId, drawingState);
        }

        // Create new stroke
        const strokeId = `${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        drawingState.isDrawing = true;
        drawingState.currentStroke = strokeId;
        drawingState.lastPosition = {
            x: data.normalizedX,
            y: data.normalizedY
        };
        drawingState.strokeCount++;
        drawingState.lastDrawTime = Date.now();

        // Store stroke data
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

        // Update user stats
        const user = this.users.get(userId);
        if (user) {
            user.drawingCount++;
        }

        return {
            valid: true,
            data: {
                ...data,
                strokeId,
                validated: true
            }
        };
    }

    /**
     * Process drawing event
     */
    processDrawing(userId, drawingState, data) {
        if (!drawingState.isDrawing || !drawingState.currentStroke) {
            return { valid: false, error: 'Not in drawing state' };
        }

        const stroke = this.activeStrokes.get(drawingState.currentStroke);
        if (!stroke) {
            this.forceEndStroke(userId, drawingState);
            return { valid: false, error: 'Stroke not found' };
        }

        // Validate realistic movement
        const lastPos = drawingState.lastPosition;
        if (lastPos) {
            const distance = Math.sqrt(
                Math.pow(data.normalizedX - lastPos.x, 2) + 
                Math.pow(data.normalizedY - lastPos.y, 2)
            );
            
            if (distance > config.canvas.maxDrawingDistance) {
                logger.debug('Rejecting large jump in drawing', {
                    userId,
                    distance,
                    maxDistance: config.canvas.maxDrawingDistance
                });
                return { valid: false, error: 'Movement too large' };
            }
        }

        // Check stroke point limit
        if (stroke.points.length >= config.canvas.maxStrokePoints) {
            this.forceEndStroke(userId, drawingState);
            return { valid: false, error: 'Stroke too long' };
        }

        // Add point to stroke
        stroke.points.push({
            x: data.normalizedX,
            y: data.normalizedY,
            timestamp: Date.now()
        });

        drawingState.lastPosition = {
            x: data.normalizedX,
            y: data.normalizedY
        };
        drawingState.lastDrawTime = Date.now();

        return {
            valid: true,
            data: {
                ...data,
                strokeId: drawingState.currentStroke,
                validated: true
            }
        };
    }

    /**
     * Process end drawing event
     */
    processEndDrawing(userId, drawingState, data) {
        if (!drawingState.isDrawing || !drawingState.currentStroke) {
            return { valid: false, error: 'Not in drawing state' };
        }

        const stroke = this.activeStrokes.get(drawingState.currentStroke);
        const strokeId = drawingState.currentStroke;

        if (stroke) {
            stroke.endTime = Date.now();
            
            // Move to drawing actions for history
            this.drawingActions.push({
                type: 'completed-stroke',
                strokeId,
                stroke: { ...stroke }, // Clone to prevent modifications
                timestamp: Date.now(),
                serverSequence: this.lastSequence
            });

            // Remove from active strokes
            this.activeStrokes.delete(strokeId);
        }

        // Clear drawing state
        drawingState.isDrawing = false;
        drawingState.currentStroke = null;
        drawingState.lastPosition = null;

        return {
            valid: true,
            data: {
                ...data,
                strokeId,
                validated: true
            }
        };
    }

    /**
     * Process clear canvas event
     */
    processClearCanvas(userId, data) {
        // Clear all drawing data
        this.activeStrokes.clear();
        this.drawingActions.length = 0;

        // Reset all user drawing states
        for (const [uId, drawingState] of this.drawingStates.entries()) {
            drawingState.isDrawing = false;
            drawingState.currentStroke = null;
            drawingState.lastPosition = null;
        }

        logger.info('Canvas cleared by user', { userId });

        return {
            valid: true,
            data: {
                ...data,
                validated: true
            }
        };
    }

    /**
     * Force end a stroke (cleanup)
     */
    forceEndStroke(userId, drawingState) {
        if (drawingState.currentStroke) {
            const stroke = this.activeStrokes.get(drawingState.currentStroke);
            if (stroke) {
                stroke.endTime = Date.now();
                stroke.forcedEnd = true;
                this.activeStrokes.delete(drawingState.currentStroke);
            }
        }
        
        drawingState.isDrawing = false;
        drawingState.currentStroke = null;
        drawingState.lastPosition = null;
    }

    /**
     * Add message to buffer with deduplication
     */
    addMessage(message) {
        try {
            // Check for recent duplicates
            const recentMessages = this.messageBuffer.slice(-10);
            const isDuplicate = recentMessages.some(msg => 
                msg.userId === message.userId && 
                msg.message === message.message && 
                (Date.now() - msg.timestamp) < 2000
            );

            if (isDuplicate) {
                logger.debug('Duplicate message detected', { userId: message.userId });
                return false;
            }

            this.messageBuffer.push(message);

            // Trim buffer if too large
            if (this.messageBuffer.length > config.memory.maxMessageBuffer) {
                this.messageBuffer = this.messageBuffer.slice(-config.memory.maxMessageBuffer);
            }

            // Update user stats
            const user = this.users.get(message.userId);
            if (user) {
                user.messageCount++;
                user.lastSeen = Date.now();
            }

            this.lastActivity = Date.now();
            return true;

        } catch (error) {
            logger.error('Error adding message', { error });
            return false;
        }
    }

    /**
     * Clean up inactive users
     */
    cleanupInactiveUsers() {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [userId, user] of this.users.entries()) {
            if (now - user.lastSeen > this.sessionTimeout) {
                // Check if socket is still connected
                const socket = this.userSockets.get(userId);
                if (!socket || !socket.connected) {
                    this.leaveSession(userId, socket ? socket.id : null);
                    cleanedCount++;
                }
            }
        }

        if (cleanedCount > 0) {
            logger.info('Cleaned up inactive users', {
                cleanedCount,
                activeUsers: this.users.size
            });
        }

        this.lastCleanup = now;
    }

    /**
     * Clean up old strokes
     */
    cleanupOldStrokes() {
        const now = Date.now();
        const maxAge = config.canvas.strokeTimeout;
        let cleanedCount = 0;

        for (const [strokeId, stroke] of this.activeStrokes.entries()) {
            if (now - stroke.startTime > maxAge) {
                this.activeStrokes.delete(strokeId);
                cleanedCount++;
            }
        }

        // Trim drawing actions if too many
        if (this.drawingActions.length > config.memory.maxDrawingActions) {
            const removeCount = this.drawingActions.length - config.memory.maxDrawingActions;
            this.drawingActions = this.drawingActions.slice(removeCount);
            logger.debug('Trimmed drawing actions', { removedCount: removeCount });
        }

        if (cleanedCount > 0) {
            logger.debug('Cleaned up old strokes', {
                cleanedCount,
                activeStrokes: this.activeStrokes.size
            });
        }
    }

    /**
     * Clean up user-specific strokes
     */
    cleanupUserStrokes(userId) {
        let cleanedCount = 0;

        for (const [strokeId, stroke] of this.activeStrokes.entries()) {
            if (stroke.userId === userId) {
                this.activeStrokes.delete(strokeId);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            logger.debug('Cleaned up user strokes', { userId, cleanedCount });
        }
    }

    /**
     * Clean up message buffer
     */
    cleanupMessageBuffer() {
        const originalSize = this.messageBuffer.length;
        
        // Keep only recent messages
        const maxAge = 60 * 60 * 1000; // 1 hour
        const now = Date.now();
        
        this.messageBuffer = this.messageBuffer.filter(msg => 
            now - msg.timestamp < maxAge
        );

        if (this.messageBuffer.length < originalSize) {
            logger.debug('Cleaned up message buffer', {
                removed: originalSize - this.messageBuffer.length,
                remaining: this.messageBuffer.length
            });
        }
    }

    /**
     * Clean up anonymous browsers
     */
    cleanupAnonymousBrowsers() {
        let cleanedCount = 0;
        const socketsToRemove = [];

        for (const socket of this.anonymousBrowsers) {
            if (!socket.connected) {
                socketsToRemove.push(socket);
                cleanedCount++;
            }
        }

        socketsToRemove.forEach(socket => {
            this.anonymousBrowsers.delete(socket);
        });

        if (cleanedCount > 0) {
            logger.debug('Cleaned up disconnected anonymous browsers', {
                cleanedCount,
                activeAnonymous: this.anonymousBrowsers.size
            });
        }

        // Limit anonymous browsers to prevent memory issues
        if (this.anonymousBrowsers.size > config.memory.maxAnonymousBrowsers) {
            const excess = this.anonymousBrowsers.size - config.memory.maxAnonymousBrowsers;
            const toRemove = Array.from(this.anonymousBrowsers).slice(0, excess);
            
            toRemove.forEach(socket => {
                socket.disconnect(true);
                this.anonymousBrowsers.delete(socket);
            });

            logger.warn('Disconnected excess anonymous browsers', {
                removed: excess,
                limit: config.memory.maxAnonymousBrowsers
            });
        }
    }

    /**
     * Get session statistics
     */
    getStats() {
        return {
            users: this.users.size,
            anonymousBrowsers: this.anonymousBrowsers.size,
            activeStrokes: this.activeStrokes.size,
            drawingActions: this.drawingActions.length,
            messageBuffer: this.messageBuffer.length,
            createdAt: this.createdAt,
            lastActivity: this.lastActivity,
            lastCleanup: this.lastCleanup,
            sessionAge: Date.now() - this.createdAt,
            memoryUsage: this.estimateMemoryUsage()
        };
    }

    /**
     * Estimate memory usage
     */
    estimateMemoryUsage() {
        let totalSize = 0;
        
        // Users
        totalSize += this.users.size * 200; // Estimate per user
        
        // Active strokes
        for (const stroke of this.activeStrokes.values()) {
            totalSize += stroke.points.length * 32; // Estimate per point
        }
        
        // Messages
        totalSize += this.messageBuffer.length * 100; // Estimate per message
        
        // Drawing actions
        totalSize += this.drawingActions.length * 150; // Estimate per action
        
        return Math.round(totalSize / 1024); // Return in KB
    }

    /**
     * Graceful cleanup for shutdown
     */
    async cleanup() {
        logger.info('Session manager cleanup initiated');
        
        try {
            // Disconnect all users
            for (const [userId, socket] of this.userSockets.entries()) {
                if (socket && socket.connected) {
                    socket.disconnect(true);
                }
            }

            // Disconnect anonymous browsers
            for (const socket of this.anonymousBrowsers) {
                if (socket.connected) {
                    socket.disconnect(true);
                }
            }

            // Clear all data structures
            this.users.clear();
            this.userSockets.clear();
            this.socketUsers.clear();
            this.anonymousBrowsers.clear();
            this.drawingStates.clear();
            this.activeStrokes.clear();
            this.sequenceNumbers.clear();
            this.messageBuffer.length = 0;
            this.drawingActions.length = 0;

            logger.info('Session manager cleanup completed');

        } catch (error) {
            logger.error('Error during session manager cleanup', { error });
        }
    }
}

// Create singleton instance
const sessionManager = new SessionManager();

module.exports = sessionManager;
