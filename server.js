const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// Augmentation de la limite de taille pour accepter l'envoi de photos et vocaux en base64 (~100 Mo)
const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8 
});

// Augmentation de la limite JSON d'Express également
app.use(express.json({ limit: '10mb' }));

const MONGO_URI = "mongodb+srv://adminchat:MonPass1234@chat.5mznug4.mongodb.net/chat?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connecté à MongoDB Atlas !"))
  .catch(err => console.error("❌ Erreur MongoDB:", err));

// Fonction pour envoyer une notification push via ntfy.sh (sans emojis dans les headers)
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
  ntfyTopic: { type: String, default: "" },
  lastSeen: { type: Date, default: Date.now }
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  text: { type: String, required: true },
  type: { type: String, default: 'text' },
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false }
}));

const userSockets = {};
const onlineUsers = new Set();

// Fonction corrigée : envoie la liste des pseudos en ligne + un dictionnaire des lastSeen de tout le monde
async function broadcastPresence() {
  const usersFromDb = await User.find({}, 'username lastSeen');
  const lastSeenMap = {};
  usersFromDb.forEach(u => {
    lastSeenMap[u.username] = u.lastSeen;
  });

  io.emit('presence-update', {
    onlineUsers: Array.from(onlineUsers),
    lastSeenMap: lastSeenMap
  });
}

app.get('/ping', (req, res) => res.send('pong'));

io.on('connection', (socket) => {
  socket.on('register', async ({ username, passwordHash, ntfyTopic }, callback) => {
    try {
      const existing = await User.findOne({ username });
      if (existing) return callback({ success: false, message: "Ce pseudo existe déjà." });
      
      const newUser = new User({ username, passwordHash, ntfyTopic: ntfyTopic || "", lastSeen: Date.now() });
      await newUser.save();
      
      socket.data.username = username;
      userSockets[username] = socket.id;
      onlineUsers.add(username);
      
      await User.updateOne({ username }, { lastSeen: Date.now() });
      broadcastPresence();

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

      user.lastSeen = Date.now();
      await user.save();
      broadcastPresence();

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

  socket.on('user-active', async () => {
    const username = socket.data.username;
    if (username) {
      userSockets[username] = socket.id;
      if (!onlineUsers.has(username)) {
        onlineUsers.add(username);
        await User.updateOne({ username }, { lastSeen: Date.now() });
        broadcastPresence();
      }
    }
  });

  socket.on('user-inactive', async () => {
    const username = socket.data.username;
    if (username && userSockets[username] === socket.id) {
      delete userSockets[username];
      onlineUsers.delete(username);
      const now = Date.now();
      await User.updateOne({ username }, { lastSeen: now });
      broadcastPresence();
    }
  });

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

  socket.on('mark-read', async ({ sender }) => {
    const username = socket.data.username;
    if (!username) return;
    try {
      await Message.updateMany(
        { sender: sender, recipient: username, read: false },
        { $set: { read: true } }
      );

      const senderSocketId = userSockets[sender];
      if (senderSocketId) {
        io.to(senderSocketId).emit('messages-read', { reader: username });
      }
    } catch (err) {
      console.error("Erreur mark-read:", err);
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

      const newMsg = new Message({ sender, recipient, text, type: msgType, read: false });
      await newMsg.save();

      const messagePayload = { 
        sender, 
        recipient: recipient === 'patchnote' ? 'patchnote' : sender, 
        text, 
        type: msgType, 
        timestamp: newMsg.timestamp,
        read: false 
      };

      callback({ success: true, timestamp: newMsg.timestamp });

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
    } catch (err) {
      callback({ success: false, message: "Erreur d'envoi." });
    }
  });

  socket.on('disconnect', async () => {
    const username = socket.data.username;
    if (username) {
      delete userSockets[username];
      onlineUsers.delete(username);
      const now = Date.now();
      await User.updateOne({ username }, { lastSeen: now });
      broadcastPresence();
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));
