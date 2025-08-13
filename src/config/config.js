/**
 * Configuration management with environment-based settings
 * Provides secure defaults and proper validation
 */

const path = require('path');

const config = {
    // Server Configuration
    server: {
        port: process.env.PORT || 3003,
        host: process.env.HOST || '0.0.0.0',
        environment: process.env.NODE_ENV || 'development',
        isProduction: process.env.NODE_ENV === 'production',
        isVercel: !!process.env.VERCEL
    },

    // Socket.IO Configuration
    socketIO: {
        cors: {
            origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ["http://localhost:3003"],
            methods: ["GET", "POST"],
            credentials: false
        },
        transports: ['websocket', 'polling'],
        upgradeTimeout: 30000,
        pingTimeout: 60000,
        pingInterval: 25000,
        maxHttpBufferSize: 1024 * 1024, // 1MB max message size
        compression: true,
        allowEIO3: true,
        connectTimeout: 45000
    },

    // Security Configuration
    security: {
        rateLimiting: {
            drawing: {
                maxPerSecond: 120,
                burstLimit: 150,
                windowMs: 1000
            },
            chat: {
                maxPerSecond: 5,
                burstLimit: 10,
                windowMs: 1000
            },
            signaling: {
                maxPerSecond: 30,
                burstLimit: 40,
                windowMs: 1000
            },
            connection: {
                maxPerMinute: 60,
                windowMs: 60000
            }
        },
        input: {
            maxNicknameLength: 20,
            maxMessageLength: 300,
            maxCanvasStateSize: 5 * 1024 * 1024, // 5MB
            allowedCharacters: /^[a-zA-Z0-9\s\-_.,!?]+$/
        },
        sessions: {
            maxUsersPerSession: 50,
            sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
            cleanupIntervalMs: 5 * 60 * 1000 // 5 minutes
        }
    },

    // Memory Management
    memory: {
        maxActiveStrokes: 1000,
        maxDrawingActions: 2000,
        maxMessageBuffer: 100,
        maxAnonymousBrowsers: 200,
        cleanupIntervalMs: 10 * 60 * 1000, // 10 minutes
        memoryCheckIntervalMs: 5 * 60 * 1000, // 5 minutes
        maxMemoryUsageMB: 512
    },

    // File System Configuration
    persistence: {
        dataDir: path.join(process.cwd(), 'canvas-data'),
        roomDataDir: path.join(process.cwd(), 'room-data'),
        uploadsDir: path.join(process.cwd(), 'uploads'),
        backupIntervalMs: 30 * 60 * 1000, // 30 minutes
        maxBackups: 10,
        compressionLevel: 6
    },

    // Logging Configuration
    logging: {
        level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        enableConsole: true,
        enableFile: process.env.ENABLE_FILE_LOGGING === 'true',
        logDir: path.join(process.cwd(), 'logs'),
        maxLogSize: 10 * 1024 * 1024, // 10MB
        maxLogFiles: 5
    },

    // Canvas Configuration
    canvas: {
        maxDrawingDistance: 0.2, // Maximum normalized distance between points
        strokeTimeout: 30000, // 30 seconds
        maxStrokePoints: 10000,
        compressionThreshold: 1024 * 1024 // 1MB
    },

    // Performance Tuning
    performance: {
        enableGzip: true,
        jsonParseLimit: '10mb',
        broadcastBatchSize: 50,
        eventThrottleMs: 16, // ~60fps
        enableMetrics: true
    }
};

// Validation functions
const validateConfig = () => {
    const errors = [];

    // Validate port
    if (isNaN(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
        errors.push('Invalid port number');
    }

    // Validate memory limits
    if (config.memory.maxMemoryUsageMB < 128) {
        errors.push('Memory limit too low (minimum 128MB)');
    }

    // Validate rate limiting
    Object.keys(config.security.rateLimiting).forEach(key => {
        const limit = config.security.rateLimiting[key];
        if (limit.maxPerSecond <= 0 || limit.burstLimit <= 0) {
            errors.push(`Invalid rate limit for ${key}`);
        }
    });

    if (errors.length > 0) {
        throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
    }
};

// Apply environment-specific overrides
if (config.server.isProduction) {
    // Production optimizations
    config.logging.level = 'warn';
    config.security.rateLimiting.drawing.maxPerSecond = 100;
    config.memory.cleanupIntervalMs = 5 * 60 * 1000; // More frequent cleanup
}

if (config.server.isVercel) {
    // Vercel-specific configurations
    config.persistence.dataDir = '/tmp/canvas-data';
    config.persistence.roomDataDir = '/tmp/room-data';
    config.logging.enableFile = false;
}

// Validate configuration on load
validateConfig();

module.exports = config;
