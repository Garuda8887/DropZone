const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Handle joining a room
    let joinAttempts = 0;
    socket.on('join-room', (roomId) => {
        // ponytail: per-socket cap, not per-IP; good enough to kill single-connection brute force
        joinAttempts++;
        if (joinAttempts > 20) {
            socket.disconnect(true);
            return;
        }

        if (typeof roomId !== 'string' || !/^\d{4}$/.test(roomId)) {
            socket.emit('room-full', roomId);
            return;
        }

        // Find if room exists and get number of clients
        const clients = io.sockets.adapter.rooms.get(roomId);
        const numClients = clients ? clients.size : 0;

        if (numClients === 0) {
            socket.join(roomId);
            socket.emit('room-created', roomId);
            console.log(`User ${socket.id} created room ${roomId}`);
        } else if (numClients === 1) {
            socket.join(roomId);
            socket.emit('room-joined', roomId);
            console.log(`User ${socket.id} joined room ${roomId}`);
            // Let the creator know someone joined
            socket.to(roomId).emit('peer-joined', socket.id);
        } else {
            // Room is full (max 2 peers for this simple app)
            socket.emit('room-full', roomId);
        }
    });

    // Handle WebRTC signaling
    socket.on('signal', (data) => {
        // Forward signal to the other peer in the room
        socket.to(data.room).emit('signal', {
            signal: data.signal,
            sender: socket.id
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Signaling server running on http://localhost:${PORT}`);
});
