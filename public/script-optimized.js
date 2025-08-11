class OptimizedCollaborativeCanvas {
    constructor() {
        this.canvas = document.getElementById('drawingCanvas');
        this.ctx = this.canvas.getContext('2d');
        
        // WebRTC and networking
        this.peers = new Map();
        this.dataChannels = new Map();
        this.socket = null;
        this.connectionQuality = new Map(); // Track connection quality per peer
        
        // User and session management
        this.userId = this.generateUserId();
        this.nickname = this.getUserNickname();
        this.sessionId = 'default';
        this.connectedUsers = new Map();
        this.remoteCursors = new Map();
        
        // Drawing state
        this.isDrawing = false;
        this.currentColor = '#000000';
        this.currentSize = 5;
        this.currentPath = [];
        
        // Optimized buffering system
        this.drawingBuffer = [];
        this.chatBuffer = [];
        this.bufferTimers = {
            drawing: null,
            chat: null
        };
        
        // Canvas dimensions for coordinate normalization
        this.canvasWidth = 800;
        this.canvasHeight = 600;
        
        // Performance monitoring
        this.stats = {
            messagesPerSecond: 0,
            messageCount: 0,
            lastStatsReset: Date.now(),
            averageLatency: 0,
            latencySamples: []
        };
        
        // Connection state
        this.connectionState = 'disconnected';
        this.lastPingTime = 0;
        this.pingInterval = null;
        
        this.initializeCanvas();
        this.initializeControls();
        this.initializeUserInterface();
        this.initializeChat();
        this.initializeWebSocket();
        this.initializeWebRTC();
        this.startPerformanceMonitoring();
    }

    generateUserId() {
        return 'user_' + Math.random().toString(36).substr(2, 9);
    }

    getUserNickname() {
        let nickname = localStorage.getItem('canvas_nickname');
        if (!nickname) {
            this.showNicknameModal();
            return 'Anonymous';
        }
        return nickname;
    }

    showNicknameModal() {
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'nicknameModal';
        modalOverlay.className = 'modal-overlay';
        modalOverlay.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Welcome to Collaborative Canvas!</h3>
                    <p>Enter your nickname to get started</p>
                </div>
                <div class="modal-body">
                    <input type="text" id="nicknameInput" class="nickname-input" 
                           placeholder="Your nickname (optional)" maxlength="20" autocomplete="off">
                    <p class="modal-hint">Leave empty to remain anonymous</p>
                </div>
                <div class="modal-footer">
                    <button id="nicknameCancel" class="btn-secondary">Stay Anonymous</button>
                    <button id="nicknameConfirm" class="btn-primary">Join Canvas</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modalOverlay);
        
        const input = document.getElementById('nicknameInput');
        input.focus();
        
        const handleSubmit = () => {
            const inputValue = input.value.trim();
            let finalNickname = 'Anonymous';
            
            if (inputValue !== '') {
                finalNickname = this.sanitizeInput(inputValue).substring(0, 20);
            }
            
            this.nickname = finalNickname;
            localStorage.setItem('canvas_nickname', finalNickname);
            
            document.body.removeChild(modalOverlay);
            
            // Connect after nickname is set
            if (this.socket && this.socket.connected) {
                this.joinSession();
            }
        };
        
        document.getElementById('nicknameConfirm').addEventListener('click', handleSubmit);
        document.getElementById('nicknameCancel').addEventListener('click', () => {
            this.nickname = 'Anonymous';
            localStorage.setItem('canvas_nickname', 'Anonymous');
            document.body.removeChild(modalOverlay);
            if (this.socket && this.socket.connected) {
                this.joinSession();
            }
        });
        
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleSubmit();
            }
        });
    }

    // Optimized WebSocket initialization with better error handling
    initializeWebSocket() {
        try {
            // Initialize Socket.IO with optimized settings
            this.socket = io({
                transports: ['websocket', 'polling'],
                upgrade: true,
                rememberUpgrade: true,
                timeout: 20000,
                forceNew: false,
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
                maxReconnectionAttempts: 10,
                randomizationFactor: 0.5
            });

            this.setupSocketEventHandlers();
        } catch (error) {
            console.error('Failed to initialize WebSocket:', error);
            this.updateConnectionStatus('error');
        }
    }

    setupSocketEventHandlers() {
        // Connection events
        this.socket.on('connect', () => {
            console.log('WebSocket connected');
            this.connectionState = 'connected';
            this.updateConnectionStatus('connected');
            this.startHeartbeat();
            this.joinSession();
        });

        this.socket.on('disconnect', (reason) => {
            console.log('WebSocket disconnected:', reason);
            this.connectionState = 'disconnected';
            this.updateConnectionStatus('disconnected');
            this.stopHeartbeat();
        });

        this.socket.on('reconnect', (attemptNumber) => {
            console.log('WebSocket reconnected after', attemptNumber, 'attempts');
            this.connectionState = 'connected';
            this.updateConnectionStatus('connected');
            this.joinSession();
        });

        this.socket.on('connect_error', (error) => {
            console.error('WebSocket connection error:', error);
            this.connectionState = 'error';
            this.updateConnectionStatus('error');
        });

        // Session events
        this.socket.on('session-joined', (data) => {
            console.log('Joined session:', data);
            this.handleSessionJoined(data);
        });

        this.socket.on('user-joined', (data) => {
            console.log('User joined:', data);
            this.handleUserJoined(data);
        });

        this.socket.on('user-left', (data) => {
            console.log('User left:', data);
            this.handleUserLeft(data);
        });

        // WebRTC signaling
        this.socket.on('webrtc-signal', (data) => {
            this.handleWebRTCSignal(data);
        });

        // Real-time data
        this.socket.on('drawing-data', (data) => {
            this.handleRemoteDrawing(data);
        });

        this.socket.on('chat-message', (data) => {
            this.addChatMessage(data);
        });

        this.socket.on('message-history', (data) => {
            this.handleMessageHistory(data);
        });

        this.socket.on('canvas-state', (data) => {
            this.applyCanvasState(data);
        });

        this.socket.on('cursor-position', (data) => {
            this.updateRemoteCursor(data);
        });

        // Heartbeat
        this.socket.on('pong', () => {
            if (this.lastPingTime > 0) {
                const latency = Date.now() - this.lastPingTime;
                this.updateLatencyStats(latency);
            }
        });

        // Error handling
        this.socket.on('error', (error) => {
            console.error('Socket error:', error);
            if (error.message) {
                this.showNotification(error.message, 'error');
            }
        });
    }

    // Optimized session joining
    joinSession() {
        if (!this.socket || !this.socket.connected) {
            console.warn('Cannot join session: socket not connected');
            return;
        }

        this.socket.emit('join-session', {
            userId: this.userId,
            sessionId: this.sessionId,
            nickname: this.nickname
        });
    }

    handleSessionJoined(data) {
        this.updateUserCount(data.userCount);
        
        // Update connected users
        data.users.forEach(user => {
            if (user.userId !== this.userId) {
                this.connectedUsers.set(user.userId, user);
                // Initiate WebRTC connection for existing users
                this.createPeerConnection(user.userId, true);
            }
        });
        
        this.updateUsersList();
        this.showNotification(`Joined session with ${data.userCount} users`, 'success');
    }

    handleUserJoined(data) {
        if (data.userId !== this.userId) {
            this.connectedUsers.set(data.userId, data);
            this.updateUsersList();
            this.updateUserCount(data.userCount);
            
            // Create WebRTC connection for new user
            this.createPeerConnection(data.userId, false); // They will initiate
            
            this.showNotification(`${data.nickname} joined`, 'info');
        }
    }

    handleUserLeft(data) {
        if (data.userId !== this.userId) {
            this.connectedUsers.delete(data.userId);
            this.removePeer(data.userId);
            this.updateUsersList();
            
            const user = this.connectedUsers.get(data.userId);
            const nickname = user ? user.nickname : 'User';
            this.showNotification(`${nickname} left`, 'info');
        }
    }

    // Enhanced WebRTC with better ICE configuration
    initializeWebRTC() {
        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun.cloudflare.com:3478' }
            ],
            iceCandidatePoolSize: 10,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        };
    }

    async createPeerConnection(userId, isInitiator) {
        try {
            if (this.peers.has(userId)) {
                console.warn(`Peer connection already exists for ${userId}`);
                return;
            }

            const peerConnection = new RTCPeerConnection(this.rtcConfig);
            this.peers.set(userId, peerConnection);

            // Initialize connection quality tracking
            this.connectionQuality.set(userId, {
                packetsLost: 0,
                roundTripTime: 0,
                jitter: 0,
                lastUpdate: Date.now()
            });

            // Create data channel with optimized settings
            if (isInitiator) {
                const dataChannel = peerConnection.createDataChannel('collaborative-canvas', {
                    ordered: false, // Allow out-of-order delivery for better performance
                    maxRetransmits: 0, // Don't retransmit for real-time data
                    maxPacketLifeTime: 100, // 100ms max lifetime for real-time data
                    protocol: 'canvas-v1'
                });
                this.setupDataChannel(dataChannel, userId);
            }

            // Handle incoming data channels
            peerConnection.ondatachannel = (event) => {
                this.setupDataChannel(event.channel, userId);
            };

            // ICE candidate handling
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    this.sendWebRTCSignal(userId, {
                        type: 'ice-candidate',
                        candidate: event.candidate
                    });
                }
            };

            // Connection state monitoring
            peerConnection.onconnectionstatechange = () => {
                const state = peerConnection.connectionState;
                console.log(`Connection state with ${userId}:`, state);
                
                if (state === 'connected') {
                    this.startConnectionMonitoring(userId, peerConnection);
                } else if (state === 'disconnected' || state === 'failed') {
                    this.handlePeerDisconnection(userId);
                }
            };

            // ICE connection state monitoring
            peerConnection.oniceconnectionstatechange = () => {
                const state = peerConnection.iceConnectionState;
                console.log(`ICE connection state with ${userId}:`, state);
                
                if (state === 'failed') {
                    this.restartICE(userId, peerConnection);
                }
            };

            if (isInitiator) {
                const offer = await peerConnection.createOffer({
                    offerToReceiveAudio: false,
                    offerToReceiveVideo: false
                });
                await peerConnection.setLocalDescription(offer);
                
                this.sendWebRTCSignal(userId, {
                    type: 'offer',
                    offer: offer
                });
            }

        } catch (error) {
            console.error('Error creating peer connection:', error);
            this.removePeer(userId);
        }
    }

    setupDataChannel(dataChannel, userId) {
        this.dataChannels.set(userId, dataChannel);
        
        dataChannel.onopen = () => {
            console.log(`Data channel opened with ${userId}`);
            
            // Send user info
            this.sendToPeer(userId, {
                type: 'user-info',
                userId: this.userId,
                nickname: this.nickname,
                timestamp: Date.now()
            });
            
            // Request canvas sync if this is a new connection
            this.sendToPeer(userId, {
                type: 'request-canvas-sync',
                timestamp: Date.now()
            });
        };
        
        dataChannel.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleDataChannelMessage(data, userId);
            } catch (error) {
                console.error('Error parsing data channel message:', error);
            }
        };
        
        dataChannel.onerror = (error) => {
            console.error(`Data channel error with ${userId}:`, error);
        };
        
        dataChannel.onclose = () => {
            console.log(`Data channel closed with ${userId}`);
            this.dataChannels.delete(userId);
        };
    }

    sendToPeer(userId, data) {
        const dataChannel = this.dataChannels.get(userId);
        if (dataChannel && dataChannel.readyState === 'open') {
            try {
                dataChannel.send(JSON.stringify(data));
                return true;
            } catch (error) {
                console.error(`Error sending to peer ${userId}:`, error);
                return false;
            }
        }
        return false;
    }

    sendWebRTCSignal(targetUserId, signal) {
        if (this.socket && this.socket.connected) {
            this.socket.emit('webrtc-signal', {
                targetUserId,
                signal
            });
        }
    }

    async handleWebRTCSignal(data) {
        const { fromUserId, signal } = data;
        
        try {
            if (signal.type === 'offer') {
                await this.handleOffer(fromUserId, signal.offer);
            } else if (signal.type === 'answer') {
                await this.handleAnswer(fromUserId, signal.answer);
            } else if (signal.type === 'ice-candidate') {
                await this.handleIceCandidate(fromUserId, signal.candidate);
            }
        } catch (error) {
            console.error('Error handling WebRTC signal:', error);
        }
    }

    async handleOffer(fromUserId, offer) {
        let peerConnection = this.peers.get(fromUserId);
        
        if (!peerConnection) {
            await this.createPeerConnection(fromUserId, false);
            peerConnection = this.peers.get(fromUserId);
        }
        
        if (peerConnection) {
            await peerConnection.setRemoteDescription(offer);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            this.sendWebRTCSignal(fromUserId, {
                type: 'answer',
                answer: answer
            });
        }
    }

    async handleAnswer(fromUserId, answer) {
        const peerConnection = this.peers.get(fromUserId);
        if (peerConnection) {
            await peerConnection.setRemoteDescription(answer);
        }
    }

    async handleIceCandidate(fromUserId, candidate) {
        const peerConnection = this.peers.get(fromUserId);
        if (peerConnection && peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(candidate);
        }
    }

    // Optimized drawing data transmission
    broadcastDrawing(data) {
        // Add to buffer for batching
        this.drawingBuffer.push({
            ...data,
            timestamp: Date.now()
        });
        
        // Clear existing timer and set new one for adaptive batching
        if (this.bufferTimers.drawing) {
            clearTimeout(this.bufferTimers.drawing);
        }
        
        // Use shorter delay for real-time drawing, longer for batch optimization
        const delay = this.isDrawing ? 16 : 50; // 60fps when drawing, 20fps when idle
        
        this.bufferTimers.drawing = setTimeout(() => {
            this.flushDrawingBuffer();
        }, delay);
    }

    flushDrawingBuffer() {
        if (this.drawingBuffer.length === 0) return;
        
        const batch = [...this.drawingBuffer];
        this.drawingBuffer = [];
        
        // Try WebRTC first (lower latency)
        let sentViaWebRTC = false;
        this.dataChannels.forEach((channel, userId) => {
            if (channel.readyState === 'open') {
                batch.forEach(data => {
                    this.sendToPeer(userId, data);
                });
                sentViaWebRTC = true;
            }
        });
        
        // Fallback to WebSocket for users without WebRTC
        if (!sentViaWebRTC || this.dataChannels.size === 0) {
            batch.forEach(data => {
                if (this.socket && this.socket.connected) {
                    this.socket.emit('drawing-data', data);
                }
            });
        }
        
        this.updateStats('messages', batch.length);
    }

    handleDataChannelMessage(data, userId) {
        switch (data.type) {
            case 'user-info':
                this.updateUserInfo(data);
                break;
            case 'chat-message':
                this.addChatMessage(data);
                break;
            case 'request-canvas-sync':
                this.sendCanvasState(userId);
                break;
            case 'canvas-state':
                this.applyCanvasState(data);
                break;
            case 'cursor-position':
                this.updateRemoteCursor(data);
                break;
            default:
                // Assume it's drawing data
                this.handleRemoteDrawing(data);
                break;
        }
    }

    // Performance monitoring and adaptive optimization
    startPerformanceMonitoring() {
        setInterval(() => {
            this.updatePerformanceStats();
            this.optimizeBasedOnPerformance();
        }, 5000);
    }

    updatePerformanceStats() {
        const now = Date.now();
        const timeDiff = now - this.stats.lastStatsReset;
        
        if (timeDiff >= 1000) {
            this.stats.messagesPerSecond = (this.stats.messageCount * 1000) / timeDiff;
            this.stats.messageCount = 0;
            this.stats.lastStatsReset = now;
            
            // Calculate average latency
            if (this.stats.latencySamples.length > 0) {
                this.stats.averageLatency = this.stats.latencySamples.reduce((a, b) => a + b, 0) / this.stats.latencySamples.length;
                this.stats.latencySamples = [];
            }
        }
    }

    updateStats(type, count = 1) {
        this.stats.messageCount += count;
    }

    updateLatencyStats(latency) {
        this.stats.latencySamples.push(latency);
        if (this.stats.latencySamples.length > 10) {
            this.stats.latencySamples.shift();
        }
    }

    optimizeBasedOnPerformance() {
        // Adaptive optimization based on performance metrics
        if (this.stats.averageLatency > 200) {
            // High latency: reduce update frequency
            this.bufferDelay = Math.max(100, this.bufferDelay * 1.2);
        } else if (this.stats.averageLatency < 50) {
            // Low latency: increase update frequency
            this.bufferDelay = Math.min(16, this.bufferDelay * 0.8);
        }
    }

    // Connection quality monitoring
    startConnectionMonitoring(userId, peerConnection) {
        const monitorInterval = setInterval(async () => {
            if (peerConnection.connectionState !== 'connected') {
                clearInterval(monitorInterval);
                return;
            }
            
            try {
                const stats = await peerConnection.getStats();
                this.updateConnectionQuality(userId, stats);
            } catch (error) {
                console.error('Error getting connection stats:', error);
            }
        }, 5000);
    }

    updateConnectionQuality(userId, stats) {
        const quality = this.connectionQuality.get(userId);
        if (!quality) return;
        
        stats.forEach(report => {
            if (report.type === 'inbound-rtp') {
                quality.packetsLost = report.packetsLost || 0;
                quality.jitter = report.jitter || 0;
            } else if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                quality.roundTripTime = report.currentRoundTripTime || 0;
            }
        });
        
        quality.lastUpdate = Date.now();
    }

    // Heartbeat for connection monitoring
    startHeartbeat() {
        this.pingInterval = setInterval(() => {
            if (this.socket && this.socket.connected) {
                this.lastPingTime = Date.now();
                this.socket.emit('ping');
            }
        }, 30000); // Ping every 30 seconds
    }

    stopHeartbeat() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    // ICE restart for failed connections
    async restartICE(userId, peerConnection) {
        try {
            console.log(`Restarting ICE for ${userId}`);
            const offer = await peerConnection.createOffer({ iceRestart: true });
            await peerConnection.setLocalDescription(offer);
            
            this.sendWebRTCSignal(userId, {
                type: 'offer',
                offer: offer
            });
        } catch (error) {
            console.error('Error restarting ICE:', error);
            this.removePeer(userId);
        }
    }

    handlePeerDisconnection(userId) {
        console.log(`Peer ${userId} disconnected`);
        this.removePeer(userId);
        
        // Try to reconnect after a delay
        setTimeout(() => {
            if (this.connectedUsers.has(userId)) {
                this.createPeerConnection(userId, true);
            }
        }, 2000);
    }

    removePeer(userId) {
        const peerConnection = this.peers.get(userId);
        if (peerConnection) {
            peerConnection.close();
            this.peers.delete(userId);
        }
        
        const dataChannel = this.dataChannels.get(userId);
        if (dataChannel) {
            dataChannel.close();
            this.dataChannels.delete(userId);
        }
        
        this.connectionQuality.delete(userId);
    }

    // Enhanced chat with better error handling
    sendChatMessage() {
        const chatInput = document.getElementById('chatInput');
        if (!chatInput) return;
        
        const message = chatInput.value.trim();
        if (message === '') return;
        
        const sanitizedMessage = this.sanitizeInput(message);
        const chatData = {
            type: 'chat-message',
            userId: this.userId,
            nickname: this.nickname,
            message: sanitizedMessage,
            timestamp: Date.now()
        };
        
        // Add to local chat immediately for better UX
        this.addChatMessage(chatData);
        
        // Send via WebSocket for reliability
        if (this.socket && this.socket.connected) {
            this.socket.emit('chat-message', { message: sanitizedMessage });
        }
        
        chatInput.value = '';
    }

    // Canvas state synchronization
    sendCanvasState(targetUserId) {
        try {
            const imageData = this.canvas.toDataURL('image/jpeg', 0.8); // Use JPEG for smaller size
            const data = {
                type: 'canvas-state',
                imageData: imageData,
                timestamp: Date.now()
            };
            
            if (targetUserId) {
                this.sendToPeer(targetUserId, data);
            } else {
                // Send to all peers
                this.dataChannels.forEach((channel, userId) => {
                    this.sendToPeer(userId, data);
                });
            }
        } catch (error) {
            console.error('Error sending canvas state:', error);
        }
    }

    applyCanvasState(data) {
        if (data.userId === this.userId) return;
        
        try {
            const img = new Image();
            img.onload = () => {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.ctx.drawImage(img, 0, 0, this.canvasWidth, this.canvasHeight);
            };
            img.onerror = () => {
                console.error('Failed to load canvas state image');
            };
            img.src = data.imageData;
        } catch (error) {
            console.error('Error applying canvas state:', error);
        }
    }

    // UI and Canvas methods (keeping existing functionality but optimized)
    initializeCanvas() {
        this.canvas.width = this.canvasWidth;
        this.canvas.height = this.canvasHeight;
        
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        // Mouse events
        this.canvas.addEventListener('mousedown', (e) => this.startDrawing(e));
        this.canvas.addEventListener('mousemove', (e) => {
            this.draw(e);
            this.sendCursorPosition(e);
        });
        this.canvas.addEventListener('mouseup', () => this.stopDrawing());
        this.canvas.addEventListener('mouseout', () => this.stopDrawing());
        
        // Touch events for mobile
        this.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const mouseEvent = new MouseEvent('mousedown', {
                clientX: touch.clientX,
                clientY: touch.clientY
            });
            this.canvas.dispatchEvent(mouseEvent);
        });
        
        this.canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const mouseEvent = new MouseEvent('mousemove', {
                clientX: touch.clientX,
                clientY: touch.clientY
            });
            this.canvas.dispatchEvent(mouseEvent);
        });
        
        this.canvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            const mouseEvent = new MouseEvent('mouseup', {});
            this.canvas.dispatchEvent(mouseEvent);
        });
    }

    getCanvasCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }

    startDrawing(e) {
        this.isDrawing = true;
        const coords = this.getCanvasCoordinates(e);
        
        this.ctx.beginPath();
        this.ctx.moveTo(coords.x, coords.y);
        this.currentPath = [{ x: coords.x, y: coords.y }];
        
        // Send start drawing event
        this.broadcastDrawing({
            type: 'start-drawing',
            x: coords.x,
            y: coords.y,
            normalizedX: coords.x / this.canvasWidth,
            normalizedY: coords.y / this.canvasHeight,
            color: this.currentColor,
            size: this.currentSize,
            userId: this.userId
        });
    }

    draw(e) {
        if (!this.isDrawing) return;
        
        const coords = this.getCanvasCoordinates(e);
        
        // Draw locally
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        this.ctx.lineTo(coords.x, coords.y);
        this.ctx.stroke();
        
        this.currentPath.push({ x: coords.x, y: coords.y });
        
        // Send drawing data
        this.broadcastDrawing({
            type: 'draw',
            x: coords.x,
            y: coords.y,
            normalizedX: coords.x / this.canvasWidth,
            normalizedY: coords.y / this.canvasHeight,
            color: this.currentColor,
            size: this.currentSize,
            userId: this.userId
        });
    }

    stopDrawing() {
        if (!this.isDrawing) return;
        
        this.isDrawing = false;
        
        // Send end drawing event
        this.broadcastDrawing({
            type: 'end-drawing',
            path: this.currentPath,
            color: this.currentColor,
            size: this.currentSize,
            userId: this.userId
        });
        
        this.currentPath = [];
        
        // Send canvas state to WebSocket for persistence
        if (this.socket && this.socket.connected) {
            this.socket.emit('canvas-state', {
                imageData: this.canvas.toDataURL('image/jpeg', 0.8)
            });
        }
    }

    handleRemoteDrawing(data) {
        if (data.userId === this.userId) return;
        
        const x = data.normalizedX !== undefined ? 
            data.normalizedX * this.canvasWidth : data.x;
        const y = data.normalizedY !== undefined ? 
            data.normalizedY * this.canvasHeight : data.y;
        
        this.ctx.strokeStyle = data.color || '#000000';
        this.ctx.lineWidth = data.size || 5;
        
        if (data.type === 'start-drawing') {
            this.ctx.beginPath();
            this.ctx.moveTo(x, y);
        } else if (data.type === 'draw') {
            this.ctx.lineTo(x, y);
            this.ctx.stroke();
        } else if (data.type === 'end-drawing') {
            // Optional: handle path completion
        }
    }

    sendCursorPosition(e) {
        // Throttle cursor position updates
        if (Date.now() - (this.lastCursorUpdate || 0) < 100) return;
        this.lastCursorUpdate = Date.now();
        
        const coords = this.getCanvasCoordinates(e);
        const data = {
            type: 'cursor-position',
            x: coords.x,
            y: coords.y,
            normalizedX: coords.x / this.canvasWidth,
            normalizedY: coords.y / this.canvasHeight,
            userId: this.userId
        };
        
        // Send via WebSocket (lower priority than drawing)
        if (this.socket && this.socket.connected) {
            this.socket.emit('cursor-position', data);
        }
    }

    updateRemoteCursor(data) {
        if (data.userId === this.userId) return;
        
        // Implement remote cursor visualization
        // This is optional but enhances user experience
    }

    // UI helper methods
    updateConnectionStatus(status) {
        const statusElement = document.getElementById('connectionStatus');
        if (statusElement) {
            statusElement.className = `chip ${status}`;
            statusElement.textContent = {
                'connecting': 'Connecting...',
                'connected': 'Connected',
                'disconnected': 'Disconnected',
                'error': 'Connection Error'
            }[status] || status;
        }
    }

    updateUserCount(count) {
        const userCountElement = document.getElementById('userCount');
        if (userCountElement) {
            userCountElement.textContent = `${count} user${count !== 1 ? 's' : ''} online`;
        }
    }

    updateUsersList() {
        const usersList = document.getElementById('usersList');
        if (!usersList) return;
        
        usersList.innerHTML = '';
        
        // Add self
        const selfItem = document.createElement('div');
        selfItem.className = 'user-item self';
        selfItem.innerHTML = `
            <span class="user-status online"></span>
            <span class="user-nickname">${this.nickname} (You)</span>
        `;
        usersList.appendChild(selfItem);
        
        // Add other users
        this.connectedUsers.forEach((user) => {
            const userItem = document.createElement('div');
            userItem.className = 'user-item';
            userItem.innerHTML = `
                <span class="user-status online"></span>
                <span class="user-nickname">${user.nickname}</span>
            `;
            usersList.appendChild(userItem);
        });
    }

    updateUserInfo(data) {
        this.connectedUsers.set(data.userId, {
            userId: data.userId,
            nickname: data.nickname,
            lastSeen: data.timestamp
        });
        this.updateUsersList();
    }

    handleMessageHistory(data) {
        data.messages.forEach(message => {
            this.addChatMessage(message);
        });
    }

    showNotification(message, type = 'info') {
        // Create and show a notification
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 3000);
    }

    sanitizeInput(input) {
        const div = document.createElement('div');
        div.textContent = input;
        return div.innerHTML;
    }

    // Initialize all the UI components (keeping existing methods)
    initializeControls() {
        // Color picker and controls initialization
        // (Keep existing implementation but add optimizations)
        this.setupColorPicker();
        this.setupBrushControls();
        this.setupToolButtons();
    }

    initializeUserInterface() {
        // User interface setup
        this.createUsersPanel();
    }

    initializeChat() {
        // Chat initialization
        this.createChatPanel();
        this.setupChatControls();
    }

    setupColorPicker() {
        // Implement color picker (existing code)
    }

    setupBrushControls() {
        // Implement brush controls (existing code)
    }

    setupToolButtons() {
        // Implement tool buttons (existing code)
    }

    createUsersPanel() {
        // Create users panel (existing code)
    }

    createChatPanel() {
        // Create chat panel (existing code)
        const chatPanel = document.createElement('div');
        chatPanel.id = 'chatPanel';
        chatPanel.className = 'panel chat-panel';
        chatPanel.innerHTML = `
            <div class="panel-header">
                <h3>Chat</h3>
            </div>
            <div id="chatMessages" class="chat-messages"></div>
            <div class="chat-input-container">
                <input type="text" id="chatInput" placeholder="Type a message..." maxlength="200">
                <button id="sendMessage" class="btn-small">Send</button>
            </div>
        `;
        document.body.appendChild(chatPanel);
    }

    setupChatControls() {
        const chatInput = document.getElementById('chatInput');
        const sendButton = document.getElementById('sendMessage');
        
        if (chatInput && sendButton) {
            sendButton.addEventListener('click', () => this.sendChatMessage());
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.sendChatMessage();
                }
            });
        }
    }

    addChatMessage(data) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;
        
        const messageElement = document.createElement('div');
        messageElement.className = 'chat-message';
        
        const time = new Date(data.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const isOwnMessage = data.userId === this.userId;
        
        messageElement.innerHTML = `
            <span class="chat-time">${time}</span>
            <span class="chat-nickname ${isOwnMessage ? 'own-message' : ''}">${data.nickname}:</span>
            <span class="chat-text">${data.message}</span>
        `;
        
        chatMessages.appendChild(messageElement);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        
        // Keep only last 50 messages
        while (chatMessages.children.length > 50) {
            chatMessages.removeChild(chatMessages.firstChild);
        }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new OptimizedCollaborativeCanvas();
});
