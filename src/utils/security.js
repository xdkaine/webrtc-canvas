/**
 * Security utilities for input validation and protection
 * Provides comprehensive security measures against common attacks
 */

const crypto = require('crypto');
const config = require('../config/config');
const logger = require('./logger');

class SecurityValidator {
    constructor() {
        this.suspiciousPatterns = [
            /<script\b/i,
            /javascript:/i,
            /on\w+\s*=/i,
            /data:text\/html/i,
            /vbscript:/i,
            /expression\s*\(/i
        ];
        
        this.blockedUserIds = new Set();
        this.ipAttempts = new Map();
    }

    /**
     * Validate and sanitize user input
     */
    validateInput(input, type = 'text') {
        if (typeof input !== 'string') {
            return { valid: false, error: 'Input must be a string' };
        }

        // Check for suspicious patterns
        for (const pattern of this.suspiciousPatterns) {
            if (pattern.test(input)) {
                logger.logSecurityEvent('Suspicious pattern detected', {
                    pattern: pattern.toString(),
                    input: input.substring(0, 100)
                });
                return { valid: false, error: 'Invalid characters detected' };
            }
        }

        switch (type) {
            case 'nickname':
                return this.validateNickname(input);
            case 'message':
                return this.validateMessage(input);
            case 'userId':
                return this.validateUserId(input);
            default:
                return this.validateGenericText(input);
        }
    }

    validateNickname(nickname) {
        if (!nickname || nickname.trim().length === 0) {
            return { valid: false, error: 'Nickname cannot be empty' };
        }

        const trimmed = nickname.trim();
        
        if (trimmed.length > config.security.input.maxNicknameLength) {
            return { valid: false, error: 'Nickname too long' };
        }

        if (trimmed.length < 2) {
            return { valid: false, error: 'Nickname too short' };
        }

        // Check for allowed characters
        if (!config.security.input.allowedCharacters.test(trimmed)) {
            return { valid: false, error: 'Nickname contains invalid characters' };
        }

        // Check for reserved words
        const lowerNickname = trimmed.toLowerCase();
        const reservedWords = ['admin', 'administrator', 'system', 'server', 'bot', 'anonymous'];
        if (reservedWords.includes(lowerNickname)) {
            return { valid: false, error: 'Nickname is reserved' };
        }

        return { 
            valid: true, 
            sanitized: trimmed.replace(/\s+/g, ' ') // Normalize spaces
        };
    }

    validateMessage(message) {
        if (typeof message !== 'string') {
            return { valid: false, error: 'Message must be a string' };
        }

        if (message.length === 0) {
            return { valid: false, error: 'Message cannot be empty' };
        }

        if (message.length > config.security.input.maxMessageLength) {
            return { valid: false, error: 'Message too long' };
        }

        // Sanitize message
        const sanitized = message
            .replace(/[\r\n\t]/g, ' ') // Replace line breaks
            .replace(/\s+/g, ' ') // Collapse spaces
            .trim();

        if (sanitized.length === 0) {
            return { valid: false, error: 'Message cannot be empty after sanitization' };
        }

        return { valid: true, sanitized };
    }

    validateUserId(userId) {
        if (!userId || typeof userId !== 'string') {
            return { valid: false, error: 'Invalid user ID format' };
        }

        // Check if user is blocked
        if (this.blockedUserIds.has(userId)) {
            return { valid: false, error: 'User is blocked' };
        }

        // Basic format validation
        if (userId.length < 3 || userId.length > 50) {
            return { valid: false, error: 'Invalid user ID length' };
        }

        // Allow alphanumeric, hyphens, and underscores
        if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
            return { valid: false, error: 'Invalid user ID format' };
        }

        return { valid: true, sanitized: userId };
    }

    validateGenericText(text) {
        if (text.length > 1000) {
            return { valid: false, error: 'Text too long' };
        }

        return { valid: true, sanitized: text.trim() };
    }

    /**
     * Validate drawing data for security and bounds
     */
    validateDrawingData(data) {
        if (!data || typeof data !== 'object') {
            return { valid: false, error: 'Invalid drawing data format' };
        }

        const { type, normalizedX, normalizedY, color, size } = data;

        // Validate type
        const validTypes = ['startDrawing', 'draw', 'endDrawing', 'clear-canvas'];
        if (!validTypes.includes(type)) {
            return { valid: false, error: 'Invalid drawing type' };
        }

        // For drawing operations, validate coordinates
        if (type === 'startDrawing' || type === 'draw') {
            if (typeof normalizedX !== 'number' || typeof normalizedY !== 'number') {
                return { valid: false, error: 'Invalid coordinates' };
            }

            if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
                return { valid: false, error: 'Coordinates out of bounds' };
            }

            if (isNaN(normalizedX) || isNaN(normalizedY)) {
                return { valid: false, error: 'Invalid coordinate values' };
            }
        }

        // Validate color if provided
        if (color !== undefined) {
            if (typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
                return { valid: false, error: 'Invalid color format' };
            }
        }

        // Validate size if provided
        if (size !== undefined) {
            if (typeof size !== 'number' || size < 1 || size > 50) {
                return { valid: false, error: 'Invalid size value' };
            }
        }

        return { valid: true, data };
    }

    /**
     * Validate canvas state data
     */
    validateCanvasState(canvasData) {
        if (!canvasData) {
            return { valid: true, data: null };
        }

        if (typeof canvasData !== 'object') {
            return { valid: false, error: 'Invalid canvas data format' };
        }

        // Check size limits
        const dataSize = JSON.stringify(canvasData).length;
        if (dataSize > config.security.input.maxCanvasStateSize) {
            return { valid: false, error: 'Canvas data too large' };
        }

        // Validate imageData if present
        if (canvasData.imageData) {
            if (typeof canvasData.imageData !== 'string') {
                return { valid: false, error: 'Invalid image data format' };
            }

            // Basic data URL validation
            if (!canvasData.imageData.startsWith('data:image/')) {
                return { valid: false, error: 'Invalid image data format' };
            }
        }

        return { valid: true, data: canvasData };
    }

    /**
     * Block a user ID for security reasons
     */
    blockUser(userId, reason = 'Security violation') {
        this.blockedUserIds.add(userId);
        logger.logSecurityEvent('User blocked', { userId, reason });
        
        // Auto-unblock after 1 hour
        setTimeout(() => {
            this.blockedUserIds.delete(userId);
            logger.info('User auto-unblocked', { userId });
        }, 60 * 60 * 1000);
    }

    /**
     * Check if user is blocked
     */
    isUserBlocked(userId) {
        return this.blockedUserIds.has(userId);
    }

    /**
     * Generate secure session token
     */
    generateSecureToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * Hash sensitive data
     */
    hashData(data) {
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    /**
     * Track failed attempts and implement temporary blocks
     */
    trackFailedAttempt(identifier) {
        const now = Date.now();
        if (!this.ipAttempts.has(identifier)) {
            this.ipAttempts.set(identifier, { count: 0, firstAttempt: now, blocked: false });
        }

        const attempts = this.ipAttempts.get(identifier);
        attempts.count++;

        // Block after 10 attempts in 5 minutes
        if (attempts.count >= 10 && (now - attempts.firstAttempt) < 5 * 60 * 1000) {
            attempts.blocked = true;
            logger.logSecurityEvent('IP temporarily blocked', { 
                identifier, 
                attempts: attempts.count 
            });

            // Unblock after 15 minutes
            setTimeout(() => {
                this.ipAttempts.delete(identifier);
            }, 15 * 60 * 1000);
        }

        return attempts.blocked;
    }

    /**
     * Check if IP is blocked
     */
    isBlocked(identifier) {
        const attempts = this.ipAttempts.get(identifier);
        return attempts && attempts.blocked;
    }

    /**
     * Clean up old data periodically
     */
    cleanup() {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;

        for (const [identifier, data] of this.ipAttempts.entries()) {
            if (now - data.firstAttempt > oneHour) {
                this.ipAttempts.delete(identifier);
            }
        }
    }
}

// Create singleton instance
const securityValidator = new SecurityValidator();

// Cleanup old data every hour
setInterval(() => {
    securityValidator.cleanup();
}, 60 * 60 * 1000);

module.exports = securityValidator;
