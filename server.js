const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const MONGO_URI = "mongodb+srv://adminchat:MonPass1234@chat.5mznug4.mongodb.net/chat?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connecté à MongoDB Atlas !"))
  .catch(err => console.error("❌ Erreur MongoDB:", err));

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true }
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}));

const userSockets = {};

app.get('/ping', (req, res) => res.send('pong'));

io.on('connection', (socket) => {
  socket.on('register', async ({ username, passwordHash }, callback) => {
    try {
      const existing = await User.findOne({ username });
      if (existing) return callback({ success: false, message: "Ce pseudo existe déjà." });
      
      const newUser = new User({ username, passwordHash });
      await newUser.save();
      
      socket.data.username = username;
      userSockets[username] = socket.id;
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

      // Récupérer l'historique personnel + les messages du canal patchnote (recipient: 'patchnote')
      const history = await Message.find({
        $or: [
          { sender: username },
          { recipient: username },
          { recipient: 'patchnote' }
        ]
      }).sort({ timestamp: 1 });

      callback({ success: true, history });
    } catch (err) {
      callback({ success: false, message: "Erreur lors de la connexion." });
    }
  });

  socket.on('send-message', async ({ recipient, text }, callback) => {
    try {
      const sender = socket.data.username || Object.keys(userSockets).find(user => userSockets[user] === socket.id);
      if (!sender) return callback({ success: false, message: "Non authentifié." });

      // Si c'est le canal patchnote, vérifier que l'expéditeur est Wifmat ou Vortex
      if (recipient === 'patchnote') {
        const allowedAdmins = ['Wifmat', 'Vortex'];
        // Vérification insensible à la casse pour plus de sécurité
        if (!allowedAdmins.some(admin => admin.toLowerCase() === sender.toLowerCase())) {
          return callback({ success: false, message: "Seuls Wifmat et Vortex peuvent écrire dans les patchnotes." });
        }
      }

      const newMsg = new Message({ sender, recipient, text });
      await newMsg.save();

      if (recipient === 'patchnote') {
        // Diffuser à tout le monde connecté
        io.emit('new-message', { sender, recipient: 'patchnote', text, timestamp: newMsg.timestamp });
      } else {
        const recipientSocketId = userSockets[recipient];
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('new-message', { sender, recipient: sender, text, timestamp: newMsg.timestamp });
        }
      }

      callback({ success: true });
    } catch (err) {
      callback({ success: false, message: "Erreur d'envoi." });
    }
  });

  socket.on('disconnect', () => {
    for (const [user, id] of Object.entries(userSockets)) {
      if (id === socket.id) {
        delete userSockets[user];
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));
