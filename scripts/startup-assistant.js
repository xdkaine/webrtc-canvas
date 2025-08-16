#!/usr/bin/env node

/**
 * Startup script to help transition from old to new server
 * Provides guidance and checks system compatibility
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class StartupAssistant {
    constructor() {
        this.issues = [];
        this.warnings = [];
        this.recommendations = [];
    }

    async run() {
        console.log('🚀 WebRTC Canvas Server - Startup Assistant\n');
        
        // Check system requirements
        this.checkNodeVersion();
        this.checkDependencies();
        this.checkDirectories();
        this.checkMemory();
        this.checkPorts();
        
        // Show migration info
        this.showMigrationInfo();
        
        // Display results
        this.displayResults();
        
        // Offer to start server
        await this.offerStartup();
    }

    checkNodeVersion() {
        const nodeVersion = process.version;
        const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
        
        console.log(`📋 Node.js version: ${nodeVersion}`);
        
        if (majorVersion < 14) {
            this.issues.push('Node.js 14+ required for optimal performance');
        } else if (majorVersion < 16) {
            this.warnings.push('Node.js 16+ recommended for best compatibility');
        } else {
            console.log('   ✅ Node.js version is compatible');
        }
    }

    checkDependencies() {
        console.log('\n📦 Checking dependencies...');
        
        const packageJson = path.join(process.cwd(), 'package.json');
        if (!fs.existsSync(packageJson)) {
            this.issues.push('package.json not found - run npm init first');
            return;
        }

        try {
            const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            
            const required = ['express', 'socket.io', 'compression'];
            const missing = required.filter(dep => !deps[dep]);
            
            if (missing.length > 0) {
                this.issues.push(`Missing dependencies: ${missing.join(', ')}`);
                this.recommendations.push('Run: npm install');
            } else {
                console.log('   ✅ All required dependencies found');
            }
        } catch (error) {
            this.issues.push('Invalid package.json file');
        }
    }

    checkDirectories() {
        console.log('\n📁 Checking directory structure...');
        
        const requiredDirs = [
            'public',
            'src',
            'src/config',
            'src/controllers',
            'src/services',
            'src/middleware',
            'src/utils'
        ];
        
        const missingDirs = requiredDirs.filter(dir => 
            !fs.existsSync(path.join(process.cwd(), dir))
        );
        
        if (missingDirs.length > 0) {
            this.issues.push(`Missing directories: ${missingDirs.join(', ')}`);
        } else {
            console.log('   ✅ Directory structure is correct');
        }
        
        // Check for data directories
        const dataDirs = ['canvas-data', 'room-data', 'uploads'];
        dataDirs.forEach(dir => {
            const dirPath = path.join(process.cwd(), dir);
            if (!fs.existsSync(dirPath)) {
                console.log(`   ℹ️  Will create ${dir} directory on startup`);
            }
        });
    }

    checkMemory() {
        console.log('\n🧠 Checking system memory...');
        
        const totalMem = require('os').totalmem();
        const freeMem = require('os').freemem();
        const usedMem = totalMem - freeMem;
        
        const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(1);
        const freeGB = (freeMem / 1024 / 1024 / 1024).toFixed(1);
        const usagePercent = ((usedMem / totalMem) * 100).toFixed(1);
        
        console.log(`   Total: ${totalGB}GB, Free: ${freeGB}GB, Usage: ${usagePercent}%`);
        
        if (freeMem < 512 * 1024 * 1024) { // Less than 512MB free
            this.warnings.push('Low available memory - may impact performance');
        } else {
            console.log('   ✅ Sufficient memory available');
        }
    }

    checkPorts() {
        console.log('\n🌐 Checking port availability...');
        
        const net = require('net');
        const port = 3003;
        
        return new Promise((resolve) => {
            const server = net.createServer();
            
            server.listen(port, () => {
                server.close(() => {
                    console.log(`   ✅ Port ${port} is available`);
                    resolve();
                });
            });
            
            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    this.warnings.push(`Port ${port} is already in use`);
                    this.recommendations.push('Stop the existing server or use a different port');
                }
                resolve();
            });
        });
    }

    showMigrationInfo() {
        console.log('\n🔄 Migration Information:');
        
        const oldServerExists = fs.existsSync(path.join(process.cwd(), 'server.js'));
        const newServerExists = fs.existsSync(path.join(process.cwd(), 'server-refactored.js'));
        
        if (oldServerExists && newServerExists) {
            console.log('   📊 Both servers available:');
            console.log('     • npm run start:old  - Run original server');
            console.log('     • npm start          - Run refactored server (recommended)');
            console.log('     • npm run dev        - Development mode with auto-reload');
        } else if (newServerExists) {
            console.log('   ✅ Refactored server ready');
        } else {
            this.issues.push('Refactored server files not found');
        }
        
        // Check for existing data
        const hasCanvasData = fs.existsSync(path.join(process.cwd(), 'canvas-data'));
        const hasRoomData = fs.existsSync(path.join(process.cwd(), 'room-data'));
        
        if (hasCanvasData || hasRoomData) {
            console.log('   💾 Existing data found - will be preserved');
        }
    }

    displayResults() {
        console.log('\n📋 System Check Results:');
        
        if (this.issues.length === 0) {
            console.log('   ✅ All checks passed! System is ready.');
        } else {
            console.log('   ❌ Issues found:');
            this.issues.forEach(issue => console.log(`     • ${issue}`));
        }
        
        if (this.warnings.length > 0) {
            console.log('   ⚠️  Warnings:');
            this.warnings.forEach(warning => console.log(`     • ${warning}`));
        }
        
        if (this.recommendations.length > 0) {
            console.log('   💡 Recommendations:');
            this.recommendations.forEach(rec => console.log(`     • ${rec}`));
        }
    }

    async offerStartup() {
        if (this.issues.length > 0) {
            console.log('\n❌ Cannot start server due to issues above.');
            console.log('Please resolve the issues and run this script again.');
            return;
        }
        
        console.log('\n🚀 Ready to start server!');
        console.log('\nAvailable commands:');
        console.log('  npm start              - Start refactored server');
        console.log('  npm run dev            - Development mode');
        console.log('  npm run dev:gc         - Development with garbage collection');
        console.log('  npm test               - Run basic tests');
        console.log('  npm run clean          - Clean old data');
        
        // Check if we're in an interactive terminal
        if (process.stdin.isTTY) {
            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            return new Promise((resolve) => {
                rl.question('\n🔥 Start the server now? (y/N): ', (answer) => {
                    rl.close();
                    
                    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
                        console.log('\n🚀 Starting server...\n');
                        try {
                            execSync('npm start', { stdio: 'inherit' });
                        } catch (error) {
                            console.error('Failed to start server:', error.message);
                        }
                    } else {
                        console.log('\n👋 Run "npm start" when you\'re ready!');
                    }
                    resolve();
                });
            });
        } else {
            console.log('\n👋 Run "npm start" to start the server!');
        }
    }
}

// Run if called directly
if (require.main === module) {
    const assistant = new StartupAssistant();
    assistant.run().catch(error => {
        console.error('Startup assistant failed:', error);
        process.exit(1);
    });
}

module.exports = StartupAssistant;
