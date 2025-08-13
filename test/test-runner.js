/**
 * Simple test runner for the refactored server
 * Tests basic functionality and memory management
 */

const http = require('http');
const { io: ioc } = require('socket.io-client');

class TestRunner {
    constructor() {
        this.tests = [];
        this.passed = 0;
        this.failed = 0;
        this.serverUrl = 'http://localhost:3003';
    }

    addTest(name, testFn) {
        this.tests.push({ name, testFn });
    }

    async runTests() {
        console.log('🧪 Starting tests for refactored WebRTC Canvas Server\n');
        
        // Wait for server to be ready
        await this.waitForServer();
        
        for (const test of this.tests) {
            try {
                console.log(`⏳ Running: ${test.name}`);
                await test.testFn();
                console.log(`✅ Passed: ${test.name}`);
                this.passed++;
            } catch (error) {
                console.log(`❌ Failed: ${test.name} - ${error.message}`);
                this.failed++;
            }
        }
        
        console.log(`\n📊 Test Results:`);
        console.log(`   Passed: ${this.passed}`);
        console.log(`   Failed: ${this.failed}`);
        console.log(`   Total:  ${this.tests.length}`);
        
        if (this.failed > 0) {
            console.log(`\n❌ Some tests failed`);
            process.exit(1);
        } else {
            console.log(`\n✅ All tests passed!`);
            process.exit(0);
        }
    }

    async waitForServer() {
        const maxAttempts = 30;
        let attempts = 0;
        
        while (attempts < maxAttempts) {
            try {
                await this.makeRequest('/health');
                console.log('✅ Server is ready\n');
                return;
            } catch (error) {
                attempts++;
                if (attempts >= maxAttempts) {
                    throw new Error('Server did not start within timeout');
                }
                await this.sleep(1000);
            }
        }
    }

    async makeRequest(path) {
        return new Promise((resolve, reject) => {
            const req = http.get(`${this.serverUrl}${path}`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve({ statusCode: res.statusCode, data: parsed });
                    } catch (error) {
                        resolve({ statusCode: res.statusCode, data: data });
                    }
                });
            });
            
            req.on('error', reject);
            req.setTimeout(5000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    async createSocketConnection() {
        return new Promise((resolve, reject) => {
            const socket = ioc(this.serverUrl, {
                transports: ['websocket'],
                timeout: 5000
            });
            
            socket.on('connect', () => resolve(socket));
            socket.on('connect_error', reject);
            
            setTimeout(() => {
                if (!socket.connected) {
                    socket.disconnect();
                    reject(new Error('Socket connection timeout'));
                }
            }, 5000);
        });
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Create test runner
const runner = new TestRunner();

// Health check test
runner.addTest('Health Check', async () => {
    const response = await runner.makeRequest('/health');
    if (response.statusCode !== 200) {
        throw new Error(`Expected 200, got ${response.statusCode}`);
    }
    if (response.data.status !== 'OK') {
        throw new Error(`Expected status OK, got ${response.data.status}`);
    }
});

// Metrics endpoint test
runner.addTest('Metrics Endpoint', async () => {
    const response = await runner.makeRequest('/api/metrics');
    if (response.statusCode !== 200) {
        throw new Error(`Expected 200, got ${response.statusCode}`);
    }
    if (!response.data.timestamp) {
        throw new Error('Metrics response missing timestamp');
    }
});

// Session info test
runner.addTest('Session Info', async () => {
    const response = await runner.makeRequest('/api/session-info');
    if (response.statusCode !== 200) {
        throw new Error(`Expected 200, got ${response.statusCode}`);
    }
    if (typeof response.data.userCount !== 'number') {
        throw new Error('Session info missing userCount');
    }
});

// Socket connection test
runner.addTest('Socket Connection', async () => {
    const socket = await runner.createSocketConnection();
    
    if (!socket.connected) {
        throw new Error('Socket failed to connect');
    }
    
    socket.disconnect();
});

// Anonymous browsing test
runner.addTest('Anonymous Browsing', async () => {
    const socket = await runner.createSocketConnection();
    
    return new Promise((resolve, reject) => {
        socket.emit('anonymous-browse');
        
        socket.on('anonymous-browse-confirmed', () => {
            socket.disconnect();
            resolve();
        });
        
        socket.on('error', (error) => {
            socket.disconnect();
            reject(new Error(`Socket error: ${error.message}`));
        });
        
        setTimeout(() => {
            socket.disconnect();
            reject(new Error('Anonymous browse confirmation timeout'));
        }, 3000);
    });
});

// Canvas state request test
runner.addTest('Canvas State Request', async () => {
    const socket = await runner.createSocketConnection();
    
    return new Promise((resolve, reject) => {
        socket.emit('anonymous-browse');
        
        socket.on('anonymous-browse-confirmed', () => {
            socket.emit('request-canvas-state-anonymous');
        });
        
        socket.on('canvas-state', (data) => {
            socket.disconnect();
            
            if (data.isServerState !== true) {
                reject(new Error('Canvas state response invalid'));
            } else {
                resolve();
            }
        });
        
        socket.on('error', (error) => {
            socket.disconnect();
            reject(new Error(`Socket error: ${error.message}`));
        });
        
        setTimeout(() => {
            socket.disconnect();
            reject(new Error('Canvas state request timeout'));
        }, 5000);
    });
});

// Memory management test
runner.addTest('Memory Management', async () => {
    const response = await runner.makeRequest('/api/metrics');
    
    if (response.statusCode !== 200) {
        throw new Error(`Expected 200, got ${response.statusCode}`);
    }
    
    const memory = response.data.memory;
    if (!memory || !memory.current) {
        throw new Error('Memory metrics not available');
    }
    
    // Check if memory usage is reasonable (less than 256MB for test)
    if (memory.current.heapUsed > 256) {
        throw new Error(`Memory usage too high: ${memory.current.heapUsed}MB`);
    }
});

// Rate limiting test
runner.addTest('Rate Limiting', async () => {
    const socket = await runner.createSocketConnection();
    
    return new Promise((resolve, reject) => {
        let errorReceived = false;
        
        socket.on('error', (error) => {
            if (error.type === 'RATE_LIMIT') {
                errorReceived = true;
                socket.disconnect();
                resolve();
            }
        });
        
        // Spam the server to trigger rate limiting
        for (let i = 0; i < 200; i++) {
            socket.emit('ping');
        }
        
        setTimeout(() => {
            socket.disconnect();
            if (!errorReceived) {
                reject(new Error('Rate limiting not triggered'));
            }
        }, 3000);
    });
});

// Run tests
if (require.main === module) {
    runner.runTests().catch(error => {
        console.error('Test runner failed:', error);
        process.exit(1);
    });
}

module.exports = runner;
