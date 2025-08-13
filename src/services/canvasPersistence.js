/**
 * Optimized canvas persistence service with memory leak prevention
 * Provides efficient storage, compression, and cleanup mechanisms
 */

const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const config = require('../config/config');
const logger = require('../utils/logger');
const memoryManager = require('../utils/memoryManager');
const securityValidator = require('../utils/security');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class CanvasPersistenceService {
    constructor() {
        this.canvasStates = new Map(); // In-memory cache
        this.pendingWrites = new Map(); // Track pending write operations
        this.backupQueue = [];
        this.isBackupRunning = false;
        this.lastCleanup = Date.now();
        
        // Register with memory manager
        memoryManager.registerObject('canvasPersistence', this, () => this.cleanup());
        
        this.initializeDirectories();
        this.scheduleBackups();
        this.scheduleCleanup();
    }

    /**
     * Initialize required directories
     */
    async initializeDirectories() {
        try {
            await fs.mkdir(config.persistence.dataDir, { recursive: true });
            await fs.mkdir(config.persistence.roomDataDir, { recursive: true });
            
            if (config.logging.enableFile) {
                await fs.mkdir(path.dirname(config.persistence.dataDir + '/logs'), { recursive: true });
            }
            
            logger.info('Canvas persistence directories initialized');
        } catch (error) {
            logger.error('Failed to initialize persistence directories', { error });
            throw error;
        }
    }

    /**
     * Schedule periodic backups
     */
    scheduleBackups() {
        setInterval(() => {
            if (!this.isBackupRunning) {
                this.performBackup();
            }
        }, config.persistence.backupIntervalMs);
    }

    /**
     * Schedule cleanup operations
     */
    scheduleCleanup() {
        setInterval(() => {
            this.performCleanup();
        }, config.memory.cleanupIntervalMs);
    }

    /**
     * Load canvas state - maintains persistent authoritative state
     */
    async loadCanvasState(canvasId = 'main') {
        try {
            // Check if already cached
            if (this.canvasStates.has(canvasId)) {
                const cached = this.canvasStates.get(canvasId);
                logger.debug('Canvas state loaded from cache', { canvasId });
                return cached.data;
            }

            // Try to load from disk first
            let canvasData = null;
            try {
                const filePath = path.join(config.persistence.roomDataDir, `${canvasId}.json`);
                const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
                
                if (fileExists) {
                    const fileData = await fs.readFile(filePath, 'utf8');
                    canvasData = JSON.parse(fileData);
                    
                    // Validate loaded data
                    const validation = securityValidator.validateCanvasState(canvasData);
                    if (validation.valid && validation.data) {
                        logger.info('Canvas state loaded from disk', { canvasId });
                    } else {
                        logger.warn('Invalid canvas state on disk, creating fresh', { canvasId });
                        canvasData = null;
                    }
                }
            } catch (diskError) {
                logger.warn('Failed to load canvas state from disk', { canvasId, error: diskError.message });
                canvasData = null;
            }

            // If no valid data found, create fresh state
            if (!canvasData) {
                canvasData = {
                    strokes: [],
                    background: '#ffffff',
                    metadata: {
                        created: new Date().toISOString(),
                        lastModified: new Date().toISOString(),
                        version: '2.0'
                    }
                };
                logger.info('Canvas state initialized fresh', { canvasId });
            }

            // Cache the state
            this.canvasStates.set(canvasId, {
                data: canvasData,
                timestamp: Date.now(),
                isDirty: false
            });

            memoryManager.touchObject('canvasPersistence');
            
            return canvasData;
        } catch (error) {
            logger.error('Error in loadCanvasState', { canvasId, error });
            
            // Return fresh state even on error
            const fallbackCanvasData = {
                strokes: [],
                background: '#ffffff',
                metadata: {
                    created: new Date().toISOString(),
                    lastModified: new Date().toISOString(),
                    version: '2.0'
                }
            };
            
            return fallbackCanvasData;
        }
    }

    /**
     * Save canvas state with compression and atomic writes
     */
    async saveCanvasState(canvasId = 'main', canvasData) {
        try {
            // Validate input data
            const validation = securityValidator.validateCanvasState(canvasData);
            if (!validation.valid) {
                logger.warn('Attempted to save invalid canvas state', { 
                    canvasId, 
                    error: validation.error 
                });
                return false;
            }

            const validatedData = validation.data;
            if (!validatedData) {
                return false;
            }

            // Check if we already have a pending write for this canvas
            if (this.pendingWrites.has(canvasId)) {
                logger.debug('Write already pending for canvas, skipping', { canvasId });
                return false;
            }

            this.pendingWrites.set(canvasId, Date.now());

            try {
                // Add metadata
                const stateWithMetadata = {
                    ...validatedData,
                    metadata: {
                        savedAt: Date.now(),
                        version: '2.0',
                        canvasId,
                        size: JSON.stringify(validatedData).length
                    }
                };

                const jsonData = JSON.stringify(stateWithMetadata);
                const compressedData = await gzip(jsonData, { 
                    level: config.persistence.compressionLevel 
                });

                const filePath = path.join(config.persistence.dataDir, `${canvasId}-state.json.gz`);
                const tempPath = `${filePath}.tmp`;

                // Atomic write: write to temp file first, then rename
                await fs.writeFile(tempPath, compressedData);
                await fs.rename(tempPath, filePath);

                // Update cache
                this.canvasStates.set(canvasId, {
                    data: stateWithMetadata,
                    timestamp: Date.now(),
                    fileTimestamp: Date.now()
                });

                logger.info('Canvas state saved', {
                    canvasId,
                    originalSizeKB: Math.round(jsonData.length / 1024),
                    compressedSizeKB: Math.round(compressedData.length / 1024),
                    compressionRatio: Math.round((1 - compressedData.length / jsonData.length) * 100)
                });

                // Add to backup queue
                this.backupQueue.push({
                    canvasId,
                    timestamp: Date.now(),
                    filePath
                });

                memoryManager.touchObject('canvasPersistence');
                return true;

            } finally {
                this.pendingWrites.delete(canvasId);
            }

        } catch (error) {
            logger.error('Error saving canvas state', { canvasId, error });
            this.pendingWrites.delete(canvasId);
            return false;
        }
    }

    /**
     * Get canvas state with fallback handling
     */
    getCanvasState(canvasId = 'main') {
        if (this.canvasStates.has(canvasId)) {
            const cached = this.canvasStates.get(canvasId);
            memoryManager.touchObject('canvasPersistence');
            return cached.data;
        }
        return null;
    }

    /**
     * Update canvas state with drawing command (for authoritative sync)
     */
    async addDrawingCommand(canvasId = 'main', drawingCommand) {
        try {
            // Get current canvas state
            const canvasData = await this.loadCanvasState(canvasId);
            
            if (!canvasData.strokes) {
                canvasData.strokes = [];
            }

            // Add the drawing command to the strokes array
            switch (drawingCommand.type) {
                case 'startDrawing':
                    // Start a new stroke
                    canvasData.strokes.push({
                        id: drawingCommand.strokeId,
                        userId: drawingCommand.userId,
                        color: drawingCommand.color,
                        size: drawingCommand.size,
                        points: [{
                            x: drawingCommand.normalizedX,
                            y: drawingCommand.normalizedY,
                            timestamp: drawingCommand.serverTimestamp
                        }],
                        startTime: drawingCommand.serverTimestamp,
                        completed: false
                    });
                    break;

                case 'draw':
                    // Add point to existing stroke
                    const activeStroke = canvasData.strokes.find(s => 
                        s.id === drawingCommand.strokeId && !s.completed
                    );
                    if (activeStroke) {
                        activeStroke.points.push({
                            x: drawingCommand.normalizedX,
                            y: drawingCommand.normalizedY,
                            timestamp: drawingCommand.serverTimestamp
                        });
                    }
                    break;

                case 'endDrawing':
                    // Mark stroke as completed
                    const endingStroke = canvasData.strokes.find(s => 
                        s.id === drawingCommand.strokeId && !s.completed
                    );
                    if (endingStroke) {
                        endingStroke.completed = true;
                        endingStroke.endTime = drawingCommand.serverTimestamp;
                    }
                    break;

                case 'clear-canvas':
                    // Clear all strokes
                    canvasData.strokes = [];
                    canvasData.background = '#ffffff';
                    break;
            }

            // Update metadata
            canvasData.metadata.lastModified = new Date().toISOString();
            canvasData.metadata.lastCommand = drawingCommand.type;
            canvasData.metadata.lastSequence = drawingCommand.serverSequence;

            // Update cache with dirty flag
            this.canvasStates.set(canvasId, {
                data: canvasData,
                timestamp: Date.now(),
                isDirty: true
            });

            // Save to disk (debounced)
            this.scheduleCanvasSave(canvasId);

            memoryManager.touchObject('canvasPersistence');
            logger.debug('Drawing command added to canvas state', {
                canvasId,
                type: drawingCommand.type,
                sequence: drawingCommand.serverSequence,
                strokeCount: canvasData.strokes.length
            });

            return true;

        } catch (error) {
            logger.error('Error adding drawing command to canvas state', { 
                canvasId, 
                command: drawingCommand.type,
                error 
            });
            return false;
        }
    }

    /**
     * Schedule canvas save with debouncing
     */
    scheduleCanvasSave(canvasId) {
        const saveKey = `save_${canvasId}`;
        
        // Clear existing timeout
        if (this[saveKey]) {
            clearTimeout(this[saveKey]);
        }

        // Schedule save after 2 seconds of inactivity
        this[saveKey] = setTimeout(async () => {
            const cached = this.canvasStates.get(canvasId);
            if (cached && cached.isDirty) {
                await this.saveCanvasState(canvasId, cached.data);
                cached.isDirty = false;
            }
            delete this[saveKey];
        }, 2000);
    }

    /**
     * Check if canvas state exists
     */
    hasCanvasState(canvasId = 'main') {
        return this.canvasStates.has(canvasId) && this.canvasStates.get(canvasId).data !== null;
    }

    /**
     * Clear canvas state from memory and optionally from disk
     */
    async clearCanvasState(canvasId = 'main', deleteDisk = false) {
        try {
            // Remove from cache
            this.canvasStates.delete(canvasId);

            if (deleteDisk) {
                const filePath = path.join(config.persistence.dataDir, `${canvasId}-state.json.gz`);
                
                try {
                    await fs.unlink(filePath);
                    logger.info('Canvas state file deleted', { canvasId });
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        logger.warn('Failed to delete canvas state file', { canvasId, error });
                    }
                }
            }

            logger.info('Canvas state cleared', { canvasId, deleteDisk });
            return true;

        } catch (error) {
            logger.error('Error clearing canvas state', { canvasId, error });
            return false;
        }
    }

    /**
     * Create backup of current state
     */
    async performBackup() {
        if (this.isBackupRunning || this.backupQueue.length === 0) {
            return;
        }

        this.isBackupRunning = true;

        try {
            const backupDir = path.join(config.persistence.dataDir, 'backups');
            await fs.mkdir(backupDir, { recursive: true });

            // Process backup queue
            const itemsToBackup = this.backupQueue.splice(0, 10); // Process up to 10 items
            
            for (const item of itemsToBackup) {
                try {
                    const timestamp = new Date(item.timestamp).toISOString().replace(/[:.]/g, '-');
                    const backupPath = path.join(backupDir, `${item.canvasId}-${timestamp}.json.gz`);
                    
                    // Copy current state file to backup
                    await fs.copyFile(item.filePath, backupPath);
                    
                    logger.debug('Backup created', { 
                        canvasId: item.canvasId, 
                        backupPath 
                    });
                    
                } catch (error) {
                    logger.warn('Failed to create backup', { 
                        canvasId: item.canvasId, 
                        error 
                    });
                }
            }

            // Clean old backups
            await this.cleanOldBackups(backupDir);

        } catch (error) {
            logger.error('Error during backup process', { error });
        } finally {
            this.isBackupRunning = false;
        }
    }

    /**
     * Clean old backup files
     */
    async cleanOldBackups(backupDir) {
        try {
            const files = await fs.readdir(backupDir);
            const backupFiles = files
                .filter(file => file.endsWith('.json.gz'))
                .map(file => ({
                    name: file,
                    path: path.join(backupDir, file),
                    stat: null
                }));

            // Get file stats
            for (const file of backupFiles) {
                try {
                    file.stat = await fs.stat(file.path);
                } catch (error) {
                    logger.warn('Failed to stat backup file', { file: file.name, error });
                }
            }

            // Sort by modification time (newest first)
            const validFiles = backupFiles
                .filter(file => file.stat)
                .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

            // Delete files beyond the limit
            if (validFiles.length > config.persistence.maxBackups) {
                const filesToDelete = validFiles.slice(config.persistence.maxBackups);
                
                for (const file of filesToDelete) {
                    try {
                        await fs.unlink(file.path);
                        logger.debug('Old backup deleted', { file: file.name });
                    } catch (error) {
                        logger.warn('Failed to delete old backup', { file: file.name, error });
                    }
                }
            }

        } catch (error) {
            logger.warn('Error cleaning old backups', { error });
        }
    }

    /**
     * Perform cleanup operations
     */
    async performCleanup() {
        const now = Date.now();
        
        try {
            // Clean expired cache entries
            let cleanedCache = 0;
            const maxCacheAge = 10 * 60 * 1000; // 10 minutes
            
            for (const [canvasId, cached] of this.canvasStates.entries()) {
                if (now - cached.timestamp > maxCacheAge) {
                    this.canvasStates.delete(canvasId);
                    cleanedCache++;
                }
            }

            // Clean pending writes that are stuck
            let cleanedPending = 0;
            const maxPendingAge = 5 * 60 * 1000; // 5 minutes
            
            for (const [canvasId, timestamp] of this.pendingWrites.entries()) {
                if (now - timestamp > maxPendingAge) {
                    this.pendingWrites.delete(canvasId);
                    cleanedPending++;
                    logger.warn('Cleared stuck pending write', { canvasId });
                }
            }

            // Clean backup queue if too large
            if (this.backupQueue.length > 100) {
                this.backupQueue = this.backupQueue.slice(-50); // Keep last 50
                logger.info('Backup queue trimmed to prevent memory issues');
            }

            if (cleanedCache > 0 || cleanedPending > 0) {
                logger.debug('Canvas persistence cleanup completed', {
                    cleanedCache,
                    cleanedPending,
                    activeCacheEntries: this.canvasStates.size,
                    pendingWrites: this.pendingWrites.size
                });
            }

            this.lastCleanup = now;
            memoryManager.touchObject('canvasPersistence');

        } catch (error) {
            logger.error('Error during canvas persistence cleanup', { error });
        }
    }

    /**
     * Get statistics about the persistence service
     */
    getStats() {
        return {
            cacheEntries: this.canvasStates.size,
            pendingWrites: this.pendingWrites.size,
            backupQueueSize: this.backupQueue.length,
            lastCleanup: this.lastCleanup,
            isBackupRunning: this.isBackupRunning,
            memoryUsage: this.estimateMemoryUsage()
        };
    }

    /**
     * Estimate memory usage
     */
    estimateMemoryUsage() {
        let totalSize = 0;
        
        for (const [canvasId, cached] of this.canvasStates.entries()) {
            totalSize += canvasId.length * 2;
            totalSize += JSON.stringify(cached.data).length * 2;
            totalSize += 64; // Object overhead
        }
        
        totalSize += this.backupQueue.length * 100; // Estimate for backup queue items
        
        return Math.round(totalSize / 1024); // Return in KB
    }

    /**
     * Graceful cleanup for shutdown
     */
    async cleanup() {
        logger.info('Canvas persistence cleanup initiated');
        
        try {
            // Wait for pending writes to complete
            let waitCount = 0;
            while (this.pendingWrites.size > 0 && waitCount < 30) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                waitCount++;
            }
            
            // Process remaining backup queue
            if (this.backupQueue.length > 0) {
                await this.performBackup();
            }
            
            // Clear caches
            this.canvasStates.clear();
            this.pendingWrites.clear();
            this.backupQueue.length = 0;
            
            logger.info('Canvas persistence cleanup completed');
            
        } catch (error) {
            logger.error('Error during canvas persistence cleanup', { error });
        }
    }
}

// Create singleton instance
const canvasPersistenceService = new CanvasPersistenceService();

module.exports = canvasPersistenceService;
