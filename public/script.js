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
        const colorTrigger = document.getElementById('colorTrigger');
        const colorPopover = document.getElementById('colorPopover');
        const colorHexLabel = document.getElementById('colorHexLabel');
        const colorHexInput = document.getElementById('colorHexInput');
        const applyHexBtn = document.getElementById('applyHex');
        const colorSquare = document.getElementById('colorSquare');
        const hueSlider = document.getElementById('hueSlider');
        let picking = { h: 0, s: 0, v: 0 }; // HSV state
        const brushSize = document.getElementById('brushSize');
        const sizeDisplay = document.getElementById('sizeDisplay');
        const clearButton = document.getElementById('clearCanvas');
        const sizeNumber = document.getElementById('brushSizeNumber');
        const sizeInc = document.getElementById('sizeInc');
        const sizeDec = document.getElementById('sizeDec');
        const previewDot = document.getElementById('brushPreviewCircle');
        const swatches = document.querySelectorAll('.swatch');
        const quickSizes = document.querySelectorAll('.size-quick');
        
        // Custom color picker popover
        const closePopover = () => {
            if (!colorPopover) return;
            colorPopover.hidden = true;
            if (colorTrigger) colorTrigger.setAttribute('aria-expanded', 'false');
        };
        const openPopover = () => {
            if (!colorPopover) return;
            colorPopover.hidden = false;
            if (colorTrigger) colorTrigger.setAttribute('aria-expanded', 'true');
            // draw after layout is applied
            requestAnimationFrame(() => {
                drawHue();
                drawSV();
                // draw once more next frame for safety on some browsers
                requestAnimationFrame(() => {
                    drawHue();
                    drawSV();
                });
            });
        };

        const hexFromHSV = (h, s, v) => {
            const f = (n, k=(n+h/60)%6) => v - v*s*Math.max(Math.min(k,4-k,1),0);
            const r = Math.round(f(5)*255), g = Math.round(f(3)*255), b = Math.round(f(1)*255);
            return '#' + [r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');
        };
        const setupCanvasDPR = (canvas) => {
            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            const needResize = canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr);
            if (needResize) {
                canvas.width = Math.round(rect.width * dpr);
                canvas.height = Math.round(rect.height * dpr);
                const ctx = canvas.getContext('2d');
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }
            return { width: rect.width, height: rect.height };
        };
        const drawHue = () => {
            if (!hueSlider) return;
            const ctx = hueSlider.getContext('2d');
            const { width, height } = setupCanvasDPR(hueSlider);
            ctx.clearRect(0, 0, width, height);
            const grd = ctx.createLinearGradient(0, 0, 0, height);
            grd.addColorStop(0, '#ff0000');
            grd.addColorStop(1/6, '#ffff00');
            grd.addColorStop(2/6, '#00ff00');
            grd.addColorStop(3/6, '#00ffff');
            grd.addColorStop(4/6, '#0000ff');
            grd.addColorStop(5/6, '#ff00ff');
            grd.addColorStop(1, '#ff0000');
            ctx.fillStyle = grd;
            ctx.fillRect(0, 0, width, height);
        };
        const drawSV = () => {
            if (!colorSquare) return;
            const ctx = colorSquare.getContext('2d');
            const { width, height } = setupCanvasDPR(colorSquare);
            ctx.clearRect(0, 0, width, height);
            // base hue
            ctx.fillStyle = hexFromHSV(picking.h, 1, 1);
            ctx.fillRect(0, 0, width, height);
            // white gradient left->right (saturation)
            const grdWhite = ctx.createLinearGradient(0, 0, width, 0);
            grdWhite.addColorStop(0, '#ffffff');
            grdWhite.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = grdWhite;
            ctx.fillRect(0, 0, width, height);
            // black gradient top->bottom (value)
            const grdBlack = ctx.createLinearGradient(0, 0, 0, height);
            grdBlack.addColorStop(0, 'rgba(0,0,0,0)');
            grdBlack.addColorStop(1, '#000000');
            ctx.fillStyle = grdBlack;
            ctx.fillRect(0, 0, width, height);
        };
        const updateFromHSV = () => {
            const hex = hexFromHSV(picking.h, picking.s, picking.v);
            this.currentColor = hex;
            if (colorPicker) colorPicker.value = hex;
            if (colorHexLabel) colorHexLabel.textContent = hex;
            if (colorHexInput) colorHexInput.value = hex;
            if (previewDot) this.updatePreview(previewDot);
            const triggerDot = document.querySelector('.trigger-dot');
            if (triggerDot) triggerDot.style.setProperty('--c', hex);
        };

        if (colorTrigger) {
            colorTrigger.addEventListener('click', () => {
                if (!colorPopover) return;
                if (colorPopover.hidden) openPopover(); else closePopover();
            });
        }
        document.addEventListener('click', (e) => {
            if (!colorPopover) return;
            if (e.target === colorPopover || e.target === colorTrigger || colorPopover.contains(e.target)) return;
            closePopover();
        });

        // Interactions: hue and SV
        const pointer = {
            down: false,
            onDown: (el, cb) => {
                el.addEventListener('mousedown', (e)=>{ pointer.down=true; cb(e); });
                el.addEventListener('touchstart', (e)=>{ pointer.down=true; cb(e.touches[0]); e.preventDefault(); }, {passive:false});
            },
            onMove: (el, cb) => {
                el.addEventListener('mousemove', (e)=>{ if(pointer.down) cb(e); });
                el.addEventListener('touchmove', (e)=>{ if(pointer.down){ cb(e.touches[0]); e.preventDefault(); } }, {passive:false});
            },
            onUpGlobal: () => {
                window.addEventListener('mouseup', ()=> pointer.down=false);
                window.addEventListener('touchend', ()=> pointer.down=false);
            }
        };
        pointer.onUpGlobal();

        const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
    if (hueSlider) {
            const pickHue = (pt) => {
        const rect = hueSlider.getBoundingClientRect();
                const y = clamp(pt.clientY - rect.top, 0, rect.height);
                picking.h = (y / rect.height) * 360;
                drawSV();
                updateFromHSV();
            };
            pointer.onDown(hueSlider, pickHue);
            pointer.onMove(hueSlider, pickHue);
        }
        if (colorSquare) {
            const pickSV = (pt) => {
                const rect = colorSquare.getBoundingClientRect();
                const x = clamp(pt.clientX - rect.left, 0, rect.width);
                const y = clamp(pt.clientY - rect.top, 0, rect.height);
                picking.s = x / rect.width; // saturation 0..1
                picking.v = 1 - (y / rect.height); // value 0..1
                updateFromHSV();
            };
            pointer.onDown(colorSquare, pickSV);
            pointer.onMove(colorSquare, pickSV);
        }

        // Redraw on resize for crisp gradients
        window.addEventListener('resize', () => {
            drawHue();
            drawSV();
        });

        // Redraw when canvas elements resize (e.g., CSS changes)
        if (window.ResizeObserver && colorSquare && hueSlider) {
            const ro = new ResizeObserver(() => { drawHue(); drawSV(); });
            ro.observe(colorSquare);
            ro.observe(hueSlider);
        }

        if (applyHexBtn && colorHexInput) {
            applyHexBtn.addEventListener('click', () => {
                const val = (colorHexInput.value || '').trim();
                const ok = /^#([0-9a-fA-F]{6})$/.test(val);
                if (ok) {
                    this.currentColor = val;
                    colorPicker.value = val;
                    colorHexLabel.textContent = val;
                    const triggerDot = document.querySelector('.trigger-dot');
                    if (triggerDot) triggerDot.style.setProperty('--c', val);
                    this.updatePreview(previewDot);
                }
            });
        }
        
        brushSize.addEventListener('input', (e) => {
            this.currentSize = Number(e.target.value);
            sizeDisplay.textContent = String(this.currentSize);
            if (sizeNumber) sizeNumber.value = String(this.currentSize);
            this.updatePreview(previewDot);
        });
        
        if (sizeNumber) {
            sizeNumber.addEventListener('input', (e) => {
                const val = Math.max(1, Math.min(50, Number(e.target.value)) || 1);
                this.currentSize = val;
                brushSize.value = String(val);
                sizeDisplay.textContent = String(val);
                this.updatePreview(previewDot);
            });
        }

        if (sizeInc) {
            sizeInc.addEventListener('click', () => {
                const val = Math.min(50, this.currentSize + 1);
                this.currentSize = val;
                brushSize.value = String(val);
                if (sizeNumber) sizeNumber.value = String(val);
                sizeDisplay.textContent = String(val);
                this.updatePreview(previewDot);
            });
        }

        if (sizeDec) {
            sizeDec.addEventListener('click', () => {
                const val = Math.max(1, this.currentSize - 1);
                this.currentSize = val;
                brushSize.value = String(val);
                if (sizeNumber) sizeNumber.value = String(val);
                sizeDisplay.textContent = String(val);
                this.updatePreview(previewDot);
            });
        }

        swatches.forEach(btn => {
            btn.addEventListener('click', () => {
                const c = btn.getAttribute('data-color');
                if (!c) return;
                this.currentColor = c;
                colorPicker.value = c;
                this.updatePreview(previewDot);
            });
        });

        quickSizes.forEach(btn => {
            btn.addEventListener('click', () => {
                const s = Number(btn.getAttribute('data-size')) || 5;
                this.currentSize = Math.max(1, Math.min(50, s));
                brushSize.value = String(this.currentSize);
                if (sizeNumber) sizeNumber.value = String(this.currentSize);
                sizeDisplay.textContent = String(this.currentSize);
                this.updatePreview(previewDot);
            });
        });

        clearButton.addEventListener('click', () => {
            this.clearCanvas();
            this.broadcastDrawing({
                type: 'clear',
                userId: this.userId
            });
        });

        // initialize preview
        this.updatePreview(previewDot);
    }

    updatePreview(previewDot) {
        if (!previewDot) return;
        const size = Math.max(6, Math.min(40, this.currentSize));
        previewDot.style.width = `${size}px`;
        previewDot.style.height = `${size}px`;
        previewDot.style.background = this.currentColor;
        previewDot.style.borderColor = this.currentColor.toLowerCase() === '#ffffff' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.9)';
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
