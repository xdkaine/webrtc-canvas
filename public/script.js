class OptimizedCollaborativeCanvas {
    constructor() {
        // Wait for DOM to be ready before accessing elements
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initialize());
        } else {
            this.initialize();
        }
    }
    
    initialize() {
        this.canvas = document.getElementById('drawingCanvas');
        if (!this.canvas) {
            console.error('Canvas element with ID "drawingCanvas" not found!');
            return;
        }
        
        this.ctx = this.canvas.getContext('2d');
        if (!this.ctx) {
            console.error('Could not get 2D context from canvas!');
            return;
        }
        
        console.log('Canvas found and context initialized');
        
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
        this.remoteDrawingStates = new Map(); // Track drawing state per user
        
        // Drawing state
        this.isDrawing = false;
        this.currentColor = '#000000'; // Black should be visible on white canvas
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
        this.canvasWidth = 1200;  // Match HTML canvas width
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
        
        // Initialize all the UI components
        this.initializeCanvas();
        this.initializeControls();
        this.initializeUserInterface();
        this.initializeChat();
        this.initializeWebSocket();
        this.initializeWebRTC();
        this.startPerformanceMonitoring();
        
        // Set initial drawing properties
        this.updateDrawingProperties();
    }

    generateUserId() {
        // Generate tab-specific user ID with timestamp for uniqueness
        const tabId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        return 'user_' + tabId;
    }

    getUserNickname() {
        // Always prompt for nickname in new tabs - no localStorage dependency
        // This ensures each tab can have its own unique nickname
        this.showNicknameModal();
        return 'Anonymous'; // Temporary until modal completes
    }

    generateRandomNickname() {
        const adjectives = [
            'Creative', 'Artistic', 'Talented', 'Skilled', 'Bold', 'Bright', 'Cool', 
            'Epic', 'Fast', 'Quick', 'Smart', 'Wise', 'Clever', 'Sharp', 'Swift',
            'Dynamic', 'Vibrant', 'Cosmic', 'Digital', 'Modern', 'Fresh', 'Sleek'
        ];
        const nouns = [
            'Artist', 'Painter', 'Designer', 'Creator', 'Drawer', 'Sketcher', 'Maker',
            'Brush', 'Pencil', 'Canvas', 'Pixel', 'Stroke', 'Line', 'Color', 'Shade',
            'Star', 'Wave', 'Storm', 'Fire', 'Lightning', 'Thunder', 'Phoenix'
        ];
        
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        const num = Math.floor(Math.random() * 99) + 1;
        
        return `${adj}${noun}${num}`;
    }

    showNicknameModal() {
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'nicknameModal';
        modalOverlay.className = 'modal-overlay';
        modalOverlay.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Welcome to Collaborative Canvas!</h3>
                    <p>Choose your nickname for this tab</p>
                </div>
                <div class="modal-body">
                    <input type="text" id="nicknameInput" class="nickname-input" 
                           placeholder="Enter your nickname" maxlength="20" autocomplete="off">
                    <p class="modal-hint">Each tab can have a different name!</p>
                </div>
                <div class="modal-footer">
                    <button id="nicknameRandomize" class="btn-secondary">Random Name</button>
                    <button id="nicknameConfirm" class="btn-primary">Join Canvas</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modalOverlay);
        
        const input = document.getElementById('nicknameInput');
        input.focus();
        
        // Generate a fun random name suggestion
        const randomName = this.generateRandomNickname();
        input.placeholder = `e.g., ${randomName}`;
        
        const handleSubmit = () => {
            const inputValue = input.value.trim();
            let finalNickname = 'Anonymous';
            
            if (inputValue !== '') {
                finalNickname = this.sanitizeInput(inputValue).substring(0, 20);
            } else {
                // If empty, use a random name
                finalNickname = randomName;
            }
            
            this.nickname = finalNickname;
            // Don't store in localStorage - keep it tab-specific
            
            document.body.removeChild(modalOverlay);
            
            // Connect after nickname is set
            if (this.socket && this.socket.connected) {
                this.joinSession();
            }
        };
        
        document.getElementById('nicknameConfirm').addEventListener('click', handleSubmit);
        document.getElementById('nicknameRandomize').addEventListener('click', () => {
            const newRandomName = this.generateRandomNickname();
            input.value = newRandomName;
            input.focus();
        });
        
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleSubmit();
            }
        });
    }

    showChangeNicknameModal() {
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'changeNicknameModal';
        modalOverlay.className = 'modal-overlay';
        modalOverlay.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Change Your Nickname</h3>
                    <p>Update your name for this tab</p>
                </div>
                <div class="modal-body">
                    <input type="text" id="changeNicknameInput" class="nickname-input" 
                           value="${this.nickname}" maxlength="20" autocomplete="off">
                    <p class="modal-hint">Your new nickname will be visible to others immediately</p>
                </div>
                <div class="modal-footer">
                    <button id="changeNicknameCancel" class="btn-secondary">Cancel</button>
                    <button id="changeNicknameConfirm" class="btn-primary">Update</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modalOverlay);
        
        const input = document.getElementById('changeNicknameInput');
        input.focus();
        input.select(); // Select current text for easy replacement
        
        const handleUpdate = () => {
            const inputValue = input.value.trim();
            let newNickname = 'Anonymous';
            
            if (inputValue !== '') {
                newNickname = this.sanitizeInput(inputValue).substring(0, 20);
            }
            
            if (newNickname !== this.nickname) {
                const oldNickname = this.nickname;
                this.nickname = newNickname;
                
                // Update the UI immediately
                this.updateUsersList();
                
                // Notify other users about the nickname change
                if (this.socket && this.socket.connected) {
                    this.socket.emit('user-info-update', {
                        userId: this.userId,
                        nickname: this.nickname,
                        timestamp: Date.now()
                    });
                }
                
                this.showNotification(`Nickname changed from "${oldNickname}" to "${newNickname}"`, 'success');
            }
            
            document.body.removeChild(modalOverlay);
        };
        
        document.getElementById('changeNicknameConfirm').addEventListener('click', handleUpdate);
        document.getElementById('changeNicknameCancel').addEventListener('click', () => {
            document.body.removeChild(modalOverlay);
        });
        
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleUpdate();
            } else if (e.key === 'Escape') {
                document.body.removeChild(modalOverlay);
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
            // Only add chat message if it's not from this user (to prevent duplicates)
            if (data.userId !== this.userId) {
                this.addChatMessage(data);
            }
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

        this.socket.on('user-info-update', (data) => {
            this.handleUserInfoUpdate(data);
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

    handleUserInfoUpdate(data) {
        if (data.userId !== this.userId && this.connectedUsers.has(data.userId)) {
            const user = this.connectedUsers.get(data.userId);
            const oldNickname = user.nickname;
            
            // Update user info
            user.nickname = data.nickname;
            user.lastSeen = data.timestamp;
            
            // Update the UI
            this.updateUsersList();
            
            // Update cursor label for this user
            this.updateCursorLabel(data.userId, data.nickname);
            
            // Show notification about nickname change
            this.showNotification(`${oldNickname} is now known as ${data.nickname}`, 'info');
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

            // Create data channel with optimized settings for drawing
            if (isInitiator) {
                const dataChannel = peerConnection.createDataChannel('collaborative-canvas', {
                    ordered: true, // Ensure drawing events arrive in order
                    maxRetransmits: 3, // Allow some retransmission for reliability
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
        // For real-time drawing, send immediately instead of buffering
        if (data.type === 'start-drawing' || data.type === 'draw' || data.type === 'end-drawing') {
            this.sendDrawingDataImmediately(data);
            return;
        }
        
        // Add to buffer for non-drawing events (like clear-canvas)
        this.drawingBuffer.push({
            ...data,
            timestamp: Date.now()
        });
        
        // Clear existing timer and set new one for adaptive batching
        if (this.bufferTimers.drawing) {
            clearTimeout(this.bufferTimers.drawing);
        }
        
        this.bufferTimers.drawing = setTimeout(() => {
            this.flushDrawingBuffer();
        }, 50);
    }

    sendDrawingDataImmediately(data) {
        const dataWithTimestamp = {
            ...data,
            timestamp: Date.now()
        };

        // Send via WebRTC first (lower latency)
        let sentViaWebRTC = false;
        this.dataChannels.forEach((channel, userId) => {
            if (channel.readyState === 'open') {
                this.sendToPeer(userId, dataWithTimestamp);
                sentViaWebRTC = true;
            }
        });
        
        // Fallback to WebSocket for users without WebRTC
        if (!sentViaWebRTC || this.dataChannels.size === 0) {
            if (this.socket && this.socket.connected) {
                this.socket.emit('drawing-data', dataWithTimestamp);
            }
        }
        
        this.updateStats('messages', 1);
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
                // Only add chat message if it's not from this user (to prevent duplicates)
                if (data.userId !== this.userId) {
                    this.addChatMessage(data);
                }
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
        
        // Remove user's cursor
        const cursor = this.remoteCursors.get(userId);
        if (cursor) {
            cursor.remove();
            this.remoteCursors.delete(userId);
        }
        
        this.connectionQuality.delete(userId);
        this.remoteDrawingStates.delete(userId); // Clean up drawing state
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
        // Ensure canvas element exists
        if (!this.canvas) {
            console.error('Canvas element not found!');
            return;
        }
        
        console.log('Initializing canvas:', this.canvas.width, 'x', this.canvas.height);
        
        this.canvas.width = this.canvasWidth;
        this.canvas.height = this.canvasHeight;
        
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        
        console.log('Canvas context initialized with color:', this.currentColor, 'size:', this.currentSize);
        
        // Test drawing to verify canvas is working
        this.ctx.strokeStyle = '#ff0000'; // Red test line
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.moveTo(50, 50);
        this.ctx.lineTo(150, 150);
        this.ctx.stroke();
        console.log('Test line drawn from (50,50) to (150,150)');
        
        // Reset to default style
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        
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
        
        console.log('Start drawing at:', coords);
        
        // Set drawing properties
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
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
        
        // Set drawing properties again to ensure they're correct
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        // Draw locally
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
        
        // Handle clear canvas command
        if (data.type === 'clear-canvas') {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            // Clear all remote drawing states
            this.remoteDrawingStates.clear();
            return;
        }
        
        // Handle fill background command
        if (data.type === 'fill-background') {
            this.ctx.fillStyle = data.color;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            return;
        }
        
        const x = data.normalizedX !== undefined ? 
            data.normalizedX * this.canvasWidth : data.x;
        const y = data.normalizedY !== undefined ? 
            data.normalizedY * this.canvasHeight : data.y;
        
        // Get or create drawing state for this user
        let userDrawingState = this.remoteDrawingStates.get(data.userId);
        if (!userDrawingState) {
            userDrawingState = {
                isDrawing: false,
                lastX: 0,
                lastY: 0,
                color: data.color || '#000000',
                size: data.size || 5
            };
            this.remoteDrawingStates.set(data.userId, userDrawingState);
        }
        
        // Set drawing properties
        this.ctx.strokeStyle = data.color || userDrawingState.color;
        this.ctx.lineWidth = data.size || userDrawingState.size;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        if (data.type === 'start-drawing') {
            userDrawingState.isDrawing = true;
            userDrawingState.lastX = x;
            userDrawingState.lastY = y;
            userDrawingState.color = data.color || '#000000';
            userDrawingState.size = data.size || 5;
            
            this.ctx.beginPath();
            this.ctx.moveTo(x, y);
            
        } else if (data.type === 'draw' && userDrawingState.isDrawing) {
            // Draw a continuous line from last position to current position
            this.ctx.beginPath();
            this.ctx.moveTo(userDrawingState.lastX, userDrawingState.lastY);
            this.ctx.lineTo(x, y);
            this.ctx.stroke();
            
            // Update last position
            userDrawingState.lastX = x;
            userDrawingState.lastY = y;
            
        } else if (data.type === 'end-drawing') {
            userDrawingState.isDrawing = false;
        }
    }

    sendCursorPosition(e) {
        // Throttle cursor position updates
        if (Date.now() - (this.lastCursorUpdate || 0) < 100) return;
        this.lastCursorUpdate = Date.now();
        
        const coords = this.getCanvasCoordinates(e);
        const data = {
            type: 'cursor-position',
            userId: this.userId,
            nickname: this.nickname,
            x: coords.x,
            y: coords.y,
            normalizedX: coords.x / this.canvasWidth,
            normalizedY: coords.y / this.canvasHeight,
            isDrawing: this.isDrawing,
            color: this.currentColor,
            size: this.currentSize,
            timestamp: Date.now()
        };
        
        // Send via WebSocket (lower priority than drawing)
        if (this.socket && this.socket.connected) {
            this.socket.emit('cursor-position', data);
        }
    }

    updateRemoteCursor(data) {
        if (data.userId === this.userId) return;
        
        const rect = this.canvas.getBoundingClientRect();
        const x = data.normalizedX * rect.width + rect.left;
        const y = data.normalizedY * rect.height + rect.top;
        
        let cursor = this.remoteCursors.get(data.userId);
        if (!cursor) {
            cursor = this.createRemoteCursor(data.userId, data.nickname);
            this.remoteCursors.set(data.userId, cursor);
        }
        
        // Update cursor position
        cursor.style.left = `${x}px`;
        cursor.style.top = `${y}px`;
        cursor.style.display = 'block';
        
        // Update cursor appearance based on drawing state
        const cursorDot = cursor.querySelector('.cursor-dot');
        if (cursorDot) {
            cursorDot.style.backgroundColor = data.color;
            cursorDot.style.width = `${Math.max(8, Math.min(20, data.size))}px`;
            cursorDot.style.height = `${Math.max(8, Math.min(20, data.size))}px`;
            cursorDot.style.opacity = data.isDrawing ? '0.8' : '0.5';
        }
        
        // Update cursor label if nickname has changed
        if (data.nickname) {
            const cursorLabel = cursor.querySelector('.cursor-label');
            if (cursorLabel && cursorLabel.textContent !== data.nickname) {
                cursorLabel.textContent = data.nickname;
            }
        }
        
        // Hide cursor after inactivity
        clearTimeout(cursor.hideTimeout);
        cursor.hideTimeout = setTimeout(() => {
            cursor.style.display = 'none';
        }, 2000);
    }

    createRemoteCursor(userId, nickname) {
        const cursor = document.createElement('div');
        cursor.className = 'remote-cursor';
        cursor.id = `cursor-${userId}`;
        cursor.style.cssText = `
            position: fixed;
            pointer-events: none;
            z-index: 1000;
            display: none;
        `;
        
        cursor.innerHTML = `
            <div class="cursor-dot" style="
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background-color: #000;
                margin-bottom: 2px;
            "></div>
            <div class="cursor-label" style="
                background: rgba(0,0,0,0.8);
                color: white;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 11px;
                white-space: nowrap;
            ">${nickname}</div>
        `;
        
        document.body.appendChild(cursor);
        return cursor;
    }

    updateCursorLabel(userId, newNickname) {
        const cursor = this.remoteCursors.get(userId);
        if (cursor) {
            const cursorLabel = cursor.querySelector('.cursor-label');
            if (cursorLabel) {
                cursorLabel.textContent = newNickname;
            }
        }
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
        
        // Calculate and update user count
        const totalUsers = this.connectedUsers.size + 1; // +1 for self
        this.updateUserCount(totalUsers);
        
        // Add self with change nickname option
        const selfItem = document.createElement('div');
        selfItem.className = 'user-item self';
        selfItem.innerHTML = `
            <span class="user-status online"></span>
            <span class="user-nickname">${this.nickname} (You)</span>
            <button class="change-nickname-btn" title="Change your nickname">✏️</button>
        `;
        
        // Add click handler for nickname change
        const changeBtn = selfItem.querySelector('.change-nickname-btn');
        changeBtn.addEventListener('click', () => {
            this.showChangeNicknameModal();
        });
        
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

    // Initialize all the UI components
    initializeControls() {
        this.setupColorPicker();
        this.setupBrushControls();
        this.setupToolButtons();
    }

    initializeUserInterface() {
        this.createCursorsContainer();
    }

    initializeChat() {
        this.createChatPanel();
        this.setupChatControls();
    }

    setupColorPicker() {
        const colorPicker = document.getElementById('colorPicker');
        const colorTrigger = document.getElementById('colorTrigger');
        const colorHexLabel = document.getElementById('colorHexLabel');
        
        if (colorTrigger) {
            colorTrigger.addEventListener('click', () => {
                // Toggle color picker popover
                const popover = document.getElementById('colorPopover');
                if (popover) {
                    popover.hidden = !popover.hidden;
                }
            });
        }
        
        // Color swatches
        const swatches = document.querySelectorAll('.swatch');
        swatches.forEach(swatch => {
            swatch.addEventListener('click', () => {
                const color = swatch.dataset.color;
                this.currentColor = color;
                this.updateColorDisplay(color);
                this.updateDrawingProperties();
                console.log('Color changed to:', color);
            });
        });
    }

    setupBrushControls() {
        const brushSize = document.getElementById('brushSize');
        const sizeLabel = document.getElementById('sizeLabel');
        
        if (brushSize) {
            brushSize.addEventListener('input', (e) => {
                this.currentSize = parseInt(e.target.value);
                if (sizeLabel) {
                    sizeLabel.textContent = this.currentSize;
                }
            });
        }
    }

    setupToolButtons() {
        const clearBtn = document.getElementById('clearCanvas');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.clearCanvas();
            });
        }
        
        const paintBucketBtn = document.getElementById('paintBucket');
        if (paintBucketBtn) {
            paintBucketBtn.addEventListener('click', () => {
                this.fillCanvasBackground();
            });
        }
    }

    updateColorDisplay(color) {
        const colorHexLabel = document.getElementById('colorHexLabel');
        const colorTrigger = document.getElementById('colorTrigger');
        
        if (colorHexLabel) {
            colorHexLabel.textContent = color;
        }
        
        if (colorTrigger) {
            const dot = colorTrigger.querySelector('.trigger-dot');
            if (dot) {
                dot.style.setProperty('--c', color);
            }
        }
    }

    updateDrawingProperties() {
        if (this.ctx) {
            this.ctx.strokeStyle = this.currentColor;
            this.ctx.lineWidth = this.currentSize;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            console.log('Drawing properties updated - Color:', this.currentColor, 'Size:', this.currentSize);
        }
    }

    clearCanvas() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Broadcast clear event
        this.broadcastDrawing({
            type: 'clear-canvas',
            userId: this.userId
        });
    }

    fillCanvasBackground() {
        // Fill the canvas with the current selected color
        this.ctx.fillStyle = this.currentColor;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Broadcast fill background event
        this.broadcastDrawing({
            type: 'fill-background',
            color: this.currentColor,
            userId: this.userId
        });
    }

    createCursorsContainer() {
        const cursorsContainer = document.createElement('div');
        cursorsContainer.id = 'cursorsContainer';
        cursorsContainer.className = 'cursors-container';
        cursorsContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 10;
        `;
        document.body.appendChild(cursorsContainer);
    }

    createChatPanel() {
        // Create collapsible chat panel with users list
        const chatPanel = document.createElement('div');
        chatPanel.id = 'chatPanel';
        chatPanel.className = 'panel chat-panel collapsible';
        chatPanel.innerHTML = `
            <div class="panel-header clickable" id="chatPanelHeader">
                <h3>💬 Chat & Users</h3>
                <button class="collapse-btn" id="chatCollapseBtn" title="Toggle chat">▼</button>
            </div>
            <div class="panel-content" id="chatPanelContent">
                <div class="chat-tabs">
                    <button class="tab-btn active" data-tab="chat">Chat</button>
                    <button class="tab-btn" data-tab="users">Users Online</button>
                </div>
                <div class="tab-content" id="chatTab">
                    <div id="chatMessages" class="chat-messages"></div>
                    <div class="chat-input-container">
                        <input type="text" id="chatInput" placeholder="Type a message..." maxlength="200">
                        <button id="sendMessage" class="btn-small">Send</button>
                    </div>
                </div>
                <div class="tab-content hidden" id="usersTab">
                    <div id="usersList" class="users-list"></div>
                </div>
            </div>
        `;
        document.body.appendChild(chatPanel);
        
        // Add collapse functionality
        this.setupChatCollapse();
        // Add tab switching functionality
        this.setupChatTabs();
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

    setupChatCollapse() {
        const chatPanel = document.getElementById('chatPanel');
        const chatHeader = document.getElementById('chatPanelHeader');
        const chatContent = document.getElementById('chatPanelContent');
        const collapseBtn = document.getElementById('chatCollapseBtn');
        
        if (chatHeader && chatContent && collapseBtn && chatPanel) {
            chatHeader.addEventListener('click', () => {
                const isCollapsed = chatContent.classList.contains('collapsed');
                if (isCollapsed) {
                    chatContent.classList.remove('collapsed');
                    chatPanel.classList.remove('collapsed');
                    collapseBtn.textContent = '▼';
                } else {
                    chatContent.classList.add('collapsed');
                    chatPanel.classList.add('collapsed');
                    collapseBtn.textContent = '▶';
                }
            });
        }
    }

    setupChatTabs() {
        const tabButtons = document.querySelectorAll('.tab-btn');
        const chatTab = document.getElementById('chatTab');
        const usersTab = document.getElementById('usersTab');
        
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tabType = btn.dataset.tab;
                
                // Update active tab button
                tabButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                // Show/hide appropriate content
                if (tabType === 'chat') {
                    chatTab.classList.remove('hidden');
                    usersTab.classList.add('hidden');
                } else if (tabType === 'users') {
                    chatTab.classList.add('hidden');
                    usersTab.classList.remove('hidden');
                    // Update users list when switching to users tab
                    this.updateUsersList();
                }
            });
        });
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

// Initialize the application
new OptimizedCollaborativeCanvas();
