const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get('/ping', (req, res) => res.status(200).send('OK'));

const users = {};
const messages = {};

io.on('connection', (socket) => {
  socket.on('register', ({ username, passwordHash }, callback) => {
    if (users[username]) return callback({ success: false, message: "Ce pseudo existe déjà." });
    users[username] = { passwordHash, socketId: socket.id };
    messages[username] = messages[username] || [];
    callback({ success: true });
  });

  socket.on('login', ({ username, passwordHash }, callback) => {
    const user = users[username];
    if (!user || user.passwordHash !== passwordHash) return callback({ success: false, message: "Identifiant ou mot de passe incorrect." });
    user.socketId = socket.id;
    callback({ success: true, messages: messages[username] || [] });
  });

  socket.on('send-message', ({ recipient, messageData }, callback) => {
    if (!messages[recipient]) messages[recipient] = [];
    messages[recipient].push(messageData);
    const recipientUser = users[recipient];
    if (recipientUser && recipientUser.socketId) {
      io.to(recipientUser.socketId).emit('new-message', messageData);
    }
    callback({ success: true });
  });

  socket.on('disconnect', () => {
    for (let u in users) { if (users[u].socketId === socket.id) users[u].socketId = null; }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));