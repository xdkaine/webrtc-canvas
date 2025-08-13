/**
 * Cleanup script for maintenance tasks
 * Removes old data, logs, and temporary files
 */

const fs = require('fs').promises;
const path = require('path');

async function cleanup() {
    console.log('🧹 Starting cleanup process...\n');
    
    const rootDir = path.join(__dirname, '..');
    let totalCleaned = 0;
    
    try {
        // Clean canvas data
        const canvasDataDir = path.join(rootDir, 'canvas-data');
        const canvasDataCleaned = await cleanDirectory(canvasDataDir, '*.json', 7); // Keep last 7 days
        console.log(`📊 Canvas data: ${canvasDataCleaned} old files cleaned`);
        totalCleaned += canvasDataCleaned;
        
        // Clean room data
        const roomDataDir = path.join(rootDir, 'room-data');
        const roomDataCleaned = await cleanDirectory(roomDataDir, '*.json', 7);
        console.log(`🏠 Room data: ${roomDataCleaned} old files cleaned`);
        totalCleaned += roomDataCleaned;
        
        // Clean logs
        const logsDir = path.join(rootDir, 'logs');
        const logsCleaned = await cleanDirectory(logsDir, '*.log', 14); // Keep last 14 days
        console.log(`📝 Logs: ${logsCleaned} old files cleaned`);
        totalCleaned += logsCleaned;
        
        // Clean uploads
        const uploadsDir = path.join(rootDir, 'uploads');
        const uploadsCleaned = await cleanDirectory(uploadsDir, '*', 30); // Keep last 30 days
        console.log(`📁 Uploads: ${uploadsCleaned} old files cleaned`);
        totalCleaned += uploadsCleaned;
        
        // Clean backups (keep only last 10)
        const backupsDir = path.join(canvasDataDir, 'backups');
        const backupsCleaned = await cleanBackups(backupsDir, 10);
        console.log(`💾 Backups: ${backupsCleaned} old backups cleaned`);
        totalCleaned += backupsCleaned;
        
        // Clean node_modules cache (if exists)
        const nodeModulesCache = path.join(rootDir, 'node_modules/.cache');
        try {
            await fs.rmdir(nodeModulesCache, { recursive: true });
            console.log('🗄️  Node modules cache cleaned');
        } catch (error) {
            // Ignore if doesn't exist
        }
        
        console.log(`\n✅ Cleanup completed! Total files cleaned: ${totalCleaned}`);
        
        // Show disk space saved estimate
        console.log('💾 Estimated disk space reclaimed: ~' + Math.round(totalCleaned * 0.5) + 'MB');
        
    } catch (error) {
        console.error('❌ Cleanup failed:', error.message);
        process.exit(1);
    }
}

async function cleanDirectory(dirPath, pattern, keepDays) {
    try {
        const files = await fs.readdir(dirPath);
        const cutoffTime = Date.now() - (keepDays * 24 * 60 * 60 * 1000);
        let cleanedCount = 0;
        
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = await fs.stat(filePath);
            
            if (stats.isFile() && stats.mtime.getTime() < cutoffTime) {
                await fs.unlink(filePath);
                cleanedCount++;
            }
        }
        
        return cleanedCount;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`⚠️  Warning cleaning ${dirPath}: ${error.message}`);
        }
        return 0;
    }
}

async function cleanBackups(backupsDir, keepCount) {
    try {
        const files = await fs.readdir(backupsDir);
        const backupFiles = [];
        
        for (const file of files) {
            if (file.endsWith('.json.gz')) {
                const filePath = path.join(backupsDir, file);
                const stats = await fs.stat(filePath);
                backupFiles.push({
                    name: file,
                    path: filePath,
                    mtime: stats.mtime.getTime()
                });
            }
        }
        
        // Sort by modification time (newest first)
        backupFiles.sort((a, b) => b.mtime - a.mtime);
        
        // Delete files beyond keepCount
        let cleanedCount = 0;
        if (backupFiles.length > keepCount) {
            const filesToDelete = backupFiles.slice(keepCount);
            
            for (const file of filesToDelete) {
                await fs.unlink(file.path);
                cleanedCount++;
            }
        }
        
        return cleanedCount;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`⚠️  Warning cleaning backups: ${error.message}`);
        }
        return 0;
    }
}

// Run cleanup if called directly
if (require.main === module) {
    cleanup().catch(error => {
        console.error('Cleanup failed:', error);
        process.exit(1);
    });
}

module.exports = cleanup;
