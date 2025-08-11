class CollaborativeCanvas {
    constructor() {
        this.canvas = document.getElementById('drawingCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.peers = new Map();
        this.dataChannels = new Map();
        
        this.isDrawing = false;
        this.currentColor = '#000000';
        this.currentSize = 5;
        this.userId = this.generateUserId();
        this.sessionId = 'default';
        this.lastSignalCheck = 0;
        this.lastDrawingCheck = 0;
        
        this.initializeCanvas();
        this.initializeControls();
        this.initializeWebRTC();
        this.joinSession();
        this.startPolling();
    }

    generateUserId() {
        return 'user_' + Math.random().toString(36).substr(2, 9);
    }

    async joinSession() {
        try {
            const response = await fetch('/api/join-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: this.userId, sessionId: this.sessionId })
            });
            
            const data = await response.json();
            if (data.success) {
                console.log('Joined session, other users:', data.otherUsers);
                this.updateConnectionStatus('connected');
                this.updateUserCount(data.userCount);
                
                // Try to connect to existing users
                data.otherUsers.forEach(userId => {
                    this.createPeerConnection(userId, true);
                });
            }
        } catch (error) {
            console.error('Error joining session:', error);
            this.updateConnectionStatus('disconnected');
        }
    }

    startPolling() {
        // Poll for signals every 1 second
        setInterval(() => this.pollForSignals(), 1000);
        
        // Poll for drawing updates every 500ms
        setInterval(() => this.pollForDrawingUpdates(), 500);
        
        // Update session info every 5 seconds
        setInterval(() => this.updateSessionInfo(), 5000);
    }

    async pollForSignals() {
        try {
            const response = await fetch(`/api/get-signals/${this.userId}?sessionId=${this.sessionId}&since=${this.lastSignalCheck}`);
            const data = await response.json();
            
            if (data.signals && data.signals.length > 0) {
                for (const signal of data.signals) {
                    await this.handleSignal(signal);
                    this.lastSignalCheck = Math.max(this.lastSignalCheck, signal.timestamp);
                }
            }
        } catch (error) {
            console.error('Error polling for signals:', error);
        }
    }

    async pollForDrawingUpdates() {
        try {
            const response = await fetch(`/api/get-drawing-updates/${this.userId}?sessionId=${this.sessionId}&since=${this.lastDrawingCheck}`);
            const data = await response.json();
            
            if (data.updates && data.updates.length > 0) {
                for (const update of data.updates) {
                    this.handleRemoteDrawing(update.data);
                    this.lastDrawingCheck = Math.max(this.lastDrawingCheck, update.timestamp);
                }
            }
        } catch (error) {
            console.error('Error polling for drawing updates:', error);
        }
    }

    async updateSessionInfo() {
        try {
            const response = await fetch(`/api/session-info/${this.sessionId}`);
            const data = await response.json();
            this.updateUserCount(data.userCount);
            
            // Check for new users
            const currentUsers = data.users.map(u => u.userId);
            const newUsers = currentUsers.filter(userId => 
                userId !== this.userId && !this.peers.has(userId)
            );
            
            newUsers.forEach(userId => {
                this.createPeerConnection(userId, true);
            });
        } catch (error) {
            console.error('Error updating session info:', error);
        }
    }

    initializeCanvas() {
        // Set up canvas for drawing
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        // Mouse events
        this.canvas.addEventListener('mousedown', (e) => this.startDrawing(e));
        this.canvas.addEventListener('mousemove', (e) => this.draw(e));
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

    initializeControls() {
        const colorPicker = document.getElementById('colorPicker');
        const brushSize = document.getElementById('brushSize');
        const sizeDisplay = document.getElementById('sizeDisplay');
        const clearButton = document.getElementById('clearCanvas');
        
        colorPicker.addEventListener('change', (e) => {
            this.currentColor = e.target.value;
        });
        
        brushSize.addEventListener('input', (e) => {
            this.currentSize = e.target.value;
            sizeDisplay.textContent = e.target.value;
        });
        
        clearButton.addEventListener('click', () => {
            this.clearCanvas();
            this.broadcastDrawing({
                type: 'clear',
                userId: this.userId
            });
        });
    }

    initializeWebRTC() {
        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };
    }

    async handleSignal(signal) {
        const { fromUserId, signal: signalData } = signal;
        
        if (signalData.type === 'offer') {
            await this.handleOffer({ offer: signalData.offer, fromUserId });
        } else if (signalData.type === 'answer') {
            await this.handleAnswer({ answer: signalData.answer, fromUserId });
        } else if (signalData.type === 'ice-candidate') {
            await this.handleIceCandidate({ candidate: signalData.candidate, fromUserId });
        } else if (signalData.type === 'user-joined') {
            this.createPeerConnection(fromUserId, true);
        }
    }

    async sendSignal(toUserId, signal) {
        try {
            await fetch('/api/send-signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fromUserId: this.userId,
                    toUserId,
                    signal,
                    sessionId: this.sessionId
                })
            });
        } catch (error) {
            console.error('Error sending signal:', error);
        }
    }

    async createPeerConnection(userId, isInitiator) {
        try {
            const peerConnection = new RTCPeerConnection(this.rtcConfig);
            this.peers.set(userId, peerConnection);

            // Create data channel for drawing data
            if (isInitiator) {
                const dataChannel = peerConnection.createDataChannel('drawing', {
                    ordered: true
                });
                this.setupDataChannel(dataChannel, userId);
            }

            peerConnection.ondatachannel = (event) => {
                this.setupDataChannel(event.channel, userId);
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    this.sendSignal(userId, {
                        type: 'ice-candidate',
                        candidate: event.candidate
                    });
                }
            };

            peerConnection.onconnectionstatechange = () => {
                console.log(`Connection state with ${userId}:`, peerConnection.connectionState);
                if (peerConnection.connectionState === 'disconnected' || 
                    peerConnection.connectionState === 'failed') {
                    this.removePeer(userId);
                }
            };

            if (isInitiator) {
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                
                await this.sendSignal(userId, {
                    type: 'offer',
                    offer: offer
                });
            }
        } catch (error) {
            console.error('Error creating peer connection:', error);
        }
    }

    setupDataChannel(dataChannel, userId) {
        this.dataChannels.set(userId, dataChannel);
        
        dataChannel.onopen = () => {
            console.log(`Data channel opened with ${userId}`);
        };
        
        dataChannel.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleRemoteDrawing(data);
        };
        
        dataChannel.onerror = (error) => {
            console.error(`Data channel error with ${userId}:`, error);
        };
    }

    async handleOffer(data) {
        try {
            const peerConnection = new RTCPeerConnection(this.rtcConfig);
            this.peers.set(data.fromUserId, peerConnection);

            peerConnection.ondatachannel = (event) => {
                this.setupDataChannel(event.channel, data.fromUserId);
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    this.sendSignal(data.fromUserId, {
                        type: 'ice-candidate',
                        candidate: event.candidate
                    });
                }
            };

            await peerConnection.setRemoteDescription(data.offer);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            await this.sendSignal(data.fromUserId, {
                type: 'answer',
                answer: answer
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(data) {
        try {
            const peerConnection = this.peers.get(data.fromUserId);
            if (peerConnection) {
                await peerConnection.setRemoteDescription(data.answer);
            }
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(data) {
        try {
            const peerConnection = this.peers.get(data.fromUserId);
            if (peerConnection) {
                await peerConnection.addIceCandidate(data.candidate);
            }
        } catch (error) {
            console.error('Error handling ICE candidate:', error);
        }
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
        this.lastX = coords.x;
        this.lastY = coords.y;
    }

    draw(e) {
        if (!this.isDrawing) return;
        
        const coords = this.getCanvasCoordinates(e);
        
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        
        this.ctx.beginPath();
        this.ctx.moveTo(this.lastX, this.lastY);
        this.ctx.lineTo(coords.x, coords.y);
        this.ctx.stroke();
        
        const drawingData = {
            type: 'draw',
            fromX: this.lastX,
            fromY: this.lastY,
            toX: coords.x,
            toY: coords.y,
            color: this.currentColor,
            size: this.currentSize,
            userId: this.userId
        };
        
        this.broadcastDrawing(drawingData);
        
        this.lastX = coords.x;
        this.lastY = coords.y;
    }

    stopDrawing() {
        this.isDrawing = false;
    }

    broadcastDrawing(data) {
        // Send via WebRTC data channels
        this.dataChannels.forEach((channel) => {
            if (channel.readyState === 'open') {
                try {
                    channel.send(JSON.stringify(data));
                } catch (error) {
                    console.error('Error sending via data channel:', error);
                }
            }
        });
        
        // Fallback: send via HTTP API for users without WebRTC
        this.sendDrawingData(data);
    }

    async sendDrawingData(data) {
        try {
            await fetch('/api/broadcast-drawing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fromUserId: this.userId,
                    drawingData: data,
                    sessionId: this.sessionId
                })
            });
        } catch (error) {
            console.error('Error sending drawing data:', error);
        }
    }

    handleRemoteDrawing(data) {
        if (data.userId === this.userId) return;
        
        if (data.type === 'draw') {
            this.ctx.strokeStyle = data.color;
            this.ctx.lineWidth = data.size;
            
            this.ctx.beginPath();
            this.ctx.moveTo(data.fromX, data.fromY);
            this.ctx.lineTo(data.toX, data.toY);
            this.ctx.stroke();
        } else if (data.type === 'clear') {
            this.clearCanvas();
        }
    }

    clearCanvas() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    updateUserCount(count) {
        document.getElementById('userCount').textContent = `${count} users online`;
    }

    updateConnectionStatus(status) {
        const statusElement = document.getElementById('connectionStatus');
        statusElement.className = status;
        
        switch (status) {
            case 'connected':
                statusElement.textContent = 'Connected';
                break;
            case 'connecting':
                statusElement.textContent = 'Connecting...';
                break;
            case 'disconnected':
                statusElement.textContent = 'Disconnected';
                break;
        }
    }

    // Cleanup when page unloads
    async cleanup() {
        try {
            await fetch('/api/leave-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: this.userId, sessionId: this.sessionId })
            });
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const canvas = new CollaborativeCanvas();
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        canvas.cleanup();
    });
});
