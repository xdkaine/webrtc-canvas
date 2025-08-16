/**
 * Advanced rate limiting middleware with memory leak protection
 * Provides sophisticated rate limiting with automatic cleanup
 */

const config = require('../config/config');
const logger = require('../utils/logger');
const memoryManager = require('../utils/memoryManager');

class RateLimiter {
    constructor() {
        this.limits = new Map(); // Store rate limit data per client
        this.globalLimits = new Map(); // Store global rate limits
        
        // Register with memory manager
        memoryManager.registerObject('rateLimiter', this, () => this.cleanup());
        
        // Cleanup old entries every minute
        setInterval(() => this.cleanupOldEntries(), 60 * 1000);
    }

    /**
     * Create rate limiter for Socket.IO events
     */
    createSocketRateLimiter(eventType) {
        const limitConfig = config.security.rateLimiting[eventType] || config.security.rateLimiting.drawing;
        
        return (socket, next) => {
            const clientId = this.getClientId(socket);
            const allowed = this.checkLimit(clientId, eventType, limitConfig);
            
            if (!allowed) {
                logger.logSecurityEvent('Rate limit exceeded', {
                    clientId,
                    eventType,
                    socketId: socket.id
                });
                
                socket.emit('error', {
                    message: 'Rate limit exceeded',
                    type: 'RATE_LIMIT',
                    retryAfter: 1000
                });
                return;
            }
            
            next();
        };
    }

    /**
     * Create rate limiter for HTTP requests
     */
    createHttpRateLimiter(limitType = 'connection') {
        const limitConfig = config.security.rateLimiting[limitType] || {
            maxPerMinute: 60,
            windowMs: 60000
        };

        return (req, res, next) => {
            const clientId = this.getClientIdFromRequest(req);
            const allowed = this.checkLimit(clientId, limitType, limitConfig);
            
            if (!allowed) {
                logger.logSecurityEvent('HTTP rate limit exceeded', {
                    clientId,
                    limitType,
                    ip: req.ip,
                    userAgent: req.get('User-Agent')
                });
                
                res.status(429).json({
                    error: 'Rate limit exceeded',
                    retryAfter: Math.ceil(limitConfig.windowMs / 1000)
                });
                return;
            }
            
            next();
        };
    }

    /**
     * Check if request is within rate limits
     */
    checkLimit(clientId, eventType, limitConfig) {
        const now = Date.now();
        const windowMs = limitConfig.windowMs || 1000;
        const maxRequests = limitConfig.maxPerSecond || limitConfig.maxPerMinute || 60;
        const burstLimit = limitConfig.burstLimit || maxRequests * 1.5;
        
        // Get or create client limit data
        if (!this.limits.has(clientId)) {
            this.limits.set(clientId, new Map());
        }
        
        const clientLimits = this.limits.get(clientId);
        
        if (!clientLimits.has(eventType)) {
            clientLimits.set(eventType, {
                requests: [],
                burstCount: 0,
                firstRequest: now,
                blocked: false,
                blockUntil: 0
            });
        }
        
        const limitData = clientLimits.get(eventType);
        
        // Check if client is currently blocked
        if (limitData.blocked && now < limitData.blockUntil) {
            return false;
        } else if (limitData.blocked && now >= limitData.blockUntil) {
            // Unblock client
            limitData.blocked = false;
            limitData.requests = [];
            limitData.burstCount = 0;
            limitData.firstRequest = now;
        }
        
        // Clean old requests outside the window
        limitData.requests = limitData.requests.filter(requestTime => 
            now - requestTime < windowMs
        );
        
        // Check burst limit (immediate protection)
        if (limitData.burstCount >= burstLimit) {
            if (now - limitData.firstRequest < 1000) { // Within 1 second
                this.blockClient(clientId, eventType, 5000); // Block for 5 seconds
                return false;
            } else {
                // Reset burst counter
                limitData.burstCount = 0;
                limitData.firstRequest = now;
            }
        }
        
        // Check rate limit
        if (limitData.requests.length >= maxRequests) {
            // Rate limit exceeded
            this.blockClient(clientId, eventType, windowMs);
            return false;
        }
        
        // Allow request
        limitData.requests.push(now);
        limitData.burstCount++;
        
        // Update memory manager
        memoryManager.touchObject('rateLimiter');
        
        return true;
    }

    /**
     * Block a client for a specific duration
     */
    blockClient(clientId, eventType, duration) {
        const clientLimits = this.limits.get(clientId);
        if (clientLimits && clientLimits.has(eventType)) {
            const limitData = clientLimits.get(eventType);
            limitData.blocked = true;
            limitData.blockUntil = Date.now() + duration;
            
            logger.logSecurityEvent('Client temporarily blocked', {
                clientId,
                eventType,
                duration,
                requestCount: limitData.requests.length
            });
        }
    }

    /**
     * Get client ID from socket
     */
    getClientId(socket) {
        // Use a combination of IP and user agent for identification
        const ip = socket.handshake.address;
        const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
        return `${ip}_${this.hashString(userAgent)}`;
    }

    /**
     * Get client ID from HTTP request
     */
    getClientIdFromRequest(req) {
        const ip = req.ip || req.connection.remoteAddress;
        const userAgent = req.get('User-Agent') || 'unknown';
        return `${ip}_${this.hashString(userAgent)}`;
    }

    /**
     * Simple hash function for user agent
     */
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * Get rate limit status for a client
     */
    getRateLimitStatus(clientId, eventType) {
        const clientLimits = this.limits.get(clientId);
        if (!clientLimits || !clientLimits.has(eventType)) {
            return {
                remaining: config.security.rateLimiting[eventType]?.maxPerSecond || 60,
                resetTime: Date.now() + 1000,
                blocked: false
            };
        }
        
        const limitData = clientLimits.get(eventType);
        const limitConfig = config.security.rateLimiting[eventType] || { maxPerSecond: 60 };
        
        return {
            remaining: Math.max(0, limitConfig.maxPerSecond - limitData.requests.length),
            resetTime: Math.max(...limitData.requests) + (limitConfig.windowMs || 1000),
            blocked: limitData.blocked,
            blockUntil: limitData.blockUntil
        };
    }

    /**
     * Check global rate limits (across all clients)
     */
    checkGlobalLimit(eventType, limit) {
        const now = Date.now();
        const windowMs = 60 * 1000; // 1 minute window
        
        if (!this.globalLimits.has(eventType)) {
            this.globalLimits.set(eventType, []);
        }
        
        const requests = this.globalLimits.get(eventType);
        
        // Clean old requests
        const filteredRequests = requests.filter(requestTime => 
            now - requestTime < windowMs
        );
        this.globalLimits.set(eventType, filteredRequests);
        
        if (filteredRequests.length >= limit) {
            logger.logSecurityEvent('Global rate limit exceeded', {
                eventType,
                requestCount: filteredRequests.length,
                limit
            });
            return false;
        }
        
        filteredRequests.push(now);
        return true;
    }

    /**
     * Clean up old entries to prevent memory leaks
     */
    cleanupOldEntries() {
        const now = Date.now();
        const maxAge = 10 * 60 * 1000; // 10 minutes
        let cleanedClients = 0;
        let cleanedEvents = 0;
        
        for (const [clientId, clientLimits] of this.limits.entries()) {
            let hasActiveEvents = false;
            
            for (const [eventType, limitData] of clientLimits.entries()) {
                // Remove old requests
                const activeRequests = limitData.requests.filter(requestTime => 
                    now - requestTime < maxAge
                );
                
                if (activeRequests.length === 0 && !limitData.blocked) {
                    clientLimits.delete(eventType);
                    cleanedEvents++;
                } else {
                    limitData.requests = activeRequests;
                    hasActiveEvents = true;
                }
            }
            
            if (!hasActiveEvents) {
                this.limits.delete(clientId);
                cleanedClients++;
            }
        }
        
        // Clean global limits
        for (const [eventType, requests] of this.globalLimits.entries()) {
            const activeRequests = requests.filter(requestTime => 
                now - requestTime < maxAge
            );
            
            if (activeRequests.length === 0) {
                this.globalLimits.delete(eventType);
            } else {
                this.globalLimits.set(eventType, activeRequests);
            }
        }
        
        if (cleanedClients > 0 || cleanedEvents > 0) {
            logger.debug('Rate limiter cleanup completed', {
                cleanedClients,
                cleanedEvents,
                activeClients: this.limits.size,
                totalMemoryMB: Math.round(this.getMemoryUsage() / 1024 / 1024)
            });
        }
    }

    /**
     * Estimate memory usage of rate limiter
     */
    getMemoryUsage() {
        let totalSize = 0;
        
        for (const [clientId, clientLimits] of this.limits.entries()) {
            totalSize += clientId.length * 2; // String size
            for (const [eventType, limitData] of clientLimits.entries()) {
                totalSize += eventType.length * 2;
                totalSize += limitData.requests.length * 8; // Array of numbers
                totalSize += 64; // Object overhead
            }
        }
        
        for (const [eventType, requests] of this.globalLimits.entries()) {
            totalSize += eventType.length * 2;
            totalSize += requests.length * 8;
        }
        
        return totalSize;
    }

    /**
     * Get statistics about rate limiting
     */
    getStats() {
        const stats = {
            totalClients: this.limits.size,
            totalGlobalLimits: this.globalLimits.size,
            memoryUsageBytes: this.getMemoryUsage(),
            clientBreakdown: {}
        };
        
        for (const [clientId, clientLimits] of this.limits.entries()) {
            stats.clientBreakdown[clientId] = {
                eventTypes: clientLimits.size,
                totalRequests: Array.from(clientLimits.values())
                    .reduce((total, limitData) => total + limitData.requests.length, 0)
            };
        }
        
        return stats;
    }

    /**
     * Manual cleanup for graceful shutdown
     */
    cleanup() {
        logger.info('Rate limiter cleanup initiated');
        
        this.limits.clear();
        this.globalLimits.clear();
        
        logger.info('Rate limiter cleanup completed');
    }
}

// Create singleton instance
const rateLimiter = new RateLimiter();

module.exports = rateLimiter;
