class CollaborativeCanvas {
    constructor() {
        this.canvas = document.getElementById('drawingCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.socket = io();
        this.peers = new Map();
        this.dataChannels = new Map();
        
        this.isDrawing = false;
        this.currentColor = '#000000';
        this.currentSize = 5;
        this.userId = this.generateUserId();
        
        this.initializeCanvas();
        this.initializeControls();
        this.initializeWebRTC();
        this.initializeSocketEvents();
    }

    generateUserId() {
        return 'user_' + Math.random().toString(36).substr(2, 9);
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

    initializeSocketEvents() {
        this.socket.on('connect', () => {
            console.log('Connected to signaling server');
            this.updateConnectionStatus('connected');
            this.socket.emit('join-room', this.userId);
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from signaling server');
            this.updateConnectionStatus('disconnected');
        });

        this.socket.on('user-connected', (userId) => {
            console.log('User connected:', userId);
            this.createPeerConnection(userId, true);
        });

        this.socket.on('user-disconnected', (userId) => {
            console.log('User disconnected:', userId);
            this.removePeer(userId);
        });

        this.socket.on('user-count', (count) => {
            document.getElementById('userCount').textContent = `${count} users online`;
        });

        this.socket.on('webrtc-offer', async (data) => {
            await this.handleOffer(data);
        });

        this.socket.on('webrtc-answer', async (data) => {
            await this.handleAnswer(data);
        });

        this.socket.on('webrtc-ice-candidate', async (data) => {
            await this.handleIceCandidate(data);
        });

        // Fallback for users without WebRTC support
        this.socket.on('drawing-data', (data) => {
            if (data.userId !== this.userId) {
                this.handleRemoteDrawing(data);
            }
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
                    this.socket.emit('webrtc-ice-candidate', {
                        candidate: event.candidate,
                        targetUserId: userId,
                        fromUserId: this.userId
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
                
                this.socket.emit('webrtc-offer', {
                    offer: offer,
                    targetUserId: userId,
                    fromUserId: this.userId
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
                    this.socket.emit('webrtc-ice-candidate', {
                        candidate: event.candidate,
                        targetUserId: data.fromUserId,
                        fromUserId: this.userId
                    });
                }
            };

            await peerConnection.setRemoteDescription(data.offer);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            this.socket.emit('webrtc-answer', {
                answer: answer,
                targetUserId: data.fromUserId,
                fromUserId: this.userId
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
        
        // Fallback: send via socket.io for users without WebRTC
        this.socket.emit('drawing-data', data);
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
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new CollaborativeCanvas();
});
