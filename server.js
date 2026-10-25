const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Augmentation de la limite de taille pour accepter l'envoi de photos/vocaux en base64
app.use(express.json({ limit: '10mb' }));

const MONGO_URI = "mongodb+srv://adminchat:MonPass1234@chat.5mznug4.mongodb.net/chat?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connecté à MongoDB Atlas !"))
  .catch(err => console.error("❌ Erreur MongoDB:", err));

function sendNtfyAlert(topic, title, message) {
  if (!topic) return;
  fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    body: message,
    headers: {
      'Title': title,
      'Priority': 'high',
      'Click': 'https://serbatmathias1-maker.github.io/chat-serveur/'
    }
  }).catch(err => console.error("Erreur ntfy:", err));
}

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  ntfyTopic: { type: String, default: "" }
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  text: { type: String, required: true }, // Contient le texte, ou l'URL/Base64 de l'image/vocal
  type: { type: String, default: 'text' }, // 'text', 'image', ou 'audio'
  timestamp: { type: Date, default: Date.now }
}));

const userSockets = {};
const onlineUsers = new Set();

app.get('/ping', (req, res) => res.send('pong'));

io.on('connection', (socket) => {
  socket.on('register', async ({ username, passwordHash, ntfyTopic }, callback) => {
    try {
      const existing = await User.findOne({ username });
      if (existing) return callback({ success: false, message: "Ce pseudo existe déjà." });
      
      const newUser = new User({ username, passwordHash, ntfyTopic: ntfyTopic || "" });
      await newUser.save();
      
      socket.data.username = username;
      userSockets[username] = socket.id;
      onlineUsers.add(username);
      io.emit('presence-update', Array.from(onlineUsers));

      callback({ success: true });
    } catch (err) {
      callback({ success: false, message: "Erreur lors de l'inscription." });
    }
  });

  socket.on('login', async ({ username, passwordHash }, callback) => {
    try {
      const user = await User.findOne({ username });
      if (!user || user.passwordHash !== passwordHash) {
        return callback({ success: false, message: "Identifiants incorrects." });
      }

      socket.data.username = username;
      userSockets[username] = socket.id;
      onlineUsers.add(username);
      io.emit('presence-update', Array.from(onlineUsers));

      const history = await Message.find({
        $or: [
          { sender: username },
          { recipient: username },
          { recipient: 'patchnote' }
        ]
      }).sort({ timestamp: 1 });

      callback({ success: true, history, ntfyTopic: user.ntfyTopic });
    } catch (err) {
      callback({ success: false, message: "Erreur lors de la connexion." });
    }
  });

  // Gestion de l'inactivité (5 secondes)
  socket.on('user-active', () => {
    const username = socket.data.username;
    if (username) {
      userSockets[username] = socket.id;
      if (!onlineUsers.has(username)) {
        onlineUsers.add(username);
        io.emit('presence-update', Array.from(onlineUsers));
      }
    }
  });

  socket.on('user-inactive', () => {
    const username = socket.data.username;
    if (username && userSockets[username] === socket.id) {
      delete userSockets[username];
      onlineUsers.delete(username);
      io.emit('presence-update', Array.from(onlineUsers));
    }
  });

  // Indicateur de saisie ("En train d'écrire...")
  socket.on('typing', ({ recipient }) => {
    const sender = socket.data.username;
    const recipientSocketId = userSockets[recipient];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('user-typing', { sender });
    }
  });

  socket.on('stop-typing', ({ recipient }) => {
    const sender = socket.data.username;
    const recipientSocketId = userSockets[recipient];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('user-stop-typing', { sender });
    }
  });

  socket.on('update-ntfy', async ({ ntfyTopic }, callback) => {
    const username = socket.data.username;
    if (!username) return callback({ success: false, message: "Non authentifié" });
    try {
      await User.updateOne({ username }, { ntfyTopic });
      callback({ success: true });
    } catch (err) {
      callback({ success: false, message: "Erreur mise à jour ntfy" });
    }
  });

  socket.on('send-message', async ({ recipient, text, type }, callback) => {
    try {
      const sender = socket.data.username || Object.keys(userSockets).find(user => userSockets[user] === socket.id);
      if (!sender) return callback({ success: false, message: "Non authentifié." });

      const msgType = type || 'text';

      if (recipient === 'patchnote') {
        const allowedAdmins = ['Wifmat', 'Vortex'];
        if (!allowedAdmins.some(admin => admin.toLowerCase() === sender.toLowerCase())) {
          return callback({ success: false, message: "Seuls Wifmat et Vortex peuvent écrire dans les patchnotes." });
        }
      }

      const newMsg = new Message({ sender, recipient, text, type: msgType });
      await newMsg.save();

      const messagePayload = { 
        sender, 
        recipient: recipient === 'patchnote' ? 'patchnote' : sender, 
        text, 
        type: msgType, 
        timestamp: newMsg.timestamp 
      };

      if (recipient === 'patchnote') {
        io.emit('new-message', { ...messagePayload, recipient: 'patchnote' });
        
        const usersWithNtfy = await User.find({ ntfyTopic: { $ne: "" } });
        usersWithNtfy.forEach(u => {
          if (u.username !== sender) {
            sendNtfyAlert(u.ntfyTopic, "Nouveau patchnote", `${sender} a publié un patchnote.`);
          }
        });
      } else {
        const recipientSocketId = userSockets[recipient];
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('new-message', messagePayload);
        } else {
          const recipientUser = await User.findOne({ username: recipient });
          if (recipientUser && recipientUser.ntfyTopic) {
            let previewText = msgType === 'image' ? '[Photo]' : (msgType === 'audio' ? '[Message vocal]' : text);
            sendNtfyAlert(recipientUser.ntfyTopic, `Message de @${sender}`, `${sender} : "${previewText}"`);
          }
        }
      }

      callback({ success: true });
    } catch (err) {
      callback({ success: false, message: "Erreur d'envoi." });
    }
  });

  socket.on('disconnect', () => {
    const username = socket.data.username;
    if (username) {
      delete userSockets[username];
      onlineUsers.delete(username);
      io.emit('presence-update', Array.from(onlineUsers));
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));
