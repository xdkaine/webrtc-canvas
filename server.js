const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Store connected users
const connectedUsers = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (userId) => {
        socket.userId = userId;
        connectedUsers.set(socket.id, {
            userId: userId,
            socketId: socket.id
        });

        console.log(`User ${userId} joined. Total users: ${connectedUsers.size}`);
        
        // Notify existing users about the new user
        socket.broadcast.emit('user-connected', userId);
        
        // Send current user count to all clients
        io.emit('user-count', connectedUsers.size);
        
        // Notify the new user about existing users
        connectedUsers.forEach((user, socketId) => {
            if (socketId !== socket.id) {
                socket.emit('user-connected', user.userId);
            }
        });
    });

    // Handle WebRTC signaling
    socket.on('webrtc-offer', (data) => {
        const targetSocket = findSocketByUserId(data.targetUserId);
        if (targetSocket) {
            targetSocket.emit('webrtc-offer', data);
        }
    });

    socket.on('webrtc-answer', (data) => {
        const targetSocket = findSocketByUserId(data.targetUserId);
        if (targetSocket) {
            targetSocket.emit('webrtc-answer', data);
        }
    });

    socket.on('webrtc-ice-candidate', (data) => {
        const targetSocket = findSocketByUserId(data.targetUserId);
        if (targetSocket) {
            targetSocket.emit('webrtc-ice-candidate', data);
        }
    });

    // Handle drawing data (fallback for users without WebRTC)
    socket.on('drawing-data', (data) => {
        // Broadcast to all other connected clients
        socket.broadcast.emit('drawing-data', data);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        const user = connectedUsers.get(socket.id);
        if (user) {
            // Notify other users about the disconnection
            socket.broadcast.emit('user-disconnected', user.userId);
            connectedUsers.delete(socket.id);
            
            // Send updated user count
            io.emit('user-count', connectedUsers.size);
            
            console.log(`User ${user.userId} left. Total users: ${connectedUsers.size}`);
        }
    });
});

// Helper function to find socket by user ID
function findSocketByUserId(userId) {
    for (const [socketId, user] of connectedUsers.entries()) {
        if (user.userId === userId) {
            return io.sockets.sockets.get(socketId);
        }
    }
    return null;
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        connectedUsers: connectedUsers.size
    });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🎨 WebRTC Canvas Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
    console.log(`📱 Open the same URL on multiple devices/tabs to test collaboration`);
});
