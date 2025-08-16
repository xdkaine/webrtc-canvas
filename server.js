const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3003;
const CANVAS_DATA_PATH = path.join(__dirname, 'canvas.json');

// In-memory state
let users = {};
let drawingHistory = [];

// Serve static files from the root directory
app.use(express.static(__dirname));

// Load canvas history from file
async function loadCanvas() {
    try {
        const data = await fs.readFile(CANVAS_DATA_PATH, 'utf8');
        drawingHistory = JSON.parse(data);
        console.log('Canvas history loaded.');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No canvas history found, starting fresh.');
            drawingHistory = [];
        } else {
            console.error('Error loading canvas:', error);
        }
    }
}

// Save canvas history to file
async function saveCanvas() {
    try {
        await fs.writeFile(CANVAS_DATA_PATH, JSON.stringify(drawingHistory));
    } catch (error) {
        console.error('Error saving canvas:', error);
    }
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send existing canvas history to the new user
    socket.emit('canvasHistory', drawingHistory);
    io.emit('updateUsers', Object.values(users).map(u => u.nickname));

    // Handle user joining
    socket.on('join', (nickname) => {
        users[socket.id] = { nickname, id: socket.id };
        io.emit('updateUsers', Object.values(users).map(u => u.nickname));
        console.log(`${nickname} joined.`);
    });

    // Handle drawing events
    socket.on('draw', (data) => {
        drawingHistory.push(data);
        socket.broadcast.emit('draw', data);
        saveCanvas();
    });
    
    // Handle canvas clear
    socket.on('clearCanvas', () => {
        drawingHistory = [];
        io.emit('clearCanvas');
        saveCanvas();
        console.log('Canvas cleared by a user.');
    });

    // Handle chat messages
    socket.on('chatMessage', (message) => {
        const user = users[socket.id];
        if (user) {
            io.emit('chatMessage', { message, nickname: user.nickname });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            console.log(`${user.nickname} disconnected.`);
            delete users[socket.id];
            io.emit('updateUsers', Object.values(users).map(u => u.nickname));
        } else {
            console.log('A user disconnected:', socket.id);
        }
    });
});

server.listen(PORT, async () => {
    await loadCanvas();
    console.log(`Server is running on http://localhost:${PORT}`);
});

module.exports = app;
