/**
 * Refactored WebRTC Canvas Server
 * Optimized for memory management, security, and performance
 * 
 * Features:
 * - Memory leak prevention with automatic cleanup
 * - Advanced rate limiting and security measures
 * - Comprehensive logging and monitoring
 * - Modular architecture for maintainability
 * - Graceful shutdown handling
 * - Performance optimizations
 */

const express = require('express');
const http = require('http');
const path = require('path');
const compression = require('compression');

// Import our modules
const config = require('./src/config/config');
const logger = require('./src/utils/logger');
const memoryManager = require('./src/utils/memoryManager');
const securityValidator = require('./src/utils/security');
const socketController = require('./src/controllers/socketController');
const routeController = require('./src/controllers/routeController');
const canvasPersistence = require('./src/services/canvasPersistence');
const sessionManager = require('./src/services/sessionManager');

class WebRTCCanvasServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = null;
        this.isShuttingDown = false;
        this.startTime = Date.now();
        
        logger.info('WebRTC Canvas Server initializing', {
            environment: config.server.environment,
            nodeVersion: process.version,
            platform: process.platform
        });
    }

    /**
     * Initialize the server
     */
    async initialize() {
        try {
            // Set up graceful shutdown handling
            this.setupGracefulShutdown();
            
            // Set up process monitoring
            this.setupProcessMonitoring();
            
            // Configure Express middleware
            this.configureMiddleware();
            
            // Initialize Socket.IO
            this.io = socketController.initializeSocket(this.server);
            
            // Set up routes
            routeController.setupRoutes(this.app);
            
            // Initialize services
            await this.initializeServices();
            
            logger.info('Server initialization completed');
            
        } catch (error) {
            logger.error('Failed to initialize server', { error });
            throw error;
        }
    }

    /**
     * Configure Express middleware
     */
    configureMiddleware() {
        // Trust proxy for accurate client IPs
        this.app.set('trust proxy', true);
        
        // Enable compression
        if (config.performance.enableGzip) {
            this.app.use(compression({
                level: 6,
                threshold: 1024, // Only compress if larger than 1KB
                filter: (req, res) => {
                    if (req.headers['x-no-compression']) {
                        return false;
                    }
                    return compression.filter(req, res);
                }
            }));
        }

        // JSON parsing with size limits
        this.app.use(express.json({ 
            limit: config.performance.jsonParseLimit,
            strict: true
        }));

        // URL encoding
        this.app.use(express.urlencoded({ 
            extended: true, 
            limit: '1mb' 
        }));

        // Security headers
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
            
            if (config.server.isProduction) {
                res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            }
            
            next();
        });

        // Serve static files with caching
        this.app.use(express.static(path.join(process.cwd(), 'public'), {
            maxAge: config.server.isProduction ? '1d' : '0',
            etag: true,
            lastModified: true
        }));

        logger.info('Express middleware configured');
    }

    /**
     * Initialize services
     */
    async initializeServices() {
        try {
            // Load existing canvas state
            await canvasPersistence.loadCanvasState('main');
            
            // Set up memory monitoring events
            memoryManager.on('emergencyMemory', this.handleEmergencyMemory.bind(this));
            memoryManager.on('memoryStatus', this.handleMemoryStatus.bind(this));
            
            // Set up session manager events
            sessionManager.on('userJoined', this.handleUserJoined.bind(this));
            sessionManager.on('userLeft', this.handleUserLeft.bind(this));
            
            logger.info('Services initialized successfully');
            
        } catch (error) {
            logger.error('Failed to initialize services', { error });
            throw error;
        }
    }

    /**
     * Set up process monitoring
     */
    setupProcessMonitoring() {
        // Monitor uncaught exceptions
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught exception', { 
                error: error.message,
                stack: error.stack
            });
            
            // Don't exit immediately, try to cleanup first
            this.gracefulShutdown('uncaughtException');
        });

        // Monitor unhandled promise rejections
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled promise rejection', { 
                reason: reason.toString(),
                promise: promise.toString()
            });
        });

        // Monitor memory warnings
        process.on('warning', (warning) => {
            logger.warn('Process warning', {
                name: warning.name,
                message: warning.message,
                stack: warning.stack
            });
        });

        // Log process events
        process.on('exit', (code) => {
            console.log(`Process exiting with code: ${code}`);
        });

        logger.info('Process monitoring configured');
    }

    /**
     * Set up graceful shutdown handling
     */
    setupGracefulShutdown() {
        const signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
        
        signals.forEach(signal => {
            process.on(signal, () => {
                logger.info(`Received ${signal}, initiating graceful shutdown`);
                this.gracefulShutdown(signal);
            });
        });
    }

    /**
     * Handle memory status updates
     */
    handleMemoryStatus(status) {
        if (status.threshold === 'critical' || status.threshold === 'emergency') {
            logger.warn('Memory threshold reached', status);
            
            // Trigger aggressive cleanup in session manager
            sessionManager.cleanupInactiveUsers();
            sessionManager.cleanupOldStrokes();
        }
    }

    /**
     * Handle emergency memory situations
     */
    handleEmergencyMemory(data) {
        logger.error('Emergency memory situation detected', data);
        
        // Emergency cleanup procedures
        sessionManager.cleanupInactiveUsers();
        sessionManager.cleanupOldStrokes();
        sessionManager.cleanupMessageBuffer();
        sessionManager.cleanupAnonymousBrowsers();
        
        // If memory is still critical, start disconnecting anonymous browsers
        setTimeout(() => {
            const currentMemory = process.memoryUsage().heapUsed / 1024 / 1024;
            if (currentMemory > config.memory.maxMemoryUsageMB * 0.9) {
                logger.warn('Disconnecting anonymous browsers due to memory pressure');
                
                let disconnected = 0;
                for (const socket of sessionManager.anonymousBrowsers) {
                    socket.disconnect(true);
                    disconnected++;
                    if (disconnected >= 20) break; // Disconnect in batches
                }
            }
        }, 1000);
    }

    /**
     * Handle user joined events
     */
    handleUserJoined(data) {
        logger.info('User joined session', {
            userId: data.userId,
            nickname: data.nickname,
            totalUsers: data.userCount
        });
    }

    /**
     * Handle user left events
     */
    handleUserLeft(data) {
        logger.info('User left session', {
            userId: data.userId,
            nickname: data.nickname,
            remainingUsers: data.userCount
        });
    }

    /**
     * Start the server
     */
    async start() {
        try {
            if (!config.server.isVercel) {
                this.server.listen(config.server.port, config.server.host, () => {
                    const elapsed = Date.now() - this.startTime;
                    
                    logger.info('🎨 WebRTC Canvas Server started successfully', {
                        port: config.server.port,
                        host: config.server.host,
                        environment: config.server.environment,
                        startupTime: `${elapsed}ms`,
                        urls: [
                            `http://localhost:${config.server.port}`,
                            `http://${config.server.host}:${config.server.port}`
                        ]
                    });
                    
                    console.log('\n🌐 Server URLs:');
                    console.log(`   Local:   http://localhost:${config.server.port}`);
                    console.log(`   Network: http://${config.server.host}:${config.server.port}`);
                    console.log('\n📱 Open the same URL on multiple devices/tabs to test collaboration');
                    console.log('🚀 WebSocket support enabled for real-time communication');
                    console.log('🔒 Security features enabled');
                    console.log('📊 Memory management active');
                    console.log('');
                });
            } else {
                logger.info('Server initialized for Vercel deployment');
            }
            
        } catch (error) {
            logger.error('Failed to start server', { error });
            throw error;
        }
    }

    /**
     * Graceful shutdown
     */
    async gracefulShutdown(reason) {
        if (this.isShuttingDown) {
            logger.warn('Shutdown already in progress');
            return;
        }
        
        this.isShuttingDown = true;
        
        logger.info('Starting graceful shutdown', { reason });
        
        try {
            // Set shutdown timeout
            const shutdownTimeout = setTimeout(() => {
                logger.error('Shutdown timeout reached, forcing exit');
                process.exit(1);
            }, 30000); // 30 seconds timeout

            // Stop accepting new connections
            this.server.close(() => {
                logger.info('HTTP server closed');
            });

            // Cleanup services in order
            await Promise.all([
                socketController.cleanup(),
                sessionManager.cleanup(),
                canvasPersistence.cleanup(),
                memoryManager.cleanup(),
                logger.cleanup()
            ]);

            clearTimeout(shutdownTimeout);
            
            logger.info('Graceful shutdown completed');
            process.exit(0);
            
        } catch (error) {
            logger.error('Error during graceful shutdown', { error });
            process.exit(1);
        }
    }

    /**
     * Get server statistics
     */
    getStats() {
        return {
            uptime: Date.now() - this.startTime,
            environment: config.server.environment,
            memory: process.memoryUsage(),
            connections: this.io ? this.io.engine.clientsCount : 0,
            routes: routeController.getStats(),
            sockets: socketController.getStats(),
            session: sessionManager.getStats(),
            canvas: canvasPersistence.getStats()
        };
    }
}

// Create and start server
async function main() {
    try {
        const server = new WebRTCCanvasServer();
        await server.initialize();
        await server.start();
        
        // Export for Vercel
        if (config.server.isVercel) {
            module.exports = server.server;
        }
        
    } catch (error) {
        logger.error('Failed to start server', { error });
        process.exit(1);
    }
}

// Start server if not in Vercel environment or if directly executed
if (!config.server.isVercel || require.main === module) {
    main().catch(error => {
        console.error('Failed to start server:', error);
        process.exit(1);
    });
}

// Export for Vercel
if (config.server.isVercel) {
    // For Vercel, we need to export the app directly
    const server = new WebRTCCanvasServer();
    server.initialize().then(() => {
        module.exports = server.app;
    }).catch(error => {
        console.error('Failed to initialize for Vercel:', error);
        process.exit(1);
    });
} else {
    module.exports = main;
}
