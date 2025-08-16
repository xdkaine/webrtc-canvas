/**
 * HTTP routes controller with security and performance optimizations
 * Provides secure API endpoints with rate limiting and proper error handling
 */

const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');
const memoryManager = require('../utils/memoryManager');
const rateLimiter = require('../middleware/rateLimiter');
const sessionManager = require('../services/sessionManager');
const canvasPersistence = require('../services/canvasPersistence');

class RouteController {
    constructor() {
        this.requestCount = 0;
        this.errorCount = 0;
        this.startTime = Date.now();
        
        // Register with memory manager
        memoryManager.registerObject('routeController', this, () => this.cleanup());
        
        logger.info('Route controller initialized');
    }

    /**
     * Set up routes with middleware
     */
    setupRoutes(app) {
        // Apply rate limiting to API routes
        app.use('/api', rateLimiter.createHttpRateLimiter('connection'));
        
        // Request logging middleware
        app.use((req, res, next) => {
            this.requestCount++;
            const start = Date.now();
            
            res.on('finish', () => {
                const duration = Date.now() - start;
                logger.debug('HTTP request', {
                    method: req.method,
                    url: req.url,
                    statusCode: res.statusCode,
                    duration,
                    ip: req.ip,
                    userAgent: req.get('User-Agent')
                });
            });
            
            next();
        });

        // Error handling middleware
        app.use((err, req, res, next) => {
            this.errorCount++;
            logger.error('HTTP error', {
                error: err.message,
                stack: err.stack,
                url: req.url,
                method: req.method,
                ip: req.ip
            });
            
            res.status(500).json({
                error: 'Internal server error',
                timestamp: new Date().toISOString()
            });
        });

        // Health check endpoint
        app.get('/health', this.handleHealthCheck.bind(this));
        
        // Metrics endpoint
        app.get('/api/metrics', this.handleMetrics.bind(this));
        
        // Session info endpoint
        app.get('/api/session-info', this.handleSessionInfo.bind(this));
        
        // Canvas state endpoint
        app.get('/api/canvas-state', this.handleCanvasStateApi.bind(this));
        
        // System status endpoint
        app.get('/api/status', this.handleSystemStatus.bind(this));
        
        // Memory stats endpoint (debug)
        if (!config.server.isProduction) {
            app.get('/api/debug/memory', this.handleMemoryDebug.bind(this));
        }

        // Static file routes
        this.setupStaticRoutes(app);
        
        // Catch-all route
        app.get('*', this.handleCatchAll.bind(this));

        logger.info('Routes configured successfully');
    }

    /**
     * Set up static file routes
     */
    setupStaticRoutes(app) {
        const publicPath = path.join(process.cwd(), 'public');
        
        // SEO and PWA routes
        app.get('/robots.txt', (req, res) => {
            res.type('text/plain');
            res.sendFile(path.join(publicPath, 'robots.txt'), (err) => {
                if (err) {
                    res.status(404).send('Not found');
                }
            });
        });

        app.get('/sitemap.xml', (req, res) => {
            res.type('application/xml');
            res.sendFile(path.join(publicPath, 'sitemap.xml'), (err) => {
                if (err) {
                    res.status(404).send('Not found');
                }
            });
        });

        app.get('/site.webmanifest', (req, res) => {
            res.type('application/manifest+json');
            res.sendFile(path.join(publicPath, 'site.webmanifest'), (err) => {
                if (err) {
                    res.status(404).send('Not found');
                }
            });
        });

        // Favicon
        app.get('/favicon.ico', (req, res) => {
            res.sendFile(path.join(publicPath, 'favicon.ico'), (err) => {
                if (err) {
                    res.status(204).end(); // No content
                }
            });
        });
    }

    /**
     * Health check endpoint
     */
    handleHealthCheck(req, res) {
        try {
            const memUsage = process.memoryUsage();
            const uptime = process.uptime();
            
            const healthData = {
                status: 'OK',
                timestamp: new Date().toISOString(),
                uptime: Math.round(uptime),
                version: process.version,
                platform: process.platform,
                memory: {
                    rss: Math.round(memUsage.rss / 1024 / 1024),
                    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                    external: Math.round(memUsage.external / 1024 / 1024)
                },
                connections: {
                    total: sessionManager.users.size,
                    anonymous: sessionManager.anonymousBrowsers.size
                }
            };

            // Check if memory usage is concerning
            const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
            if (heapUsedMB > config.memory.maxMemoryUsageMB * 0.9) {
                healthData.status = 'WARNING';
                healthData.warning = 'High memory usage';
            }

            res.json(healthData);
            
        } catch (error) {
            logger.error('Error in health check', { error });
            res.status(500).json({
                status: 'ERROR',
                error: 'Health check failed'
            });
        }
    }

    /**
     * Metrics endpoint
     */
    handleMetrics(req, res) {
        try {
            const sessionStats = sessionManager.getStats();
            const memoryStats = memoryManager.getMemoryStats();
            const canvasStats = canvasPersistence.getStats();
            
            const metrics = {
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                session: sessionStats,
                memory: memoryStats,
                canvas: canvasStats,
                http: {
                    requests: this.requestCount,
                    errors: this.errorCount,
                    requestsPerMinute: this.calculateRequestsPerMinute()
                },
                system: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    cpuUsage: process.cpuUsage(),
                    pid: process.pid
                }
            };

            res.json(metrics);
            
        } catch (error) {
            logger.error('Error getting metrics', { error });
            res.status(500).json({
                error: 'Failed to get metrics'
            });
        }
    }

    /**
     * Session info endpoint
     */
    handleSessionInfo(req, res) {
        try {
            const users = Array.from(sessionManager.users.values()).map(user => ({
                userId: user.userId,
                nickname: user.nickname,
                joinedAt: user.joinedAt,
                messageCount: user.messageCount || 0,
                drawingCount: user.drawingCount || 0
            }));

            const sessionInfo = {
                userCount: sessionManager.users.size,
                anonymousCount: sessionManager.anonymousBrowsers.size,
                users,
                createdAt: sessionManager.createdAt,
                lastActivity: sessionManager.lastActivity,
                messageCount: sessionManager.messageBuffer.length,
                activeStrokes: sessionManager.activeStrokes.size
            };

            res.json(sessionInfo);
            
        } catch (error) {
            logger.error('Error getting session info', { error });
            res.status(500).json({
                error: 'Failed to get session info'
            });
        }
    }

    /**
     * Canvas state API endpoint
     */
    async handleCanvasStateApi(req, res) {
        try {
            const canvasState = await canvasPersistence.loadCanvasState('main');
            
            if (canvasState) {
                // Remove image data for API response (too large)
                const apiResponse = {
                    hasData: true,
                    metadata: canvasState.metadata || {},
                    timestamp: canvasState.timestamp || Date.now()
                };
                
                res.json(apiResponse);
            } else {
                res.json({
                    hasData: false,
                    timestamp: Date.now()
                });
            }
            
        } catch (error) {
            logger.error('Error getting canvas state', { error });
            res.status(500).json({
                error: 'Failed to get canvas state'
            });
        }
    }

    /**
     * System status endpoint
     */
    handleSystemStatus(req, res) {
        try {
            const memoryThreshold = memoryManager.getMemoryThresholdLevel(
                process.memoryUsage().heapUsed / 1024 / 1024
            );
            
            const status = {
                timestamp: new Date().toISOString(),
                environment: config.server.environment,
                status: memoryThreshold === 'emergency' ? 'CRITICAL' : 
                       memoryThreshold === 'critical' ? 'WARNING' : 'OK',
                memory: {
                    threshold: memoryThreshold,
                    usage: process.memoryUsage()
                },
                connections: {
                    active: sessionManager.users.size,
                    anonymous: sessionManager.anonymousBrowsers.size,
                    total: sessionManager.users.size + sessionManager.anonymousBrowsers.size
                },
                performance: {
                    uptime: process.uptime(),
                    requestCount: this.requestCount,
                    errorCount: this.errorCount,
                    errorRate: this.errorCount / Math.max(this.requestCount, 1)
                }
            };

            res.json(status);
            
        } catch (error) {
            logger.error('Error getting system status', { error });
            res.status(500).json({
                error: 'Failed to get system status'
            });
        }
    }

    /**
     * Memory debug endpoint (development only)
     */
    handleMemoryDebug(req, res) {
        try {
            if (config.server.isProduction) {
                return res.status(403).json({ error: 'Not available in production' });
            }

            const memoryStats = memoryManager.getMemoryStats();
            const sessionStats = sessionManager.getStats();
            const canvasStats = canvasPersistence.getStats();
            
            // Force garbage collection if available
            if (global.gc) {
                const before = process.memoryUsage();
                global.gc();
                const after = process.memoryUsage();
                
                memoryStats.garbageCollection = {
                    before: before,
                    after: after,
                    freed: before.heapUsed - after.heapUsed
                };
            }

            const debugInfo = {
                timestamp: new Date().toISOString(),
                memory: memoryStats,
                session: sessionStats,
                canvas: canvasStats,
                managedObjects: memoryManager.managedObjects.size,
                rateLimiter: rateLimiter.getStats()
            };

            res.json(debugInfo);
            
        } catch (error) {
            logger.error('Error in memory debug', { error });
            res.status(500).json({
                error: 'Failed to get debug info'
            });
        }
    }

    /**
     * Catch-all route handler
     */
    handleCatchAll(req, res) {
        try {
            // Serve the main page for SPA routing
            const publicPath = path.join(process.cwd(), 'public');
            res.sendFile(path.join(publicPath, 'index.html'), (err) => {
                if (err) {
                    logger.warn('Failed to serve index.html', {
                        url: req.url,
                        error: err.message
                    });
                    res.status(404).json({
                        error: 'Page not found'
                    });
                }
            });
            
        } catch (error) {
            logger.error('Error in catch-all handler', { error });
            res.status(500).json({
                error: 'Server error'
            });
        }
    }

    /**
     * Calculate requests per minute
     */
    calculateRequestsPerMinute() {
        const uptimeMinutes = (Date.now() - this.startTime) / 60000;
        return Math.round(this.requestCount / Math.max(uptimeMinutes, 1));
    }

    /**
     * Get route statistics
     */
    getStats() {
        return {
            requests: this.requestCount,
            errors: this.errorCount,
            errorRate: this.errorCount / Math.max(this.requestCount, 1),
            requestsPerMinute: this.calculateRequestsPerMinute(),
            uptime: Date.now() - this.startTime
        };
    }

    /**
     * Graceful cleanup for shutdown
     */
    cleanup() {
        logger.info('Route controller cleanup completed');
    }
}

// Create singleton instance
const routeController = new RouteController();

module.exports = routeController;
