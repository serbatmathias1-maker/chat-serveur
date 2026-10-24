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

// Modèle Utilisateur
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true }
}));

// Modèle Message Historique (Sauvegarde permanente chiffrée)
const Message = mongoose.model('Message', new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  encryptedPayload: { type: Object, required: true },
  timestamp: { type: Date, default: Date.now }
}));

const userSockets = {};

app.get('/ping', (req, res) => res.send('pong'));

io.on('connection', (socket) => {
  // Inscription
  socket.on('register', async ({ username, passwordHash }, callback) => {
    try {
      const existing = await User.findOne({ username });
      if (existing) return callback({ success: false, message: "Ce pseudo existe déjà." });
      
      const newUser = new User({ username, passwordHash });
      await newUser.save();
      
      userSockets[username] = socket.id;
      callback({ success: true });
    } catch (err) {
      callback({ success: false, message: "Erreur lors de l'inscription." });
    }
  });

  // Connexion + Récupération de tout l'historique
  socket.on('login', async ({ username, passwordHash }, callback) => {
    try {
      const user = await User.findOne({ username });
      if (!user || user.passwordHash !== passwordHash) {
        return callback({ success: false, message: "Identifiants incorrects." });
      }

      userSockets[username] = socket.id;

      // Récupérer TOUS les messages où l'utilisateur est soit l'expéditeur, soit le destinataire
      const history = await Message.find({
        $or: [{ sender: username }, { recipient: username }]
      }).sort({ timestamp: 1 });

      callback({ success: true, history });
    } catch (err) {
      callback({ success: false, message: "Erreur lors de la connexion." });
    }
  });

  // Envoi et sauvegarde automatique du message
  socket.on('send-message', async ({ recipient, messageData }, callback) => {
    try {
      // 1. Sauvegarde en BDD (Toujours chiffré)
      const newMsg = new Message({
        sender: messageData.sender,
        recipient,
        encryptedPayload: messageData.encryptedPayload
      });
      await newMsg.save();

      // 2. Transmettre au destinataire s'il est connecté
      const recipientSocketId = userSockets[recipient];
      if (recipientSocketId) {
        io.to(recipientSocketId).emit('new-message', messageData);
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
