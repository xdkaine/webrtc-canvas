document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // Modal elements
    const modalOverlay = document.getElementById('modal-overlay');
    const nicknameInput = document.getElementById('nickname-input');
    const joinBtn = document.getElementById('join-btn');

    // Canvas elements
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const cursor = document.getElementById('cursor');

    // Toolbar elements
    const penToolBtn = document.getElementById('pen-tool');
    const eraserToolBtn = document.getElementById('eraser-tool');
    const colorPalette = document.getElementById('color-palette');
    const colorPicker = document.getElementById('color-picker');
    const brushSizeSlider = document.getElementById('brush-size');
    const sizeValue = document.getElementById('size-value');
    const quickSizeBtns = document.querySelectorAll('.size-btn');
    const clearBtn = document.getElementById('clear-btn');

    // Sidebar tabs
    const chatTabBtn = document.getElementById('chat-tab');
    const usersTabBtn = document.getElementById('users-tab');
    const chatContent = document.getElementById('chat-content');
    const usersContent = document.getElementById('users-content');

    // Chat elements
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const emojiBtn = document.getElementById('emoji-btn');
    const emojiPicker = document.getElementById('emoji-picker');

    // Users list
    const userCount = document.getElementById('user-count');
    const usersList = document.getElementById('users-list');

    let drawing = false;
    let nickname = '';
    let currentTool = 'pen';
    let lastX = 0;
    let lastY = 0;

    const presetColors = [
        '#000000', '#e74c3c', '#f39c12', '#f1c40f', '#2ecc71', '#1abc9c', 
        '#3498db', '#9b59b6', '#34495e', '#95a5a6', '#ffffff'
    ];

    // --- Initialization ---

    function init() {
        setupCanvas();
        setupToolbar();
        setupTabs();
        setupChat();
        setupSocketListeners();
    }

    function setupCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
    }

    function setupToolbar() {
        // Color Palette
        presetColors.forEach(color => {
            const swatch = document.createElement('div');
            swatch.classList.add('color-swatch');
            swatch.style.backgroundColor = color;
            swatch.dataset.color = color;
            if (color.toLowerCase() === colorPicker.value.toLowerCase()) {
                swatch.classList.add('active');
            }
            colorPalette.appendChild(swatch);
        });

        colorPalette.addEventListener('click', (e) => {
            if (e.target.classList.contains('color-swatch')) {
                const color = e.target.dataset.color;
                colorPicker.value = color;
                updateActiveColor(e.target);
                updateCursor();
            }
        });

        colorPicker.addEventListener('input', () => {
            updateActiveColor();
            updateCursor();
        });

        // Tool selection
        penToolBtn.addEventListener('click', () => selectTool('pen'));
        eraserToolBtn.addEventListener('click', () => selectTool('eraser'));

        // Brush size
        brushSizeSlider.addEventListener('input', () => {
            sizeValue.textContent = brushSizeSlider.value;
            updateActiveSize();
            updateCursor();
        });

        quickSizeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const size = btn.dataset.size;
                brushSizeSlider.value = size;
                sizeValue.textContent = size;
                updateActiveSize(btn);
                updateCursor();
            });
        });

        clearBtn.addEventListener('click', () => {
            socket.emit('clearCanvas');
        });

        // Set initial state
        sizeValue.textContent = brushSizeSlider.value;
        updateActiveColor(document.querySelector(`.color-swatch[data-color="${colorPicker.value}"]`));
        updateActiveSize(document.querySelector(`.size-btn[data-size="${brushSizeSlider.value}"]`));
        selectTool('pen');
    }

    function setupTabs() {
        chatTabBtn.addEventListener('click', () => switchTab('chat'));
        usersTabBtn.addEventListener('click', () => switchTab('users'));
    }

    function setupChat() {
        joinBtn.addEventListener('click', joinChat);
        nicknameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') joinChat();
        });

        sendBtn.addEventListener('click', sendMessage);
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });

        emojiBtn.addEventListener('click', () => {
            emojiPicker.classList.toggle('hidden');
        });

        // Populate emoji picker
        const emojis = ['😀', '😂', '😍', '🤔', '👍', '❤️', '🔥', '🎉', '👋', '😢', '😮', '🤯'];
        emojis.forEach(emoji => {
            const span = document.createElement('span');
            span.textContent = emoji;
            span.addEventListener('click', () => {
                chatInput.value += emoji;
                emojiPicker.classList.add('hidden');
                chatInput.focus();
            });
            emojiPicker.appendChild(span);
        });
    }

    // --- Event Handlers & UI Updates ---

    function joinChat() {
        const nick = nicknameInput.value.trim();
        if (nick) {
            nickname = sanitize(nick);
            socket.emit('join', nickname);
            modalOverlay.style.display = 'none';
        }
    }

    function selectTool(tool) {
        currentTool = tool;
        penToolBtn.classList.toggle('active', tool === 'pen');
        eraserToolBtn.classList.toggle('active', tool === 'eraser');
        updateCursor();
    }

    function updateActiveColor(activeSwatch = null) {
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        if (activeSwatch) {
            activeSwatch.classList.add('active');
        } else {
            // If custom color, find if it matches a swatch
            const matchingSwatch = document.querySelector(`.color-swatch[data-color="${colorPicker.value.toLowerCase()}"]`);
            if (matchingSwatch) matchingSwatch.classList.add('active');
        }
    }

    function updateActiveSize(activeBtn = null) {
        quickSizeBtns.forEach(b => b.classList.remove('active'));
        if (activeBtn) {
            activeBtn.classList.add('active');
        } else {
            const matchingBtn = document.querySelector(`.size-btn[data-size="${brushSizeSlider.value}"]`);
            if (matchingBtn) matchingBtn.classList.add('active');
        }
    }

    function switchTab(tab) {
        chatTabBtn.classList.toggle('active', tab === 'chat');
        usersTabBtn.classList.toggle('active', tab === 'users');
        chatContent.classList.toggle('active', tab === 'chat');
        usersContent.classList.toggle('active', tab === 'users');
    }

    function sendMessage() {
        const message = chatInput.value.trim();
        if (message) {
            socket.emit('chatMessage', message);
            chatInput.value = '';
        }
    }

    function sanitize(str) {
        const temp = document.createElement('div');
        temp.textContent = str;
        return temp.innerHTML;
    }

    function updateCursor(e) {
        const size = brushSizeSlider.value;
        cursor.style.width = `${size}px`;
        cursor.style.height = `${size}px`;
        
        if (currentTool === 'pen') {
            cursor.style.background = 'transparent';
            cursor.style.border = `2px solid ${colorPicker.value}`;
        } else { // eraser
            cursor.style.background = 'rgba(255, 255, 255, 0.8)';
            cursor.style.border = `2px solid #333`;
        }

        if (e) {
            const rect = canvas.getBoundingClientRect();
            cursor.style.left = `${e.clientX - rect.left}px`;
            cursor.style.top = `${e.clientY - rect.top}px`;
        }
    }

    // --- Drawing Logic ---

    function startDrawing(e) {
        drawing = true;
        [lastX, lastY] = [e.offsetX, e.offsetY];
    }

    function stopDrawing() {
        if (!drawing) return;
        drawing = false;
        ctx.beginPath();
    }

    function draw(e) {
        if (!drawing) return;
        
        const drawData = {
            x0: lastX,
            y0: lastY,
            x1: e.offsetX,
            y1: e.offsetY,
            color: colorPicker.value,
            size: brushSizeSlider.value,
            tool: currentTool
        };

        socket.emit('draw', drawData);
        renderDraw(drawData);

        [lastX, lastY] = [e.offsetX, e.offsetY];
    }

    function renderDraw({ x0, y0, x1, y1, color, size, tool }) {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = color;
        ctx.lineWidth = size;
        ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over'; // Reset
    }

    // --- Socket Listeners ---

    function setupSocketListeners() {
        socket.on('draw', (data) => {
            renderDraw(data);
        });

        socket.on('chatMessage', ({ nickname: senderNickname, message }) => {
            const messageEl = document.createElement('div');
            messageEl.classList.add('chat-message');
            if (senderNickname === nickname) { // Check against the user's own nickname
                messageEl.classList.add('own-message');
            }
            messageEl.innerHTML = `<strong>${sanitize(senderNickname)}:</strong> ${sanitize(message)}`;
            chatMessages.appendChild(messageEl);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });

        socket.on('updateUsers', (users) => {
            userCount.textContent = users.length;
            usersList.innerHTML = '';
            users.forEach(user => {
                const li = document.createElement('li');
                li.textContent = user;
                usersList.appendChild(li);
            });
        });

        socket.on('canvasHistory', (history) => {
            history.forEach(data => renderDraw(data));
        });

        socket.on('clearCanvas', () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        });
    }

    // --- Event Listeners ---
    
    window.addEventListener('resize', setupCanvas);
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);
    canvas.addEventListener('mousemove', (e) => {
        updateCursor(e);
        draw(e);
    });

    init();
});