/**
 * Memory management utility with leak detection and automatic cleanup
 * Provides comprehensive memory monitoring and garbage collection
 */

const EventEmitter = require('events');
const config = require('../config/config');
const logger = require('./logger');

class MemoryManager extends EventEmitter {
    constructor() {
        super();
        
        this.memoryThresholds = {
            warning: config.memory.maxMemoryUsageMB * 0.8, // 80% threshold
            critical: config.memory.maxMemoryUsageMB * 0.9, // 90% threshold
            emergency: config.memory.maxMemoryUsageMB * 0.95 // 95% threshold
        };
        
        this.managedObjects = new Map();
        this.cleanupCallbacks = new Map();
        this.isCleanupRunning = false;
        this.lastGCTime = Date.now();
        this.memoryHistory = [];
        
        this.startMonitoring();
        this.schedulePeriodicCleanup();
    }

    /**
     * Start memory monitoring
     */
    startMonitoring() {
        setInterval(() => {
            this.checkMemoryUsage();
        }, config.memory.memoryCheckIntervalMs);
    }

    /**
     * Schedule periodic cleanup
     */
    schedulePeriodicCleanup() {
        setInterval(() => {
            if (!this.isCleanupRunning) {
                this.performPeriodicCleanup();
            }
        }, config.memory.cleanupIntervalMs);
    }

    /**
     * Check current memory usage and trigger actions if needed
     */
    checkMemoryUsage() {
        const memUsage = process.memoryUsage();
        const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
        const rssUsedMB = memUsage.rss / 1024 / 1024;
        
        // Store memory history
        this.memoryHistory.push({
            timestamp: Date.now(),
            heapUsed: heapUsedMB,
            rss: rssUsedMB,
            external: memUsage.external / 1024 / 1024
        });
        
        // Keep only last 100 measurements
        if (this.memoryHistory.length > 100) {
            this.memoryHistory = this.memoryHistory.slice(-100);
        }
        
        // Check thresholds
        if (heapUsedMB > this.memoryThresholds.emergency) {
            this.handleEmergencyMemory(heapUsedMB);
        } else if (heapUsedMB > this.memoryThresholds.critical) {
            this.handleCriticalMemory(heapUsedMB);
        } else if (heapUsedMB > this.memoryThresholds.warning) {
            this.handleWarningMemory(heapUsedMB);
        }
        
        // Emit memory status event
        this.emit('memoryStatus', {
            heapUsed: heapUsedMB,
            rss: rssUsedMB,
            threshold: this.getMemoryThresholdLevel(heapUsedMB)
        });
    }

    /**
     * Get current memory threshold level
     */
    getMemoryThresholdLevel(heapUsedMB) {
        if (heapUsedMB > this.memoryThresholds.emergency) return 'emergency';
        if (heapUsedMB > this.memoryThresholds.critical) return 'critical';
        if (heapUsedMB > this.memoryThresholds.warning) return 'warning';
        return 'normal';
    }

    /**
     * Handle warning level memory usage
     */
    handleWarningMemory(heapUsedMB) {
        logger.warn('Memory usage approaching limit', {
            heapUsedMB: Math.round(heapUsedMB),
            thresholdMB: Math.round(this.memoryThresholds.warning),
            managedObjects: this.managedObjects.size
        });
        
        // Trigger light cleanup
        this.performLightCleanup();
    }

    /**
     * Handle critical level memory usage
     */
    handleCriticalMemory(heapUsedMB) {
        logger.warn('Critical memory usage detected', {
            heapUsedMB: Math.round(heapUsedMB),
            thresholdMB: Math.round(this.memoryThresholds.critical)
        });
        
        // Trigger aggressive cleanup
        this.performAggressiveCleanup();
        
        // Force garbage collection if available
        this.forceGarbageCollection();
    }

    /**
     * Handle emergency level memory usage
     */
    handleEmergencyMemory(heapUsedMB) {
        logger.error('Emergency memory usage - initiating emergency cleanup', {
            heapUsedMB: Math.round(heapUsedMB),
            thresholdMB: Math.round(this.memoryThresholds.emergency)
        });
        
        // Emergency cleanup
        this.performEmergencyCleanup();
        
        // Multiple garbage collections
        for (let i = 0; i < 3; i++) {
            setTimeout(() => this.forceGarbageCollection(), i * 100);
        }
        
        this.emit('emergencyMemory', { heapUsedMB });
    }

    /**
     * Register an object for memory management
     */
    registerObject(id, object, cleanupCallback) {
        this.managedObjects.set(id, {
            object,
            registeredAt: Date.now(),
            lastAccessed: Date.now(),
            size: this.estimateObjectSize(object)
        });
        
        if (cleanupCallback) {
            this.cleanupCallbacks.set(id, cleanupCallback);
        }
        
        logger.debug('Object registered for memory management', { id, estimatedSize: this.managedObjects.get(id).size });
    }

    /**
     * Unregister an object from memory management
     */
    unregisterObject(id) {
        if (this.managedObjects.has(id)) {
            this.managedObjects.delete(id);
            
            // Run cleanup callback if exists
            if (this.cleanupCallbacks.has(id)) {
                try {
                    this.cleanupCallbacks.get(id)();
                } catch (error) {
                    logger.error('Error in cleanup callback', { id, error });
                }
                this.cleanupCallbacks.delete(id);
            }
            
            logger.debug('Object unregistered from memory management', { id });
        }
    }

    /**
     * Update last accessed time for an object
     */
    touchObject(id) {
        if (this.managedObjects.has(id)) {
            this.managedObjects.get(id).lastAccessed = Date.now();
        }
    }

    /**
     * Estimate object size in bytes (rough approximation)
     */
    estimateObjectSize(obj) {
        const seen = new WeakSet();
        
        function calculateSize(object) {
            if (object === null || typeof object !== 'object') {
                return 0;
            }
            
            if (seen.has(object)) {
                return 0;
            }
            seen.add(object);
            
            let size = 0;
            
            if (typeof object === 'string') {
                size += object.length * 2; // UTF-16
            } else if (typeof object === 'number') {
                size += 8;
            } else if (typeof object === 'boolean') {
                size += 4;
            } else if (object instanceof Array) {
                size += object.length * 4;
                for (const item of object) {
                    size += calculateSize(item);
                }
            } else if (object instanceof Map) {
                size += object.size * 8;
                for (const [key, value] of object) {
                    size += calculateSize(key) + calculateSize(value);
                }
            } else if (object instanceof Set) {
                size += object.size * 4;
                for (const item of object) {
                    size += calculateSize(item);
                }
            } else {
                for (const key in object) {
                    if (object.hasOwnProperty(key)) {
                        size += calculateSize(key) + calculateSize(object[key]);
                    }
                }
            }
            
            return size;
        }
        
        try {
            return calculateSize(obj);
        } catch (error) {
            return 0; // Fallback for circular references or other issues
        }
    }

    /**
     * Perform light cleanup
     */
    performLightCleanup() {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        let cleanedCount = 0;
        
        for (const [id, data] of this.managedObjects.entries()) {
            // Clean objects not accessed in the last hour
            if (now - data.lastAccessed > oneHour) {
                this.unregisterObject(id);
                cleanedCount++;
            }
        }
        
        logger.debug('Light cleanup completed', { cleanedCount });
    }

    /**
     * Perform aggressive cleanup
     */
    performAggressiveCleanup() {
        const now = Date.now();
        const thirtyMinutes = 30 * 60 * 1000;
        let cleanedCount = 0;
        
        for (const [id, data] of this.managedObjects.entries()) {
            // Clean objects not accessed in the last 30 minutes
            if (now - data.lastAccessed > thirtyMinutes) {
                this.unregisterObject(id);
                cleanedCount++;
            }
        }
        
        logger.info('Aggressive cleanup completed', { cleanedCount });
    }

    /**
     * Perform emergency cleanup
     */
    performEmergencyCleanup() {
        const now = Date.now();
        const tenMinutes = 10 * 60 * 1000;
        let cleanedCount = 0;
        
        for (const [id, data] of this.managedObjects.entries()) {
            // Clean objects not accessed in the last 10 minutes
            if (now - data.lastAccessed > tenMinutes) {
                this.unregisterObject(id);
                cleanedCount++;
            }
        }
        
        logger.warn('Emergency cleanup completed', { cleanedCount });
    }

    /**
     * Perform periodic cleanup
     */
    async performPeriodicCleanup() {
        if (this.isCleanupRunning) return;
        
        this.isCleanupRunning = true;
        
        try {
            logger.debug('Starting periodic cleanup');
            
            const now = Date.now();
            const twoHours = 2 * 60 * 60 * 1000;
            let cleanedCount = 0;
            
            // Clean old objects
            for (const [id, data] of this.managedObjects.entries()) {
                if (now - data.lastAccessed > twoHours) {
                    this.unregisterObject(id);
                    cleanedCount++;
                }
            }
            
            // Force garbage collection periodically
            if (now - this.lastGCTime > 5 * 60 * 1000) { // Every 5 minutes
                this.forceGarbageCollection();
                this.lastGCTime = now;
            }
            
            logger.debug('Periodic cleanup completed', { cleanedCount });
            
        } catch (error) {
            logger.error('Error during periodic cleanup', { error });
        } finally {
            this.isCleanupRunning = false;
        }
    }

    /**
     * Force garbage collection if available
     */
    forceGarbageCollection() {
        if (global.gc) {
            const before = process.memoryUsage().heapUsed;
            global.gc();
            const after = process.memoryUsage().heapUsed;
            const freed = (before - after) / 1024 / 1024;
            
            logger.debug('Garbage collection completed', {
                freedMB: Math.round(freed),
                heapUsedMB: Math.round(after / 1024 / 1024)
            });
        } else {
            logger.debug('Garbage collection not available (run with --expose-gc)');
        }
    }

    /**
     * Get memory statistics
     */
    getMemoryStats() {
        const memUsage = process.memoryUsage();
        
        return {
            current: {
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                rss: Math.round(memUsage.rss / 1024 / 1024),
                external: Math.round(memUsage.external / 1024 / 1024)
            },
            thresholds: {
                warning: Math.round(this.memoryThresholds.warning),
                critical: Math.round(this.memoryThresholds.critical),
                emergency: Math.round(this.memoryThresholds.emergency)
            },
            managed: {
                objectCount: this.managedObjects.size,
                estimatedSizeMB: Math.round(Array.from(this.managedObjects.values())
                    .reduce((total, obj) => total + obj.size, 0) / 1024 / 1024)
            },
            history: this.memoryHistory.slice(-10) // Last 10 measurements
        };
    }

    /**
     * Cleanup for graceful shutdown
     */
    async cleanup() {
        logger.info('Memory manager cleanup initiated');
        
        // Cleanup all managed objects
        for (const id of this.managedObjects.keys()) {
            this.unregisterObject(id);
        }
        
        // Final garbage collection
        this.forceGarbageCollection();
        
        logger.info('Memory manager cleanup completed');
    }
}

// Create singleton instance
const memoryManager = new MemoryManager();

module.exports = memoryManager;
