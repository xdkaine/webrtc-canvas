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
        this.nickname = this.getUserNickname();
        this.sessionId = 'default';
        this.lastSignalCheck = 0;
        this.lastDrawingCheck = 0;
        
        // Drawing path management
        this.currentPath = [];
        this.drawingBuffer = [];
        this.lastSentTime = 0;
        
        // Canvas dimensions for coordinate normalization
        this.canvasWidth = 800;
        this.canvasHeight = 600;
        
        // User management
        this.connectedUsers = new Map();
        this.remoteCursors = new Map();
        
        // Chat management
        this.chatMessages = [];
        this.chatBuffer = [];
        
        this.initializeCanvas();
        this.initializeControls();
        this.initializeUserInterface();
        this.initializeChat();
        this.initializeWebRTC();
        this.joinSession();
        this.startPolling();
    }

    generateUserId() {
        return 'user_' + Math.random().toString(36).substr(2, 9);
    }

    getUserNickname() {
        // Check if user has a saved nickname
        let nickname = localStorage.getItem('canvas_nickname');
        if (!nickname) {
            // Show custom nickname modal instead of browser prompt
            this.showNicknameModal();
            return 'Anonymous'; // Temporary until modal completes
        }
        return nickname;
    }

    showNicknameModal() {
        // Create modal overlay
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
        
        // Focus the input
        const input = document.getElementById('nicknameInput');
        input.focus();
        
        // Handle form submission
        const handleSubmit = () => {
            const inputValue = input.value.trim();
            let finalNickname = 'Anonymous';
            
            if (inputValue !== '') {
                // Sanitize nickname for XSS protection
                finalNickname = this.sanitizeInput(inputValue);
                finalNickname = finalNickname.substring(0, 20); // Limit length
            }
            
            this.nickname = finalNickname;
            localStorage.setItem('canvas_nickname', finalNickname);
            
            // Update UI
            const nicknameDisplay = document.getElementById('currentNickname');
            if (nicknameDisplay) {
                nicknameDisplay.textContent = finalNickname;
            }
            
            // Remove modal
            modalOverlay.remove();
            
            // Broadcast updated user info
            this.broadcastUserInfo();
        };
        
        // Event listeners
        document.getElementById('nicknameConfirm').addEventListener('click', handleSubmit);
        document.getElementById('nicknameCancel').addEventListener('click', () => {
            this.nickname = 'Anonymous';
            localStorage.setItem('canvas_nickname', 'Anonymous');
            
            const nicknameDisplay = document.getElementById('currentNickname');
            if (nicknameDisplay) {
                nicknameDisplay.textContent = 'Anonymous';
            }
            
            modalOverlay.remove();
            this.broadcastUserInfo();
        });
        
        // Handle Enter key
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleSubmit();
            }
        });
        
        // Handle Escape key
        document.addEventListener('keydown', function escapeHandler(e) {
            if (e.key === 'Escape') {
                document.getElementById('nicknameCancel').click();
                document.removeEventListener('keydown', escapeHandler);
            }
        });
    }

    sanitizeInput(input) {
        // Basic XSS protection - remove HTML tags and escape special characters
        return input
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');
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
        
        // Poll for drawing updates every 100ms for better responsiveness
        setInterval(() => this.pollForDrawingUpdates(), 100);
        
        // Update session info every 5 seconds
        setInterval(() => this.updateSessionInfo(), 5000);
        
        // Send drawing buffer every 50ms for smooth real-time drawing
        setInterval(() => this.flushDrawingBuffer(), 50);
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
        // Set fixed canvas dimensions for consistent coordinate system
        this.canvas.width = this.canvasWidth;
        this.canvas.height = this.canvasHeight;
        
        // Set up canvas for drawing with consistent properties
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
            const clearData = {
                type: 'clear',
                userId: this.userId,
                timestamp: Date.now()
            };
            this.broadcastDrawing(clearData);
        });

        // initialize preview
        this.updatePreview(previewDot);
    }

    initializeUserInterface() {
        // Create users panel if it doesn't exist
        if (!document.getElementById('usersPanel')) {
            this.createUsersPanel();
        }
        
        // Create cursors container
        if (!document.getElementById('cursorsContainer')) {
            this.createCursorsContainer();
        }
        
        // Add nickname change functionality
        const nicknameBtn = document.getElementById('changeNickname');
        if (nicknameBtn) {
            nicknameBtn.addEventListener('click', () => this.changeNickname());
        }
    }

    createUsersPanel() {
        const usersPanel = document.createElement('div');
        usersPanel.id = 'usersPanel';
        usersPanel.className = 'users-panel';
        usersPanel.innerHTML = `
            <h3>Connected Users</h3>
            <div id="usersList"></div>
            <div class="nickname-section">
                <span>You: <strong id="currentNickname">${this.nickname}</strong></span>
                <button id="changeNickname" class="btn-small">Change</button>
            </div>
        `;
        document.body.appendChild(usersPanel);
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

    changeNickname() {
        this.showChangeNicknameModal();
    }

    showChangeNicknameModal() {
        // Create modal overlay
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'changeNicknameModal';
        modalOverlay.className = 'modal-overlay';
        modalOverlay.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Change Nickname</h3>
                    <p>Update your display name</p>
                </div>
                <div class="modal-body">
                    <input type="text" id="changeNicknameInput" class="nickname-input" 
                           placeholder="Your nickname" value="${this.nickname}" maxlength="20" autocomplete="off">
                    <p class="modal-hint">Leave empty to become anonymous</p>
                </div>
                <div class="modal-footer">
                    <button id="changeNicknameCancel" class="btn-secondary">Cancel</button>
                    <button id="changeNicknameConfirm" class="btn-primary">Update</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modalOverlay);
        
        // Focus the input and select existing text
        const input = document.getElementById('changeNicknameInput');
        input.focus();
        input.select();
        
        // Handle form submission
        const handleSubmit = () => {
            const inputValue = input.value.trim();
            let finalNickname = 'Anonymous';
            
            if (inputValue !== '') {
                finalNickname = this.sanitizeInput(inputValue).substring(0, 20);
            }
            
            this.nickname = finalNickname;
            localStorage.setItem('canvas_nickname', finalNickname);
            
            // Update UI
            const nicknameDisplay = document.getElementById('currentNickname');
            if (nicknameDisplay) {
                nicknameDisplay.textContent = finalNickname;
            }
            
            // Remove modal
            modalOverlay.remove();
            
            // Broadcast nickname change
            this.broadcastUserInfo();
        };
        
        // Event listeners
        document.getElementById('changeNicknameConfirm').addEventListener('click', handleSubmit);
        document.getElementById('changeNicknameCancel').addEventListener('click', () => {
            modalOverlay.remove();
        });
        
        // Handle Enter key
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleSubmit();
            }
        });
        
        // Handle Escape key
        document.addEventListener('keydown', function escapeHandler(e) {
            if (e.key === 'Escape') {
                modalOverlay.remove();
                document.removeEventListener('keydown', escapeHandler);
            }
        });
        
        // Close on overlay click
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                modalOverlay.remove();
            }
        });
    }

    broadcastUserInfo() {
        const userInfo = {
            type: 'user-info',
            userId: this.userId,
            nickname: this.nickname,
            timestamp: Date.now()
        };
        
        this.dataChannels.forEach((channel) => {
            if (channel.readyState === 'open') {
                try {
                    channel.send(JSON.stringify(userInfo));
                } catch (error) {
                    console.error('Error sending user info:', error);
                }
            }
        });
    }

    updatePreview(previewDot) {
        if (!previewDot) return;
        const size = Math.max(6, Math.min(40, this.currentSize));
        previewDot.style.width = `${size}px`;
        previewDot.style.height = `${size}px`;
        previewDot.style.background = this.currentColor;
        previewDot.style.borderColor = this.currentColor.toLowerCase() === '#ffffff' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.9)';
    }

    initializeChat() {
        // Create chat panel if it doesn't exist
        if (!document.getElementById('chatPanel')) {
            this.createChatPanel();
        }
        
        const chatInput = document.getElementById('chatInput');
        const sendButton = document.getElementById('sendMessage');
        
        if (chatInput && sendButton) {
            // Handle send button click
            sendButton.addEventListener('click', () => this.sendChatMessage());
            
            // Handle Enter key
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendChatMessage();
                }
            });
        }
    }

    createChatPanel() {
        const chatPanel = document.createElement('div');
        chatPanel.id = 'chatPanel';
        chatPanel.className = 'chat-panel';
        chatPanel.innerHTML = `
            <h3>Chat</h3>
            <div id="chatMessages" class="chat-messages"></div>
            <div class="chat-input-container">
                <input type="text" id="chatInput" placeholder="Type a message..." maxlength="200">
                <button id="sendMessage" class="btn-small">Send</button>
            </div>
        `;
        document.body.appendChild(chatPanel);
    }

    sendChatMessage() {
        const chatInput = document.getElementById('chatInput');
        if (!chatInput) return;
        
        const message = chatInput.value.trim();
        if (message === '') return;
        
        // Sanitize message for XSS protection
        const sanitizedMessage = this.sanitizeInput(message);
        
        const chatData = {
            type: 'chat-message',
            userId: this.userId,
            nickname: this.nickname,
            message: sanitizedMessage,
            timestamp: Date.now()
        };
        
        // Add to local chat
        this.addChatMessage(chatData);
        
        // Broadcast to other users
        this.dataChannels.forEach((channel) => {
            if (channel.readyState === 'open') {
                try {
                    channel.send(JSON.stringify(chatData));
                } catch (error) {
                    console.error('Error sending chat message:', error);
                }
            }
        });
        
        // Clear input
        chatInput.value = '';
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
            
            // Send user info to the new peer
            const userInfo = {
                type: 'user-info',
                userId: this.userId,
                nickname: this.nickname,
                timestamp: Date.now()
            };
            
            try {
                dataChannel.send(JSON.stringify(userInfo));
            } catch (error) {
                console.error('Error sending user info:', error);
            }
            
            // Request canvas state from the new peer
            try {
                dataChannel.send(JSON.stringify({
                    type: 'request-canvas-state',
                    userId: this.userId,
                    timestamp: Date.now()
                }));
            } catch (error) {
                console.error('Error requesting canvas state:', error);
            }
        };
        
        dataChannel.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            if (data.type === 'request-canvas-state') {
                // Send current canvas state as an image
                this.sendCanvasState(dataChannel);
            } else if (data.type === 'canvas-state') {
                // Receive and apply canvas state
                this.applyCanvasState(data);
            } else if (data.type === 'user-info') {
                // Handle user info updates
                this.updateUserInfo(data);
            } else if (data.type === 'chat-message') {
                // Handle chat messages
                this.addChatMessage(data);
            } else if (data.type === 'cursor-position') {
                // Handle cursor position updates
                this.updateRemoteCursor(data);
            } else {
                this.handleRemoteDrawing(data);
            }
        };
        
        dataChannel.onerror = (error) => {
            console.error(`Data channel error with ${userId}:`, error);
        };
    }

    sendCanvasState(dataChannel) {
        try {
            const imageData = this.canvas.toDataURL('image/png');
            dataChannel.send(JSON.stringify({
                type: 'canvas-state',
                imageData: imageData,
                userId: this.userId,
                timestamp: Date.now()
            }));
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
            img.src = data.imageData;
        } catch (error) {
            console.error('Error applying canvas state:', error);
        }
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

    updateUserInfo(data) {
        this.connectedUsers.set(data.userId, {
            userId: data.userId,
            nickname: data.nickname,
            lastSeen: data.timestamp
        });
        this.updateUsersList();
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
        
        // Remove user from connected users
        this.connectedUsers.delete(userId);
        this.updateUsersList();
        
        // Remove user's cursor
        const cursor = this.remoteCursors.get(userId);
        if (cursor) {
            cursor.remove();
            this.remoteCursors.delete(userId);
        }
    }

    getCanvasCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        
        // Normalize coordinates to canvas dimensions (0-1 range)
        const normalizedX = (e.clientX - rect.left) / rect.width;
        const normalizedY = (e.clientY - rect.top) / rect.height;
        
        // Convert to actual canvas coordinates
        return {
            x: normalizedX * this.canvasWidth,
            y: normalizedY * this.canvasHeight,
            // Also include normalized coordinates for transmission
            normalizedX: normalizedX,
            normalizedY: normalizedY
        };
    }

    startDrawing(e) {
        this.isDrawing = true;
        const coords = this.getCanvasCoordinates(e);
        this.lastX = coords.x;
        this.lastY = coords.y;
        
        // Start a new drawing path
        this.currentPath = [{
            x: coords.x,
            y: coords.y,
            normalizedX: coords.normalizedX,
            normalizedY: coords.normalizedY,
            color: this.currentColor,
            size: this.currentSize,
            timestamp: Date.now()
        }];
        
        // Send path start event
        const pathStartData = {
            type: 'path-start',
            x: coords.x,
            y: coords.y,
            normalizedX: coords.normalizedX,
            normalizedY: coords.normalizedY,
            color: this.currentColor,
            size: this.currentSize,
            userId: this.userId,
            timestamp: Date.now()
        };
        
        this.addToDrawingBuffer(pathStartData);
    }

    draw(e) {
        if (!this.isDrawing) return;
        
        const coords = this.getCanvasCoordinates(e);
        
        // Draw locally
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.currentSize;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        
        this.ctx.beginPath();
        this.ctx.moveTo(this.lastX, this.lastY);
        this.ctx.lineTo(coords.x, coords.y);
        this.ctx.stroke();
        
        // Add to current path
        this.currentPath.push({
            x: coords.x,
            y: coords.y,
            normalizedX: coords.normalizedX,
            normalizedY: coords.normalizedY,
            color: this.currentColor,
            size: this.currentSize,
            timestamp: Date.now()
        });
        
        // Create drawing data for transmission
        const drawingData = {
            type: 'path-point',
            fromX: this.lastX,
            fromY: this.lastY,
            toX: coords.x,
            toY: coords.y,
            normalizedFromX: this.lastNormalizedX || coords.normalizedX,
            normalizedFromY: this.lastNormalizedY || coords.normalizedY,
            normalizedToX: coords.normalizedX,
            normalizedToY: coords.normalizedY,
            color: this.currentColor,
            size: this.currentSize,
            userId: this.userId,
            timestamp: Date.now()
        };
        
        this.addToDrawingBuffer(drawingData);
        
        this.lastX = coords.x;
        this.lastY = coords.y;
        this.lastNormalizedX = coords.normalizedX;
        this.lastNormalizedY = coords.normalizedY;
    }

    stopDrawing() {
        if (!this.isDrawing) return;
        
        this.isDrawing = false;
        
        // Send path end event
        const pathEndData = {
            type: 'path-end',
            userId: this.userId,
            timestamp: Date.now(),
            pathLength: this.currentPath.length
        };
        
        this.addToDrawingBuffer(pathEndData);
        
        // Clear current path
        this.currentPath = [];
        this.lastNormalizedX = undefined;
        this.lastNormalizedY = undefined;
    }

    sendCursorPosition(e) {
        // Throttle cursor updates to avoid flooding
        const now = Date.now();
        if (now - (this.lastCursorSent || 0) < 50) return; // Max 20 updates per second
        this.lastCursorSent = now;
        
        const coords = this.getCanvasCoordinates(e);
        const cursorData = {
            type: 'cursor-position',
            userId: this.userId,
            nickname: this.nickname,
            x: coords.x,
            y: coords.y,
            normalizedX: coords.normalizedX,
            normalizedY: coords.normalizedY,
            isDrawing: this.isDrawing,
            color: this.currentColor,
            size: this.currentSize,
            timestamp: now
        };
        
        this.dataChannels.forEach((channel) => {
            if (channel.readyState === 'open') {
                try {
                    channel.send(JSON.stringify(cursorData));
                } catch (error) {
                    // Silently ignore cursor position errors to avoid spam
                }
            }
        });
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

    addToDrawingBuffer(data) {
        this.drawingBuffer.push(data);
    }

    flushDrawingBuffer() {
        if (this.drawingBuffer.length === 0) return;
        
        // Send all buffered drawing data
        const bufferCopy = [...this.drawingBuffer];
        this.drawingBuffer = [];
        
        bufferCopy.forEach(data => {
            this.broadcastDrawing(data);
        });
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
        
        // Use normalized coordinates for consistent positioning across different screen sizes
        const fromX = data.normalizedFromX !== undefined ? 
            data.normalizedFromX * this.canvasWidth : data.fromX;
        const fromY = data.normalizedFromY !== undefined ? 
            data.normalizedFromY * this.canvasHeight : data.fromY;
        const toX = data.normalizedToX !== undefined ? 
            data.normalizedToX * this.canvasWidth : data.toX;
        const toY = data.normalizedToY !== undefined ? 
            data.normalizedToY * this.canvasHeight : data.toY;
        const x = data.normalizedX !== undefined ? 
            data.normalizedX * this.canvasWidth : data.x;
        const y = data.normalizedY !== undefined ? 
            data.normalizedY * this.canvasHeight : data.y;
        
        if (data.type === 'draw' || data.type === 'path-point') {
            // Set consistent drawing properties
            this.ctx.strokeStyle = data.color;
            this.ctx.lineWidth = data.size;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            
            this.ctx.beginPath();
            this.ctx.moveTo(fromX, fromY);
            this.ctx.lineTo(toX, toY);
            this.ctx.stroke();
        } else if (data.type === 'path-start') {
            // Store the start of a new remote path
            this.ctx.strokeStyle = data.color;
            this.ctx.lineWidth = data.size;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            
            // Draw a small dot at the start point
            this.ctx.beginPath();
            this.ctx.arc(x, y, data.size / 2, 0, 2 * Math.PI);
            this.ctx.fill();
        } else if (data.type === 'path-end') {
            // Path ended - could add any cleanup logic here
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
