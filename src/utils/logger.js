/**
 * Enhanced logging utility with performance monitoring
 * Provides structured logging with memory leak detection
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');

class Logger {
    constructor() {
        this.levels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3
        };
        
        this.currentLevel = this.levels[config.logging.level] || this.levels.info;
        this.logQueue = [];
        this.isWriting = false;
        this.metricsBuffer = [];
        
        // Performance monitoring
        this.performanceMetrics = {
            memoryUsage: [],
            connectionCount: 0,
            errorCount: 0,
            lastCleanup: Date.now()
        };
        
        this.initializeLogDirectory();
        this.startPerformanceMonitoring();
    }

    async initializeLogDirectory() {
        if (config.logging.enableFile) {
            try {
                await fs.mkdir(config.logging.logDir, { recursive: true });
            } catch (error) {
                console.error('Failed to create log directory:', error);
            }
        }
    }

    startPerformanceMonitoring() {
        setInterval(() => {
            this.collectMetrics();
            this.checkMemoryUsage();
        }, 60000); // Every minute
    }

    collectMetrics() {
        const memUsage = process.memoryUsage();
        this.performanceMetrics.memoryUsage.push({
            timestamp: Date.now(),
            rss: memUsage.rss,
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external
        });

        // Keep only last 60 measurements (1 hour)
        if (this.performanceMetrics.memoryUsage.length > 60) {
            this.performanceMetrics.memoryUsage = this.performanceMetrics.memoryUsage.slice(-60);
        }
    }

    checkMemoryUsage() {
        const memUsage = process.memoryUsage();
        const memoryMB = memUsage.heapUsed / 1024 / 1024;
        
        if (memoryMB > config.memory.maxMemoryUsageMB * 0.9) {
            this.warn('High memory usage detected', {
                currentMB: Math.round(memoryMB),
                limitMB: config.memory.maxMemoryUsageMB,
                percentage: Math.round((memoryMB / config.memory.maxMemoryUsageMB) * 100)
            });
            
            // Trigger garbage collection if available
            if (global.gc) {
                global.gc();
                this.info('Garbage collection triggered');
            }
        }
    }

    formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            message,
            ...meta,
            pid: process.pid
        };

        if (meta.error && meta.error instanceof Error) {
            logEntry.error = {
                message: meta.error.message,
                stack: meta.error.stack,
                name: meta.error.name
            };
            delete logEntry.error; // Don't duplicate
        }

        return logEntry;
    }

    async writeToFile(logEntry) {
        if (!config.logging.enableFile) return;

        const logLine = JSON.stringify(logEntry) + '\n';
        const logFile = path.join(config.logging.logDir, `app-${new Date().toISOString().split('T')[0]}.log`);
        
        this.logQueue.push({ file: logFile, content: logLine });
        
        if (!this.isWriting) {
            this.processLogQueue();
        }
    }

    async processLogQueue() {
        if (this.logQueue.length === 0) return;
        
        this.isWriting = true;
        
        try {
            const batch = this.logQueue.splice(0, 100); // Process in batches
            const fileGroups = {};
            
            // Group by file
            batch.forEach(entry => {
                if (!fileGroups[entry.file]) {
                    fileGroups[entry.file] = [];
                }
                fileGroups[entry.file].push(entry.content);
            });
            
            // Write to files
            await Promise.all(
                Object.entries(fileGroups).map(async ([file, contents]) => {
                    try {
                        await fs.appendFile(file, contents.join(''));
                    } catch (error) {
                        console.error('Failed to write to log file:', error);
                    }
                })
            );
            
            // Continue processing if more logs are queued
            if (this.logQueue.length > 0) {
                setImmediate(() => this.processLogQueue());
            } else {
                this.isWriting = false;
            }
        } catch (error) {
            console.error('Error processing log queue:', error);
            this.isWriting = false;
        }
    }

    log(level, message, meta = {}) {
        if (this.levels[level] > this.currentLevel) return;

        const logEntry = this.formatMessage(level, message, meta);
        
        // Console output
        if (config.logging.enableConsole) {
            const consoleMessage = `[${logEntry.timestamp}] ${logEntry.level}: ${message}`;
            
            switch (level) {
                case 'error':
                    console.error(consoleMessage, meta);
                    this.performanceMetrics.errorCount++;
                    break;
                case 'warn':
                    console.warn(consoleMessage, meta);
                    break;
                case 'info':
                    console.info(consoleMessage, meta);
                    break;
                case 'debug':
                    console.debug(consoleMessage, meta);
                    break;
            }
        }
        
        // File output (async)
        this.writeToFile(logEntry);
    }

    error(message, meta = {}) {
        this.log('error', message, meta);
    }

    warn(message, meta = {}) {
        this.log('warn', message, meta);
    }

    info(message, meta = {}) {
        this.log('info', message, meta);
    }

    debug(message, meta = {}) {
        this.log('debug', message, meta);
    }

    // Performance logging methods
    logConnection(action, socketId, userId = null) {
        if (action === 'connect') {
            this.performanceMetrics.connectionCount++;
        } else if (action === 'disconnect') {
            this.performanceMetrics.connectionCount--;
        }
        
        this.debug(`Connection ${action}`, {
            socketId,
            userId,
            totalConnections: this.performanceMetrics.connectionCount
        });
    }

    logDrawingAction(userId, action, metadata = {}) {
        this.debug('Drawing action', {
            userId,
            action,
            ...metadata
        });
    }

    logMemoryLeak(source, details = {}) {
        this.warn('Potential memory leak detected', {
            source,
            memoryUsage: process.memoryUsage(),
            ...details
        });
    }

    logSecurityEvent(event, details = {}) {
        this.warn('Security event', {
            event,
            timestamp: Date.now(),
            ...details
        });
    }

    getMetrics() {
        return {
            ...this.performanceMetrics,
            currentMemory: process.memoryUsage(),
            uptime: process.uptime(),
            logQueueSize: this.logQueue.length
        };
    }

    // Cleanup method for graceful shutdown
    async cleanup() {
        this.info('Logger cleanup initiated');
        
        // Process remaining logs
        while (this.logQueue.length > 0 && this.isWriting) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (this.logQueue.length > 0) {
            await this.processLogQueue();
        }
        
        this.info('Logger cleanup completed');
    }
}

// Create singleton instance
const logger = new Logger();

module.exports = logger;
