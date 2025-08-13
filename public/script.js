class OptimizedCollaborativeCanvas {
    constructor() {
        // gotta wait for the page to load first
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
        
        // browser detection for performance optimizations
        this.isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
        this.isChrome = navigator.userAgent.toLowerCase().includes('chrome');
        this.isSafari = navigator.userAgent.toLowerCase().includes('safari') && !this.isChrome;
        
        console.log('Browser detected:', {
            firefox: this.isFirefox,
            chrome: this.isChrome,
            safari: this.isSafari
        });
        
        // Firefox-specific optimizations for animation frames
        if (this.isFirefox) {
            this.setupFirefoxOptimizations();
        }
        
        // all the networking stuff
        this.peers = new Map();
        this.dataChannels = new Map();
        this.socket = null;
        this.connectionQuality = new Map(); // keeping track of how good connections are
        
        // user stuff - keeping it simple with just one canvas
        this.userId = this.generateUserId();
        this.nickname = null; // gets set when user enters name
        this.isAnonymousMode = false; // for people just browsing
        this.connectedUsers = new Map();
        this.remoteCursors = new Map();
        this.remoteDrawingStates = new Map(); // what everyone else is drawing
        this.sessionJoinTime = null; // when did we join this mess
        
        // drawing stuff
        this.isDrawing = false;
        this.currentColor = '#000000'; // starting with black
        this.currentSize = 5;
        this.currentPath = [];
        this.clientSequence = 0; // for keeping drawings in order
        this.lastServerSequence = 0; // server validation stuff
        this.currentStrokeId = null; // current stroke tracking
        this.unreadCount = 0; // chat badge counter
        
        // performance stuff - trying to keep it smooth
        // Firefox benefits from reduced throttling due to different event timing
        this.drawThrottleMs = this.isFirefox ? 8 : 16; // Firefox: 125fps, others: 60fps
        this.lastDrawTime = 0;
        this.pendingDrawData = null;
        
        // buffering to batch messages
        this.drawingBuffer = [];
        this.chatBuffer = [];
        this.bufferTimers = {
            drawing: null,
            chat: null
        };
        
        // canvas size - made it bigger after user feedback
        this.canvasWidth = 2000;  
        this.canvasHeight = 1200; 
        
        // keeping track of performance 
        this.stats = {
            messagesPerSecond: 0,
            messageCount: 0,
            lastStatsReset: Date.now(),
            averageLatency: 0,
            latencySamples: []
        };
        
        // throttling drawing for smoother experience
        this.lastDrawTime = 0;
        this.drawThrottleMs = this.isFirefox ? 8 : 16; // Firefox needs less throttling
        this.pendingDrawData = null;
        
        // connection tracking
        this.connectionState = 'disconnected';
        this.lastPingTime = 0;
        this.pingInterval = null;
        
        // auto-save stuff
        this.autoSaveInterval = null;
        this.lastCanvasSave = 0;
        
        // setting everything up
        this.initializeCanvas();
        this.addCanvasBlur(); // start with blur effect
        this.disableDrawingControls(); // no touching until you join
        this.initializeControls();
        this.initializeUserInterface();
        this.initializeChat();
        this.initializeCanvasPanning();
        this.initializeThemeSystem();
        
        // setting up drawing defaults
        this.updateDrawingProperties();
        
        // make sure color shows as black
        this.updateColorDisplay(this.currentColor);
        
        // brush preview setup
        this.updateBrushPreview();
        
        // start getting drawing data right away so people can see preview
        this.initializeWebSocketForBrowsing();

        // show the name modal once everything's ready
        requestAnimationFrame(() => {
            // fade out loading screen
            const loader = document.getElementById('initialLoader');
            const mainApp = document.getElementById('mainApp');
            
            if (loader) {
                loader.style.opacity = '0';
                setTimeout(() => {
                    loader.style.display = 'none';
                    if (mainApp) {
                        mainApp.style.display = 'grid';
                        // tiny delay for smooth transition
                        setTimeout(() => {
                            this.showNicknameModal();
                        }, 100);
                    }
                }, 300);
            } else {
                this.showNicknameModal();
            }
        });
    }

    generateUserId() {
        // make a unique ID for this browser tab
        const tabId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        return 'user_' + tabId;
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
        // Create modal with minimal DOM operations for better performance
        const fragment = document.createDocumentFragment();
        
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'nicknameModal';
        modalOverlay.className = 'modal-overlay';
        
        modalOverlay.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Welcome to Collaborative Canvas!</h3>
                    <p>Please enter your name to join the canvas and start drawing</p>
                </div>
                <div class="modal-body">
                    <input type="text" id="nicknameInput" class="nickname-input" 
                           placeholder="Enter your name" maxlength="20" autocomplete="off" required>
                    <p class="modal-hint">Your name will be visible to all other users on the canvas</p>
                </div>
                <div class="modal-footer">
                    <button id="nicknameConfirm" class="btn-primary" disabled>Join Canvas</button>
                    <button id="browseAnonymously" class="btn-secondary">Browse Anonymously</button>
                </div>
            </div>
        `;
        
        fragment.appendChild(modalOverlay);
        document.body.appendChild(fragment);
        
        const input = document.getElementById('nicknameInput');
        const confirmBtn = document.getElementById('nicknameConfirm');
        
        // get cursor in there right away
        input.focus();
        
        // update button as user types, but don't hammer it
        let inputTimeout;
        let lastValue = '';
        
        const updateButton = (value) => {
            const trimmedValue = value.trim();
            const isValid = trimmedValue.length > 0;
            
            if (confirmBtn.disabled === isValid) {
                confirmBtn.disabled = !isValid;
            }
            
            const newText = isValid ? `Join as "${trimmedValue}"` : 'Join Canvas';
            if (confirmBtn.textContent !== newText) {
                confirmBtn.textContent = newText;
            }
        };
        
        input.addEventListener('input', (e) => {
            const currentValue = e.target.value;
            
            if (currentValue === lastValue) return;
            lastValue = currentValue;
            
            clearTimeout(inputTimeout);
            inputTimeout = setTimeout(() => {
                updateButton(currentValue);
            }, 50); // quick but not too quick
        });
        
        const handleSubmit = () => {
            const inputValue = input.value.trim();
            
            if (inputValue === '') {
                input.focus();
                return;
            }
            
            this.nickname = this.sanitizeInput(inputValue).substring(0, 20);
            this.isAnonymousMode = false; // joining properly now
            document.body.removeChild(modalOverlay);
            
            // turn off blur, enable everything, show chat
            this.removeCanvasBlur();
            this.enableDrawingControls();
            this.showChatBubble();
            
            // we might already be connected from browsing mode
            if (this.socket && this.socket.connected) {
                // already connected, just need to upgrade to full member
                this.addFullSessionEventHandlers();
                this.joinSession();
                this.initializeWebRTC();
            } else {
                // fresh start
                this.initializeWebSocket();
                this.initializeWebRTC();
            }
            
            this.startPerformanceMonitoring();
            this.startAutoSave();
        };
        
        const browseAnonymouslyBtn = document.getElementById('browseAnonymously');
        
        const handleBrowseAnonymously = () => {
            this.nickname = null; // just watching
            this.isAnonymousMode = true; // viewer mode
            document.body.removeChild(modalOverlay);
            
            // turn off blur but leave controls disabled
            this.removeCanvasBlur();
            // drawing stays disabled for anonymous people
            
            // already connected for browsing from init
            console.log('staying in browse mode');
        };
        
        confirmBtn.addEventListener('click', handleSubmit);
        browseAnonymouslyBtn.addEventListener('click', handleBrowseAnonymously);
        
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !confirmBtn.disabled) {
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
                    <p class="modal-hint">your new name shows up right away</p>
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
        input.select(); // highlight current text so they can type over it
        
        const handleUpdate = () => {
            const inputValue = input.value.trim();
            let newNickname = 'Anonymous';
            
            if (inputValue !== '') {
                newNickname = this.sanitizeInput(inputValue).substring(0, 20);
            } else {
                // can't have empty names
                input.focus();
                return;
            }
            
            if (newNickname !== this.nickname) {
                const oldNickname = this.nickname;
                this.nickname = newNickname;
                
                // update everything right away
                this.updateUsersList();
                
                // tell everyone about the change
                if (this.socket && this.socket.connected) {
                    this.socket.emit('user-info-update', {
                        userId: this.userId,
                        nickname: this.nickname,
                        timestamp: Date.now()
                    });
                }
                
                this.showNotification(`changed from "${oldNickname}" to "${newNickname}"`, 'success');
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

    // socket connection setup with retry logic
    initializeWebSocket() {
        try {
            // start up socket.io with good settings
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
            console.error('socket setup went wrong:', error);
            this.updateConnectionStatus('error');
        }
    }

    // lighter connection just for watching
    initializeWebSocketForBrowsing() {
        try {
            // socket.io setup but simpler
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

            this.setupSocketEventHandlersForBrowsing();
        } catch (error) {
            console.error('browsing socket failed:', error);
            this.updateConnectionStatus('error');
        }
    }

    setupSocketEventHandlers() {
        // when we connect
        this.socket.on('connect', () => {
            console.log('connected to server');
            this.connectionState = 'connected';
            this.updateConnectionStatus('connected');
            this.startHeartbeat();
            this.joinSession();
        });

        this.socket.on('disconnect', (reason) => {
            console.log('got disconnected:', reason);
            this.connectionState = 'disconnected';
            this.updateConnectionStatus('disconnected');
            this.stopHeartbeat();
        });

        this.socket.on('reconnect', (attemptNumber) => {
            console.log('back online after', attemptNumber, 'attempts');
            this.connectionState = 'connected';
            this.updateConnectionStatus('connected');
            this.joinSession();
        });

        this.socket.on('connect_error', (error) => {
            console.error('connection screwed up:', error);
            this.connectionState = 'error';
            this.updateConnectionStatus('error');
        });

        // session stuff
        this.socket.on('session-joined', (data) => {
            console.log('we\'re in:', data);
            this.handleSessionJoined(data);
        });

        this.socket.on('user-joined', (data) => {
            console.log('someone joined:', data);
            this.handleUserJoined(data);
        });

        this.socket.on('user-left', (data) => {
            console.log('someone left:', data);
            this.handleUserLeft(data);
        });

        // webrtc handshake stuff
        this.socket.on('webrtc-signal', (data) => {
            this.handleWebRTCSignal(data);
        });

        // drawing data coming in
        this.socket.on('drawing-data', (data) => {
            this.handleRemoteDrawing(data);
        });

        this.socket.on('drawing-correction', (data) => {
            this.handleDrawingCorrection(data);
        });

        this.socket.on('chat-message', (data) => {
            // don't show our own messages twice
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

        this.socket.on('drawing-history', (data) => {
            this.handleDrawingHistory(data);
        });

        this.socket.on('cursor-position', (data) => {
            this.updateRemoteCursor(data);
        });

        this.socket.on('user-info-update', (data) => {
            this.handleUserInfoUpdate(data);
        });

        // keep alive ping pong
        this.socket.on('pong', () => {
            if (this.lastPingTime > 0) {
                const latency = Date.now() - this.lastPingTime;
                this.updateLatencyStats(latency);
            }
        });

        // when things go wrong
        this.socket.on('error', (error) => {
            console.error('socket error:', error);
            if (error.message) {
                this.showNotification(error.message, 'error');
            }
        });
    }

    // simplified handlers for just watching
    setupSocketEventHandlersForBrowsing() {
        // connection stuff
        this.socket.on('connect', () => {
            console.log('connected for browsing');
            this.updateConnectionStatus('connected');
            // tell server we're just watching
            this.socket.emit('anonymous-browse');
        });

        this.socket.on('disconnect', () => {
            console.log('disconnected while browsing');
            this.updateConnectionStatus('disconnected');
        });

        // just receive drawing data
        this.socket.on('drawing-data', (data) => {
            this.handleRemoteDrawing(data.data);
        });

        // canvas updates
        this.socket.on('canvas-state', (data) => {
            this.applyCanvasState(data);
        });

        this.socket.on('canvasCleared', () => {
            this.clearCanvas();
        });

        // server confirms we're browsing
        this.socket.on('anonymous-browse-confirmed', () => {
            console.log('browse mode confirmed');
            // server will send us canvas state
        });

        // errors while browsing
        this.socket.on('error', (error) => {
            console.error('socket error while browsing:', error);
        });
    }

    // upgrade from browse mode to full member
    addFullSessionEventHandlers() {
        if (!this.socket) return;
        
        console.log('adding full session handlers...');
        
        // session management
        this.socket.on('session-joined', (data) => {
            console.log('we joined the session:', data);
            this.handleSessionJoined(data);
        });

        this.socket.on('user-joined', (data) => {
            console.log('someone else joined:', data);
            this.handleUserJoined(data);
        });

        this.socket.on('user-left', (data) => {
            console.log('someone left:', data);
            this.handleUserLeft(data);
        });

        this.socket.on('user-info-update', (data) => {
            this.handleUserInfoUpdate(data);
        });

        this.socket.on('chat-message', (data) => {
            this.addChatMessage(data);
        });

        this.socket.on('webrtc-signal', (data) => {
            this.handleWebRTCSignal(data);
        });

        this.socket.on('cursor-position', (data) => {
            this.updateRemoteCursor(data);
        });

        // ping pong to check latency
        this.socket.on('pong', () => {
            if (this.lastPingTime > 0) {
                const latency = Date.now() - this.lastPingTime;
                this.updateLatencyStats(latency);
            }
        });
    }

    requestCanvasState() {
        if (!this.socket || !this.socket.connected) {
            console.warn('can\'t request canvas - no connection');
            return;
        }
        
        console.log('asking server for canvas state...');
        this.socket.emit('request-canvas-state');
    }

    // join the drawing session properly
    joinSession() {
        if (!this.socket || !this.socket.connected) {
            console.warn('can\'t join - not connected');
            return;
        }
        
        if (!this.nickname) {
            console.warn('can\'t join - no nickname set');
            return;
        }

        this.socket.emit('join-session', {
            userId: this.userId,
            nickname: this.nickname
        });
    }

    handleSessionJoined(data) {
        console.log('=== WE\'RE IN THE SESSION ===');
        console.log('users online:', data.userCount);
        
        // remember when we joined
        this.sessionJoinTime = Date.now();
        
        // reset counters for fresh start
        this.clientSequence = 0;
        this.lastServerSequence = 0;
        
        this.updateUserCount(data.userCount);
        
        // connect to everyone who's already here
        data.users.forEach(user => {
            if (user.userId !== this.userId) {
                this.connectedUsers.set(user.userId, user);
                // start webrtc with existing users
                this.createPeerConnection(user.userId, true);
            }
        });
        
        this.updateUsersList();
        
        // server should send us the canvas
        console.log('waiting for canvas data...');
        
        // just in case server doesn't send it
        setTimeout(() => {
            console.log('canvas timeout - asking server again...');
            if (this.socket && this.socket.connected) {
                this.socket.emit('request-canvas-state');
            }
        }, 3000); // give it 3 seconds
        
        this.showNotification(`joined with ${data.userCount} people`, 'success');
    }

    handleUserJoined(data) {
        if (data.userId !== this.userId) {
            this.connectedUsers.set(data.userId, data);
            this.updateUsersList();
            this.updateUserCount(data.userCount);
            
            // start webrtc with the new person
            this.createPeerConnection(data.userId, false); // they'll start it
            
            this.showNotification(`${data.nickname} joined`, 'info');
        }
    }

    handleUserLeft(data) {
        if (data.userId !== this.userId) {
            this.connectedUsers.delete(data.userId);
            this.removePeer(data.userId);
            this.updateUsersList();
            
            const user = this.connectedUsers.get(data.userId);
            const nickname = user ? user.nickname : 'someone';
            this.showNotification(`${nickname} left`, 'info');
        }
    }

    handleUserInfoUpdate(data) {
        if (data.userId !== this.userId && this.connectedUsers.has(data.userId)) {
            const user = this.connectedUsers.get(data.userId);
            const oldNickname = user.nickname;
            
            // update their info
            user.nickname = data.nickname;
            user.lastSeen = data.timestamp;
            
            // refresh the UI
            this.updateUsersList();
            
            // fix their cursor label too
            this.updateCursorLabel(data.userId, data.nickname);
            
            // let everyone know
            this.showNotification(`${oldNickname} is now ${data.nickname}`, 'info');
        }
    }

    // webrtc setup with good servers
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
            
            // Don't automatically request canvas sync - let the server handle initial canvas state
            // Canvas sync will only be used for peer-to-peer updates during drawing
            console.log(`Data channel ready with ${userId}, canvas sync will be handled by server`);
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
        // For real-time drawing, send immediately instead of buffering.
        // BUGFIX: previously listened for start-drawing / end-drawing (with dashes) which never matched
        // actual event types (startDrawing / endDrawing), causing latency (notably worse in Firefox).
        if (data.type === 'startDrawing' || data.type === 'draw' || data.type === 'endDrawing') {
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
                // Only send canvas state if we've been in the session for a reasonable time
                // This prevents new users from overwriting existing users' canvases
                const timeSinceJoin = Date.now() - (this.sessionJoinTime || Date.now());
                if (timeSinceJoin > 10000) { // Only if we've been here for more than 10 seconds
                    console.log(`Sending canvas state to ${userId} (we've been here for ${timeSinceJoin}ms)`);
                    this.sendCanvasState(userId);
                } else {
                    console.log(`Ignoring canvas sync request from ${userId} (we're too new, only ${timeSinceJoin}ms)`);
                }
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
    
    // Auto-save canvas state periodically
    startAutoSave() {
        this.autoSaveInterval = setInterval(() => {
            this.saveCanvasState();
        }, 30000); // Save every 30 seconds
    }
    
    saveCanvasState() {
        const now = Date.now();
        // Only save if there's been recent activity and connection is stable
        if (this.socket && this.socket.connected && (now - this.lastCanvasSave > 25000)) {
            this.lastCanvasSave = now;
            this.socket.emit('canvas-state', {
                imageData: this.canvas.toDataURL('image/jpeg', 0.8)
            });
        }
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
        console.log('=== APPLYING CANVAS STATE ===');
        console.log('Session:', this.sessionId);
        console.log('Data:', data);
        
        try {
            // Clear canvas first
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            
            // Check if this is an empty room (no saved state)
            if (data.isEmpty || !data.data) {
                console.log('Empty room - setting white background');
                this.ctx.fillStyle = '#ffffff';
                this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                return;
            }
            
            const imageData = data.data.imageData;
            if (!imageData) {
                console.log('No image data - setting white background');
                this.ctx.fillStyle = '#ffffff';
                this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                return;
            }
            
            console.log('Loading server canvas state...');
            const img = new Image();
            img.onload = () => {
                // Set white background first
                this.ctx.fillStyle = '#ffffff';
                this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                
                // Draw the server canvas state
                this.ctx.drawImage(img, 0, 0, this.canvasWidth, this.canvasHeight);
                console.log('✅ Server canvas state applied successfully');
            };
            
            img.onerror = (error) => {
                console.error('❌ Failed to load server canvas state:', error);
                this.ctx.fillStyle = '#ffffff';
                this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            };
            
            img.src = imageData;
            
        } catch (error) {
            console.error('❌ Error applying canvas state:', error);
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    handleDrawingHistory(data) {
        console.log('Received drawing history (real-time sync):', data.actions.length, 'actions');
        
        // Apply drawing actions for real-time collaboration only
        // Canvas state should already be loaded from server
        data.actions.forEach(action => {
            if (action.type === 'drawing-data' && action.data) {
                this.handleRemoteDrawing(action);
            }
        });
    }

    initializeCanvas() {
        // Ensure canvas element exists
        if (!this.canvas) {
            console.error('Canvas element not found!');
            return;
        }
        
        console.log('Initializing canvas:', this.canvas.width, 'x', this.canvas.height);
        
        this.canvas.width = this.canvasWidth;
        this.canvas.height = this.canvasHeight;
        
        // Set white background
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        
        // Firefox-specific canvas optimizations
        if (this.isFirefox) {
            // Enable hardware acceleration hints for Firefox
            this.ctx.imageSmoothingEnabled = true;
            this.ctx.imageSmoothingQuality = 'high';
            // Disable alpha for better performance in Firefox
            this.canvas.style.willChange = 'transform';
        }
        
        console.log('Canvas context initialized with white background and color:', this.currentColor, 'size:', this.currentSize);
        
        // Use Pointer Events for unified mouse/touch/pen handling (better in Firefox & Edge)
        // Disable default touch actions (pinch-zoom, panning) on canvas
        this.canvas.style.touchAction = 'none';

        // Internal pointer tracking for smoothing
        this.activePointerId = null;
        this.lastPointerPoint = null;
        this.smoothing = true; // simple quadratic smoothing toggle
        // Firefox needs lighter smoothing to maintain responsiveness
        this.smoothFactor = this.isFirefox ? 0.3 : 0.5; // Firefox: lighter smoothing

        const pointerDown = (e) => {
            if (this.activePointerId !== null) return; // single pointer drawing
            this.activePointerId = e.pointerId;
            this.canvas.setPointerCapture(e.pointerId);
            this.startDrawing(e);
            this.lastPointerPoint = { x: e.clientX, y: e.clientY };
        };

        const pointerMove = (e) => {
            if (e.pointerId !== this.activePointerId) return;
            if (!this.isDrawing) return;

            // Optional smoothing to reduce jitter (especially important in Firefox)
            if (this.smoothing && this.lastPointerPoint) {
                const lerp = (a, b, t) => a + (b - a) * t;
                
                // Firefox-specific smoothing improvements
                let dynamicSmoothFactor = this.smoothFactor;
                if (this.isFirefox) {
                    // Calculate distance to adjust smoothing dynamically
                    const distance = Math.sqrt(
                        Math.pow(e.clientX - this.lastPointerPoint.x, 2) + 
                        Math.pow(e.clientY - this.lastPointerPoint.y, 2)
                    );
                    // Less smoothing for fast movements, more for small movements
                    dynamicSmoothFactor = distance > 5 ? 0.7 : 0.2;
                }
                
                const smoothedClientX = lerp(this.lastPointerPoint.x, e.clientX, dynamicSmoothFactor);
                const smoothedClientY = lerp(this.lastPointerPoint.y, e.clientY, dynamicSmoothFactor);
                const pseudoEvent = { ...e, clientX: smoothedClientX, clientY: smoothedClientY };
                this.draw(pseudoEvent);
                this.lastPointerPoint = { x: smoothedClientX, y: smoothedClientY };
            } else {
                this.draw(e);
                this.lastPointerPoint = { x: e.clientX, y: e.clientY };
            }
            this.sendCursorPosition(e);
        };

        const pointerUpOrCancel = (e) => {
            if (e.pointerId !== this.activePointerId) return;
            this.stopDrawing();
            try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
            this.activePointerId = null;
            this.lastPointerPoint = null;
        };

        this.canvas.addEventListener('pointerdown', pointerDown);
        this.canvas.addEventListener('pointermove', pointerMove);
        this.canvas.addEventListener('pointerup', pointerUpOrCancel);
        this.canvas.addEventListener('pointerleave', pointerUpOrCancel);
        this.canvas.addEventListener('pointercancel', pointerUpOrCancel);
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
        // Prevent drawing in anonymous mode
        if (this.isAnonymousMode) {
            return;
        }
        
        this.isDrawing = true;
        const coords = this.getCanvasCoordinates(e);
        this.clientSequence++;
        
        console.log('Start drawing at:', coords, 'sequence:', this.clientSequence);
        
        // Set drawing properties
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        this.ctx.beginPath();
        this.ctx.moveTo(coords.x, coords.y);
        this.currentPath = [{ x: coords.x, y: coords.y }];
        
        // Send start drawing event with sequence number
        this.broadcastDrawing({
            type: 'startDrawing',
            x: coords.x,
            y: coords.y,
            normalizedX: coords.x / this.canvasWidth,
            normalizedY: coords.y / this.canvasHeight,
            color: this.currentColor,
            size: this.currentSize,
            userId: this.userId,
            sessionId: this.sessionId,
            sequence: this.clientSequence,
            timestamp: Date.now()
        });
    }

    draw(e) {
        if (!this.isDrawing) return;
        
        // Throttle drawing events for better performance
        const now = Date.now();
        if (now - this.lastDrawTime < this.drawThrottleMs) {
            // Store the latest data for later processing
            this.pendingDrawData = e;
            return;
        }
        
        this.lastDrawTime = now;
        this.processDrawEvent(e);
        
        // Process any pending data
        if (this.pendingDrawData && this.pendingDrawData !== e) {
            setTimeout(() => {
                if (this.pendingDrawData && this.isDrawing) {
                    this.processDrawEvent(this.pendingDrawData);
                    this.pendingDrawData = null;
                }
            }, this.drawThrottleMs);
        }
    }
    
    processDrawEvent(e) {
        const coords = this.getCanvasCoordinates(e);
        this.clientSequence++;
        
        // Set drawing properties again to ensure they're correct
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        // Firefox-specific drawing optimizations
        if (this.isFirefox) {
            // Use beginPath for better Firefox performance
            this.ctx.beginPath();
            if (this.currentPath.length > 0) {
                const lastPoint = this.currentPath[this.currentPath.length - 1];
                this.ctx.moveTo(lastPoint.x, lastPoint.y);
            } else {
                this.ctx.moveTo(coords.x, coords.y);
            }
            this.ctx.lineTo(coords.x, coords.y);
            this.ctx.stroke();
        } else {
            // Standard drawing for other browsers
            this.ctx.lineTo(coords.x, coords.y);
            this.ctx.stroke();
        }
        
        this.currentPath.push({ x: coords.x, y: coords.y });
        
        // Send drawing data with sequence number
        this.broadcastDrawing({
            type: 'draw',
            x: coords.x,
            y: coords.y,
            normalizedX: coords.x / this.canvasWidth,
            normalizedY: coords.y / this.canvasHeight,
            color: this.currentColor,
            size: this.currentSize,
            userId: this.userId,
            sessionId: this.sessionId,
            sequence: this.clientSequence,
            timestamp: Date.now()
        });
    }

    addCanvasBlur() {
        const canvasContainer = document.querySelector('.canvas-container');
        if (canvasContainer) {
            canvasContainer.style.filter = 'blur(8px)';
            canvasContainer.style.opacity = '0.7';
            canvasContainer.style.transition = 'filter 0.3s ease, opacity 0.3s ease';
        }
    }

    removeCanvasBlur() {
        const canvasContainer = document.querySelector('.canvas-container');
        if (canvasContainer) {
            canvasContainer.style.filter = 'none';
            canvasContainer.style.opacity = '1';
        }
    }

    setupFirefoxOptimizations() {
        // Firefox-specific performance optimizations
        console.log('Applying Firefox-specific optimizations...');
        
        // Optimize animation frame timing for Firefox
        if (typeof requestAnimationFrame !== 'undefined') {
            const originalRAF = window.requestAnimationFrame;
            window.requestAnimationFrame = (callback) => {
                // Firefox benefits from slightly delayed animation frames
                return originalRAF(() => {
                    // Small delay to prevent overwhelming Firefox's renderer
                    setTimeout(callback, 0);
                });
            };
        }
        
        // Optimize canvas context for Firefox
        if (this.ctx) {
            if (this.ctx.webkitImageSmoothingEnabled !== undefined) {
                this.ctx.webkitImageSmoothingEnabled = true;
            }
        }
        
        // Reduce aggressive canvas redraws in Firefox
    }

    disableDrawingControls() {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) {
            sidebar.style.pointerEvents = 'none';
            sidebar.style.opacity = '0.5';
        }
    }

    enableDrawingControls() {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) {
            sidebar.style.pointerEvents = 'auto';
            sidebar.style.opacity = '1';
        }
    }

    stopDrawing() {
        if (!this.isDrawing) return;
        
        this.isDrawing = false;
        this.clientSequence++;
        
        // Send end drawing event with sequence number
        this.broadcastDrawing({
            type: 'endDrawing',
            path: this.currentPath,
            color: this.currentColor,
            size: this.currentSize,
            userId: this.userId,
            sessionId: this.sessionId,
            sequence: this.clientSequence,
            timestamp: Date.now()
        });
        
        this.currentPath = [];
        this.currentStrokeId = null;
        
        // Send canvas state to WebSocket for persistence
        if (this.socket && this.socket.connected) {
            this.socket.emit('canvas-state', {
                imageData: this.canvas.toDataURL('image/jpeg', 0.8)
            });
        }
    }

    handleRemoteDrawing(data) {
        // Skip our own drawing data (we already drew it optimistically)
        if (data.userId === this.userId) {
            // Update our tracking with server-validated data
            if (data.serverSequence) {
                this.lastServerSequence = Math.max(this.lastServerSequence, data.serverSequence);
            }
            if (data.data && data.data.strokeId) {
                this.currentStrokeId = data.data.strokeId;
            }
            return;
        }
        
        const drawingData = data.data || data;
        
        // Validate that this drawing data is for our current session
        if (drawingData.sessionId && drawingData.sessionId !== this.sessionId) {
            console.log(`Ignoring drawing data for different session: ${drawingData.sessionId} vs current: ${this.sessionId}`);
            return;
        }
        
        // Handle clear canvas command
        if (drawingData.type === 'clear-canvas') {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            // Set white background
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.remoteDrawingStates.clear();
            return;
        }
        
        // Handle fill background command
        if (drawingData.type === 'fill-background') {
            this.ctx.fillStyle = drawingData.color;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            return;
        }
        
        // Validate server sequence to prevent out-of-order rendering
        if (data.serverSequence && data.serverSequence <= this.lastServerSequence) {
            console.log('Ignoring out-of-order drawing data');
            return;
        }
        
        if (data.serverSequence) {
            this.lastServerSequence = data.serverSequence;
        }
        
        const x = drawingData.normalizedX !== undefined ? 
            drawingData.normalizedX * this.canvasWidth : drawingData.x;
        const y = drawingData.normalizedY !== undefined ? 
            drawingData.normalizedY * this.canvasHeight : drawingData.y;
        
        // Validate coordinates to prevent drawing outside canvas
        if (x < 0 || x > this.canvasWidth || y < 0 || y > this.canvasHeight) {
            console.log('Ignoring drawing data outside canvas bounds');
            return;
        }
        
        // Get or create drawing state for this user
        let userDrawingState = this.remoteDrawingStates.get(data.userId);
        if (!userDrawingState) {
            userDrawingState = {
                isDrawing: false,
                lastX: 0,
                lastY: 0,
                color: '#000000', // Default to black for consistency
                size: 5,
                currentStroke: null
            };
            this.remoteDrawingStates.set(data.userId, userDrawingState);
        }
        
        // Set drawing style from validated server data
        this.ctx.strokeStyle = drawingData.color || userDrawingState.color;
        this.ctx.lineWidth = drawingData.size || userDrawingState.size;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        // Handle different drawing types
        if (drawingData.type === 'startDrawing') {
            userDrawingState.isDrawing = true;
            userDrawingState.lastX = x;
            userDrawingState.lastY = y;
            userDrawingState.color = drawingData.color || '#000000'; // Default to black
            userDrawingState.size = drawingData.size || 5;
            userDrawingState.currentStroke = drawingData.strokeId;
            
            this.ctx.beginPath();
            this.ctx.moveTo(x, y);
            
        } else if (drawingData.type === 'draw' && userDrawingState.isDrawing) {
            // Validate stroke continuity to prevent long connecting lines
            if (drawingData.strokeId && drawingData.strokeId !== userDrawingState.currentStroke) {
                console.log('Stroke ID mismatch, starting new stroke');
                userDrawingState.isDrawing = true;
                userDrawingState.currentStroke = drawingData.strokeId;
                this.ctx.beginPath();
                this.ctx.moveTo(x, y);
            } else {
                // Check for unrealistic jumps to prevent long lines
                const distance = Math.sqrt(
                    Math.pow(x - userDrawingState.lastX, 2) + 
                    Math.pow(y - userDrawingState.lastY, 2)
                );
                
                if (distance > this.canvasWidth * 0.3) { // More than 30% of canvas width
                    console.log('Large jump detected, starting new stroke segment');
                    this.ctx.beginPath();
                    this.ctx.moveTo(x, y);
                } else {
                    this.ctx.lineTo(x, y);
                    this.ctx.stroke();
                }
            }
            
            userDrawingState.lastX = x;
            userDrawingState.lastY = y;
            
        } else if (drawingData.type === 'endDrawing') {
            userDrawingState.isDrawing = false;
            userDrawingState.currentStroke = null;
        }
    }
    
    handleDrawingCorrection(data) {
        console.log('Drawing correction received:', data);
        
        // Handle different types of corrections
        switch (data.reason) {
            case 'invalid_data':
                // Reset drawing state
                this.isDrawing = false;
                this.currentPath = [];
                this.currentStrokeId = null;
                
                // Show notification to user
                this.showNotification('Drawing was corrected by server', 'warning');
                break;
                
            case 'sequence_mismatch':
                // Resync sequence numbers
                if (data.expectedSequence) {
                    this.clientSequence = data.expectedSequence;
                }
                break;
                
            case 'large_jump':
                // Start a new stroke
                this.isDrawing = false;
                this.currentPath = [];
                break;
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
        // Update both regular and draggable user lists
        this.updateUsersListContainer('usersList');
        this.updateUsersListContainer('usersListDrag');
    }
    
    updateUsersListContainer(containerId) {
        const usersList = document.getElementById(containerId);
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
        this.setupChatControls();
        this.setupChatTabs();
        this.setupChatToggle();
    }
    
    // Room management removed - single canvas only
    

    

    


















    setupColorPicker() {
        // Color swatches handling
        const swatches = document.querySelectorAll('.swatch');
        swatches.forEach(swatch => {
            swatch.addEventListener('click', () => {
                const color = swatch.dataset.color;
                this.currentColor = color;
                this.updateColorDisplay(color);
                this.updateDrawingProperties();
                this.updateBrushPreview();
                
                // Update active state
                swatches.forEach(s => s.classList.remove('active'));
                swatch.classList.add('active');
                
                console.log('Color changed to:', color);
            });
        });
    }

    setupBrushControls() {
        const brushSize = document.getElementById('brushSize');
        const sizeValue = document.getElementById('sizeValue');
        const sizeDec = document.getElementById('sizeDec');
        const sizeInc = document.getElementById('sizeInc');
        const quickSizes = document.querySelectorAll('.size-quick');
        
        // Update size display
        const updateSizeDisplay = (size) => {
            this.currentSize = parseInt(size);
            if (sizeValue) {
                sizeValue.textContent = size;
            }
            if (brushSize) {
                brushSize.value = size;
            }
            this.updateDrawingProperties();
            this.updateBrushPreview();
        };
        
        // Range slider
        if (brushSize) {
            brushSize.addEventListener('input', (e) => {
                updateSizeDisplay(e.target.value);
            });
        }
        
        // Decrease/Increase buttons
        if (sizeDec) {
            sizeDec.addEventListener('click', () => {
                const newSize = Math.max(1, this.currentSize - 1);
                updateSizeDisplay(newSize);
            });
        }
        
        if (sizeInc) {
            sizeInc.addEventListener('click', () => {
                const newSize = Math.min(50, this.currentSize + 1);
                updateSizeDisplay(newSize);
            });
        }
        
        // Quick size buttons
        quickSizes.forEach(btn => {
            btn.addEventListener('click', () => {
                const size = parseInt(btn.dataset.size);
                updateSizeDisplay(size);
                
                // Update active state
                quickSizes.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }

    isValidHexColor(hex) {
        return /^#([0-9A-F]{3}){1,2}$/i.test(hex);
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
        const brushPreview = document.getElementById('brushPreviewCircle');
        
        if (brushPreview) {
            brushPreview.style.backgroundColor = color;
        }
    }

    updateDrawingProperties() {
        if (this.ctx) {
            this.ctx.strokeStyle = this.currentColor;
            this.ctx.lineWidth = this.currentSize;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
        }
        
        // Update brush preview
        this.updateBrushPreview();
        
        console.log('Drawing properties updated - Color:', this.currentColor, 'Size:', this.currentSize);
    }

    updateBrushPreview() {
        const brushPreview = document.getElementById('brushPreviewCircle');
        if (brushPreview) {
            brushPreview.style.width = Math.max(8, this.currentSize) + 'px';
            brushPreview.style.height = Math.max(8, this.currentSize) + 'px';
            brushPreview.style.backgroundColor = this.currentColor;
        }
        
        // Update custom brush cursor
        this.updateBrushCursor();
    }

    // Create and manage custom brush cursor
    updateBrushCursor() {
        // Remove existing cursor
        const existingCursor = document.querySelector('.brush-cursor');
        if (existingCursor) {
            existingCursor.remove();
        }
        
        // Create new cursor
        const cursor = document.createElement('div');
        cursor.className = 'brush-cursor';
        cursor.style.width = this.currentSize + 'px';
        cursor.style.height = this.currentSize + 'px';
        cursor.style.display = 'none';
        
        document.body.appendChild(cursor);
        
        // Update canvas cursor behavior
        if (this.canvas) {
            this.canvas.addEventListener('mouseenter', () => {
                cursor.style.display = 'block';
                this.canvas.style.cursor = 'none';
            });
            
            this.canvas.addEventListener('mouseleave', () => {
                cursor.style.display = 'none';
                this.canvas.style.cursor = 'crosshair';
            });
            
            this.canvas.addEventListener('mousemove', (e) => {
                const rect = this.canvas.getBoundingClientRect();
                cursor.style.left = e.clientX + 'px';
                cursor.style.top = e.clientY + 'px';
            });
        }
    }

    clearCanvas() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Set white background
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Broadcast clear event
        this.broadcastDrawing({
            type: 'clear-canvas',
            userId: this.userId,
            sessionId: this.sessionId,
            sequence: ++this.clientSequence,
            timestamp: Date.now()
        });
        
        // Save cleared canvas state immediately
        this.saveCanvasState();
    }

    fillCanvasBackground() {
        // Fill the canvas with the current selected color
        this.ctx.fillStyle = this.currentColor;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Broadcast fill background event
        this.broadcastDrawing({
            type: 'fill-background',
            color: this.currentColor,
            userId: this.userId,
            sessionId: this.sessionId,
            sequence: ++this.clientSequence,
            timestamp: Date.now()
        });
        
        // Save filled canvas state immediately
        this.saveCanvasState();
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

    setupChatToggle() {
        const chatFloatingBtn = document.getElementById('chatFloatingBtn');
        const chatPopup = document.getElementById('chatPopup');
        const closeChatPopup = document.getElementById('closeChatPopup');
        
        if (chatFloatingBtn && chatPopup && closeChatPopup) {
            // Open chat popup
            chatFloatingBtn.addEventListener('click', () => {
                const isOpen = chatPopup.style.display === 'flex';
                if (isOpen) {
                    chatPopup.style.display = 'none';
                    chatFloatingBtn.setAttribute('aria-expanded', 'false');
                } else {
                    chatPopup.style.display = 'flex';
                    chatFloatingBtn.setAttribute('aria-expanded', 'true');
                    this.unreadCount = 0;
                    this.hideUnreadBadge();
                }
            });
            
            // Close chat popup
            closeChatPopup.addEventListener('click', () => {
                chatPopup.style.display = 'none';
                chatFloatingBtn.setAttribute('aria-expanded', 'false');
            });
            
            // Close popup when clicking outside
            document.addEventListener('click', (e) => {
                if (!chatPopup.contains(e.target) && !chatFloatingBtn.contains(e.target)) {
                    chatPopup.style.display = 'none';
                    chatFloatingBtn.setAttribute('aria-expanded', 'false');
                }
            });
        }
    }

    showChatBubble() {
        const chatFloatingBtn = document.getElementById('chatFloatingBtn');
        if (chatFloatingBtn) {
            chatFloatingBtn.style.display = 'block';
        }
    }

    showUnreadBadge(count) {
        const badge = document.getElementById('unreadBadge');
        if (badge && count > 0) {
            badge.textContent = count;
            badge.style.display = 'flex';
        }
    }

    hideUnreadBadge() {
        const badge = document.getElementById('unreadBadge');
        if (badge) {
            badge.style.display = 'none';
        }
    }

    setupChatTabs() {
        const tabButtons = document.querySelectorAll('.chat-tab-btn');
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
                    chatTab.classList.add('active');
                    usersTab.classList.remove('active');
                } else if (tabType === 'users') {
                    chatTab.classList.remove('active');
                    usersTab.classList.add('active');
                    // Update users list when switching to users tab
                    this.updateUsersList();
                }
            });
        });
    }

    createChatPanel() {
        // This function is no longer needed as chat is now in HTML
        // Just ensure the chat is properly initialized
        console.log('Chat panel is now integrated in sidebar');
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

    addChatMessage(data) {
        // Add to chat container
        this.addChatMessageToContainer('chatMessages', data);
        
        // Check if chat popup is visible and show unread badge if not
        const chatPopup = document.getElementById('chatPopup');
        if (chatPopup && chatPopup.style.display === 'none') {
            if (!this.unreadCount) this.unreadCount = 0;
            this.unreadCount++;
            this.showUnreadBadge(this.unreadCount);
        }
    }
    
    addChatMessageToContainer(containerId, data) {
        const chatMessages = document.getElementById(containerId);
        if (!chatMessages) return;
        
        // Sanitize and truncate long messages
        const maxMessageLength = 300; // Limit message length
        let message = data.message || '';
        if (typeof message !== 'string') {
            message = String(message);
        }
        
        // Truncate if too long
        if (message.length > maxMessageLength) {
            message = message.substring(0, maxMessageLength) + '...';
        }
        
        // Escape HTML to prevent XSS
        message = this.escapeHtml(message);
        
        const messageElement = document.createElement('div');
        messageElement.className = 'chat-message';
        
        const time = new Date(data.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const isOwnMessage = data.userId === this.userId;
        const nickname = this.escapeHtml(data.nickname || 'Unknown');
        
        messageElement.innerHTML = `
            <span class="chat-time">${time}</span>
            <span class="chat-nickname ${isOwnMessage ? 'own-message' : ''}">${nickname}:</span>
            <span class="chat-text">${message}</span>
        `;
        
        // Add with fade-in animation
        messageElement.style.opacity = '0';
        messageElement.style.transform = 'translateY(10px)';
        chatMessages.appendChild(messageElement);
        
        // Trigger animation
        requestAnimationFrame(() => {
            messageElement.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
            messageElement.style.opacity = '1';
            messageElement.style.transform = 'translateY(0)';
        });
        
        // Auto-scroll to bottom with smooth behavior
        this.scrollChatToBottom(chatMessages);
        
        // Keep only last 100 messages to prevent memory issues
        while (chatMessages.children.length > 100) {
            const firstChild = chatMessages.firstChild;
            if (firstChild) {
                chatMessages.removeChild(firstChild);
            }
        }
    }
    
    scrollChatToBottom(container = null) {
        const containers = container ? [container] : [
            document.getElementById('chatMessages')
        ];
        
        containers.forEach(chatMessages => {
            if (chatMessages) {
                requestAnimationFrame(() => {
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                });
            }
        });
    }

    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, function(m) { return map[m]; });
    }
    
    initializeDraggableComponents() {
        // Initialize toolbar buttons
        const toggleColorPicker = document.getElementById('toggleColorPicker');
        const toggleChat = document.getElementById('toggleChat');
        const colorPickerComponent = document.getElementById('colorPickerComponent');
        const chatComponent = document.getElementById('chatComponent');
        
        if (toggleColorPicker && colorPickerComponent) {
            toggleColorPicker.addEventListener('click', () => {
                const isVisible = colorPickerComponent.style.display !== 'none';
                colorPickerComponent.style.display = isVisible ? 'none' : 'block';
                toggleColorPicker.classList.toggle('active', !isVisible);
            });
        }
        
        if (toggleChat && chatComponent) {
            toggleChat.addEventListener('click', () => {
                const isVisible = chatComponent.style.display !== 'none';
                chatComponent.style.display = isVisible ? 'none' : 'block';
                toggleChat.classList.toggle('active', !isVisible);
            });
        }
        
        // Make components draggable
        this.makeDraggable(colorPickerComponent);
        this.makeDraggable(chatComponent);
        
        // Initialize color picker functionality for draggable component
        this.initializeDraggableColorPicker();
        
        // Initialize chat functionality for draggable component
        this.initializeDraggableChat();
        
        // Close buttons
        const closeColorPicker = document.getElementById('closeColorPickerComponent');
        const closeChat = document.getElementById('closeChatComponent');
        
        if (closeColorPicker) {
            closeColorPicker.addEventListener('click', () => {
                colorPickerComponent.style.display = 'none';
                toggleColorPicker.classList.remove('active');
            });
        }
        
        if (closeChat) {
            closeChat.addEventListener('click', () => {
                chatComponent.style.display = 'none';
                toggleChat.classList.remove('active');
            });
        }
    }
    
    makeDraggable(element) {
        if (!element) return;
        
        const header = element.querySelector('.component-header');
        if (!header) return;
        
        let isDragging = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;
        let xOffset = 0;
        let yOffset = 0;
        
        header.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
        
        function dragStart(e) {
            if (e.target.classList.contains('component-btn')) return;
            
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
            
            if (e.target === header || header.contains(e.target)) {
                isDragging = true;
                element.classList.add('dragging');
            }
        }
        
        function drag(e) {
            if (isDragging) {
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
                
                xOffset = currentX;
                yOffset = currentY;
                
                element.style.transform = `translate(${currentX}px, ${currentY}px)`;
            }
        }
        
        function dragEnd() {
            if (isDragging) {
                isDragging = false;
                element.classList.remove('dragging');
            }
        }
    }
    
    initializeDraggableColorPicker() {
        // Set up color picker functionality for the draggable component
        const swatches = document.querySelectorAll('#colorPickerComponent .swatch');
        swatches.forEach(swatch => {
            swatch.addEventListener('click', (e) => {
                const color = e.target.dataset.color;
                if (color) {
                    this.setColor(color);
                    this.updateColorDisplay(color);
                    // Update both regular and draggable displays
                    this.updateDraggableColorDisplay(color);
                }
            });
        });
    }
    
    initializeDraggableChat() {
        // Set up chat functionality for the draggable component
        const chatInput = document.getElementById('chatInputDrag');
        const sendButton = document.getElementById('sendMessageDrag');
        const tabButtons = document.querySelectorAll('#chatComponent .chat-tab-btn');
        
        if (chatInput && sendButton) {
            const sendMessage = () => {
                const message = chatInput.value.trim();
                if (message) {
                    this.sendChatMessage(message);
                    chatInput.value = '';
                }
            };
            
            sendButton.addEventListener('click', sendMessage);
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    sendMessage();
                }
            });
        }
        
        // Tab switching
        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                const targetTab = button.dataset.tab;
                
                // Update active tab button
                tabButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                
                // Show corresponding tab content
                const chatTabDrag = document.getElementById('chatTabDrag');
                const usersTabDrag = document.getElementById('usersTabDrag');
                
                if (targetTab === 'chatDrag') {
                    chatTabDrag?.classList.add('active');
                    usersTabDrag?.classList.remove('active');
                } else if (targetTab === 'usersDrag') {
                    usersTabDrag?.classList.add('active');
                    chatTabDrag?.classList.remove('active');
                }
            });
        });
    }
    
    updateDraggableColorDisplay(color) {
        const colorTrigger = document.getElementById('colorTriggerDrag');
        const colorHexLabel = document.getElementById('colorHexLabelDrag');
        
        if (colorTrigger) {
            const dot = colorTrigger.querySelector('.trigger-dot');
            if (dot) {
                dot.style.setProperty('--c', color);
            }
        }
        
        if (colorHexLabel) {
            colorHexLabel.textContent = color.toUpperCase();
        }
    }
    
    initializeCanvasPanning() {
        const canvasFrame = document.getElementById('canvasFrame');
        if (!canvasFrame) return;
        
        let isPanning = false;
        let startX, startY;
        let scrollLeft, scrollTop;
        
        canvasFrame.addEventListener('mousedown', (e) => {
            // Only pan if clicking on the frame background, not the canvas
            if (e.target === canvasFrame || e.target.classList.contains('grid-bg')) {
                isPanning = true;
                startX = e.pageX - canvasFrame.offsetLeft;
                startY = e.pageY - canvasFrame.offsetTop;
                scrollLeft = canvasFrame.scrollLeft;
                scrollTop = canvasFrame.scrollTop;
                canvasFrame.style.cursor = 'grabbing';
                e.preventDefault();
                e.stopPropagation();
            }
        });
        
        canvasFrame.addEventListener('mousemove', (e) => {
            if (!isPanning) return;
            e.preventDefault();
            e.stopPropagation();
            
            const x = e.pageX - canvasFrame.offsetLeft;
            const y = e.pageY - canvasFrame.offsetTop;
            const walkX = (x - startX) * 2;
            const walkY = (y - startY) * 2;
            
            canvasFrame.scrollLeft = scrollLeft - walkX;
            canvasFrame.scrollTop = scrollTop - walkY;
        });
        
        document.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                canvasFrame.style.cursor = 'grab';
            }
        });
        
        canvasFrame.addEventListener('mouseleave', () => {
            if (isPanning) {
                isPanning = false;
                canvasFrame.style.cursor = 'grab';
            }
        });
        
        // Add zoom functionality with mouse wheel
        canvasFrame.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const canvas = document.getElementById('drawingCanvas');
                const container = document.querySelector('.canvas-container');
                
                if (canvas && container) {
                    const delta = e.deltaY > 0 ? 0.9 : 1.1;
                    const currentScale = parseFloat(canvas.style.transform.replace(/.*scale\(([^)]+)\).*/, '$1') || '1');
                    const newScale = Math.max(0.1, Math.min(3, currentScale * delta));
                    
                    canvas.style.transform = `scale(${newScale})`;
                    canvas.style.transformOrigin = 'top left';
                    
                    // Update zoom indicator
                    if (window.updateZoomIndicator) {
                        window.updateZoomIndicator();
                    }
                    
                    // Adjust container size based on scale
                    container.style.width = `${2000 * newScale}px`;
                    container.style.height = `${1200 * newScale}px`;
                }
            }
        });
    }
    
    initializeThemeSystem() {
        // Get saved theme or default to dark
        const savedTheme = localStorage.getItem('canvas-theme') || 'dark';
        this.setTheme(savedTheme);
        
        // Theme switcher buttons
        const themeButtons = document.querySelectorAll('.theme-btn');
        themeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const theme = btn.dataset.theme;
                this.setTheme(theme);
                localStorage.setItem('canvas-theme', theme);
                
                // Update active state
                themeButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
            
            // Set initial active state
            if (btn.dataset.theme === savedTheme) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
    
    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        
        // Update canvas background based on theme
        const canvas = document.getElementById('drawingCanvas');
        if (canvas && this.ctx) {
            // Clear canvas and set new background
            this.ctx.fillStyle = theme === 'light' ? '#ffffff' : '#ffffff';
            this.ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        
        // Dispatch theme change event for other components
        window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme } }));
    }
}

// Initialize the application
new OptimizedCollaborativeCanvas();

// Enhanced canvas zoom indicator
document.addEventListener('DOMContentLoaded', function() {
    const canvasArea = document.querySelector('.canvas-area');
    if (canvasArea) {
        const zoomIndicator = document.createElement('div');
        zoomIndicator.className = 'zoom-indicator';
        zoomIndicator.textContent = '100%';
        canvasArea.appendChild(zoomIndicator);
        
        // Update zoom indicator function
        window.updateZoomIndicator = function() {
            const canvas = document.getElementById('whiteboard');
            if (canvas) {
                const currentScale = parseFloat(canvas.style.transform.replace(/.*scale\(([^)]+)\).*/, '$1') || '1');
                const percentage = Math.round(currentScale * 100);
                zoomIndicator.textContent = `${percentage}%`;
                
                // Show indicator briefly
                zoomIndicator.classList.add('visible');
                clearTimeout(window.zoomIndicatorTimeout);
                window.zoomIndicatorTimeout = setTimeout(() => {
                    zoomIndicator.classList.remove('visible');
                }, 2000);
            }
        };
    }
});

// Enhanced connection status indicator
function updateConnectionStatus(status, message) {
    const connectionStatus = document.getElementById('connectionStatus');
    if (connectionStatus) {
        connectionStatus.className = status;
        connectionStatus.textContent = message || status;
        
        // Add pulse animation for connecting state
        if (status === 'connecting') {
            connectionStatus.style.animation = 'pulse 1s infinite';
        } else {
            connectionStatus.style.animation = '';
        }
    }
}

// Keyboard shortcuts for theme switching
document.addEventListener('keydown', function(e) {
    if (e.ctrlKey || e.metaKey) {
        switch(e.key) {
            case '1':
                e.preventDefault();
                document.querySelector('[data-theme="dark"]')?.click();
                break;
            case '2':
                e.preventDefault();
                document.querySelector('[data-theme="light"]')?.click();
                break;
            case '3':
                e.preventDefault();
                document.querySelector('[data-theme="blue"]')?.click();
                break;
        }
    }
});

// Performance monitoring
let frameCount = 0;
let lastTime = performance.now();

function monitorPerformance() {
    frameCount++;
    const currentTime = performance.now();
    
    if (currentTime - lastTime >= 1000) {
        const fps = Math.round((frameCount * 1000) / (currentTime - lastTime));
        console.log(`Canvas FPS: ${fps}`);
        frameCount = 0;
        lastTime = currentTime;
    }
    
    requestAnimationFrame(monitorPerformance);
}

// Start performance monitoring in development
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    monitorPerformance();
}
