const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Connexion MongoDB Atlas avec ton nouveau mot de passe
const MONGO_URI = "mongodb+srv://serbatmathias1_db_user:motdepasse1709@chat.5mznug4.mongodb.net/chat?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connecté à MongoDB Atlas !"))
  .catch(err => console.error("❌ Erreur MongoDB:", err));

// Modèles MongoDB pour la persistance
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true }
}));

const PendingMessage = mongoose.model('PendingMessage', new mongoose.Schema({
  recipient: String,
  sender: String,
  encryptedPayload: Object,
  timestamp: { type: Date, default: Date.now }
}));

const userSockets = {};

app.get('/ping', (req, res) => res.send('pong'));

io.on('connection', (socket) => {
  console.log(`🔌 Nouvelle connexion Socket: ${socket.id}`);

  // Inscription
  socket.on('register', async ({ username, passwordHash }, callback) => {
    try {
      const existing = await User.findOne({ username });
      if (existing) {
        return callback({ success: false, message: "Ce pseudo existe déjà." });
      }
      const newUser = new User({ username, passwordHash });
      await newUser.save();
      
      userSockets[username] = socket.id;
      console.log(`👤 Compte créé et enregistré en BDD : ${username}`);
      callback({ success: true });
    } catch (err) {
      console.error(err);
      callback({ success: false, message: "Erreur serveur lors de l'inscription." });
    }
  });

  // Connexion
  socket.on('login', async ({ username, passwordHash }, callback) => {
    try {
      const user = await User.findOne({ username });
      if (!user) {
        return callback({ success: false, message: "Utilisateur inconnu." });
      }
      if (user.passwordHash !== passwordHash) {
        return callback({ success: false, message: "Mot de passe incorrect." });
      }

      userSockets[username] = socket.id;
      console.log(`🔑 Connexion réussie : ${username}`);

      // Récupérer et livrer les messages en attente (hors-ligne)
      const pending = await PendingMessage.find({ recipient: username });
      if (pending.length > 0) {
        await PendingMessage.deleteMany({ recipient: username });
        console.log(`📦 ${pending.length} message(s) en attente livré(s) à ${username}`);
      }

      callback({ success: true, messages: pending });
    } catch (err) {
      console.error(err);
      callback({ success: false, message: "Erreur serveur lors de la connexion." });
    }
  });

  // Envoi de message
  socket.on('send-message', async ({ recipient, messageData }, callback) => {
    const recipientSocketId = userSockets[recipient];

    if (recipientSocketId) {
      io.to(recipientSocketId).emit('new-message', messageData);
      console.log(`💬 Message direct de [${messageData.sender}] vers [${recipient}]`);
    } else {
      // Destinataire hors-ligne : sauvegarde permanente en BDD
      const pending = new PendingMessage({
        recipient,
        sender: messageData.sender,
        encryptedPayload: messageData.encryptedPayload
      });
      await pending.save();
      console.log(`💾 Message sauvegardé en BDD pour [${recipient}] (hors-ligne)`);
    }
    callback({ success: true });
  });

  socket.on('disconnect', () => {
    for (const [user, id] of Object.entries(userSockets)) {
      if (id === socket.id) {
        delete userSockets[user];
        console.log(`❌ Déconnexion Socket : ${user}`);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));
