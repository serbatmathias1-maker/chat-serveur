const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Pour supporter les images/vocaux en base64

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Connexion MongoDB Atlas (remplace par ton URI si besoin)
const MONGO_URI = process.env.MONGO_URI || "TON_URI_MONGODB_ICI";

mongoose.connect(MONGO_URI)
  .then(() => console.log("Connecté à MongoDB Atlas"))
  .catch(err => console.error("Erreur de connexion MongoDB :", err));

// --- SCHÉMAS DE LA BASE DE DONNÉES ---
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  ntfyTopic: { type: String, default: "" },
  lastSeen: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  text: { type: String, required: true },
  type: { type: String, default: 'text' }, // 'text', 'image', 'audio'
  timestamp: { type: Number, default: Date.now },
  read: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Stockage en mémoire des utilisateurs connectés (username -> socketId)
const onlineUsers = new Map();

// Fonction utilitaire pour diffuser la liste des utilisateurs en ligne avec leur lastSeen
async function broadcastOnlineUsers() {
  const usersFromDb = await User.find({}, 'username lastSeen');
  const usersData = usersFromDb.map(u => ({
    username: u.username,
    isOnline: onlineUsers.has(u.username),
    lastSeen: u.lastSeen
  }));
  io.emit('presence-update', usersData);
}

io.on('connection', (socket) => {
  console.log(`Nouvelle connexion socket : ${socket.id}`);

  // --- INSCRIPTION ---
  socket.on('register', async ({ username, passwordHash, ntfyTopic }, callback) => {
    try {
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return callback({ success: false, message: "Ce pseudo est déjà pris." });
      }

      const newUser = new User({ username, passwordHash, ntfyTopic, lastSeen: Date.now() });
      await newUser.save();
      callback({ success: true });
    } catch (err) {
      callback({ success: false, message: "Erreur serveur lors de l'inscription." });
    }
  });

  // --- CONNEXION ---
  socket.on('login', async ({ username, passwordHash }, callback) => {
    try {
      const user = await User.findOne({ username });
      if (!user || user.passwordHash !== passwordHash) {
        return callback({ success: false, message: "Pseudo ou mot de passe incorrect." });
      }

      socket.username = username;
      onlineUsers.set(username, socket.id);

      // Met à jour le lastSeen à l'instant présent en BDD
      user.lastSeen = Date.now();
      await user.save();

      // Récupération de l'historique des messages de l'utilisateur
      const history = await Message.find({
        $or: [
          { sender: username },
          { recipient: username },
          { recipient: 'patchnote' }
        ]
      }).sort({ timestamp: 1 });

      callback({
        success: true,
        ntfyTopic: user.ntfyTopic,
        history: history
      });

      broadcastOnlineUsers();
    } catch (err) {
      callback({ success: false, message: "Erreur serveur lors de la connexion." });
    }
  });

  // --- MISE À JOUR DU CANAL NTFY ---
  socket.on('update-ntfy', async ({ ntfyTopic }) => {
    if (!socket.username) return;
    try {
      await User.updateOne({ username: socket.username }, { $set: { ntfyTopic } });
      socket.emit('update-ntfy-response', { success: true });
    } catch (err) {
      socket.emit('update-ntfy-response', { success: false });
    }
  });

  // --- ENVOI D'UN MESSAGE ---
  socket.on('send-message', async ({ recipient, text, type }, callback) => {
    if (!socket.username) return;

    const sender = socket.username;
    const timestamp = Date.now();
    // Si le destinataire est déjà connecté et lit la conv, on peut l'initialiser à lu ou non
    const isRecipientActive = onlineUsers.has(recipient);
    
    try {
      const newMessage = new Message({
        sender,
        recipient,
        text,
        type: type || 'text',
        timestamp,
        read: false
      });
      await newMessage.save();

      // Renvoie le succès avec le timestamp au client expéditeur
      callback({ success: true, timestamp });

      // Transmet le message au destinataire s'il est en ligne
      if (recipient === 'patchnote') {
        io.emit('new-message', { sender, recipient, text, type, timestamp, read: false });
      } else if (onlineUsers.has(recipient)) {
        io.to(onlineUsers.get(recipient)).emit('new-message', {
          sender,
          recipient,
          text,
          type,
          timestamp,
          read: false
        });
      } else {
        // Le destinataire est hors-ligne -> Envoi de la notification push Ntfy si configuré
        const recipientUser = await User.findOne({ username: recipient });
        if (recipientUser && recipientUser.ntfyTopic) {
          const fetch = (await import('node-fetch')).default;
          let previewText = text;
          if (type === 'image') previewText = "a envoyé une photo 📷";
          else if (type === 'audio') previewText = "a envoyé un message vocal 🎤";

          await fetch(`https://ntfy.sh/${recipientUser.ntfyTopic}`, {
            method: 'POST',
            body: `${sender}: ${previewText}`,
            headers: {
              'Title': 'Nouveau message privé',
              'Priority': 'default'
            }
          }).catch(err => console.error("Erreur d'envoi Ntfy :", err));
        }
      }
    } catch (err) {
      callback({ success: false, message: "Erreur lors de l'enregistrement du message." });
    }
  });

  // --- MARQUER LES MESSAGES COMME LUS (ACCUSÉ DE LECTURE "VU") ---
  socket.on('mark-read', async ({ sender }) => {
    if (!socket.username) return;
    try {
      // Met à jour les messages non lus envoyés par 'sender' à l'utilisateur actuel
      await Message.updateMany(
        { sender: sender, recipient: socket.username, read: false },
        { $set: { read: true } }
      );

      // Si l'expéditeur est en ligne, on l'informe en direct que ses messages ont été lus
      if (onlineUsers.has(sender)) {
        io.to(onlineUsers.get(sender)).emit('messages-read', { reader: socket.username });
      }
    } catch (err) {
      console.error("Erreur lors de la mise à jour des messages lus :", err);
    }
  });

  // --- GESTION DE LA PRÉSENCE (Actif / Inactif) ---
  socket.on('user-active', async () => {
    if (socket.username) {
      onlineUsers.set(socket.username, socket.id);
      await User.updateOne({ username: socket.username }, { $set: { lastSeen: Date.now() } });
      broadcastOnlineUsers();
    }
  });

  socket.on('user-inactive', async () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      const now = Date.now();
      await User.updateOne({ username: socket.username }, { $set: { lastSeen: now } });
      broadcastOnlineUsers();
    }
  });

  // --- INDICATEUR DE SAISIE ---
  socket.on('typing', ({ recipient }) => {
    if (socket.username && onlineUsers.has(recipient)) {
      io.to(onlineUsers.get(recipient)).emit('user-typing', { sender: socket.username });
    }
  });

  socket.on('stop-typing', ({ recipient }) => {
    if (socket.username && onlineUsers.has(recipient)) {
      io.to(onlineUsers.get(recipient)).emit('user-stop-typing', { sender: socket.username });
    }
  });

  // --- DÉCONNEXION ---
  socket.on('disconnect', async () => {
    console.log(`Socket déconnecté : ${socket.id}`);
    if (socket.username) {
      onlineUsers.delete(socket.username);
      const now = Date.now();
      await User.updateOne({ username: socket.username }, { $set: { lastSeen: now } });
      broadcastOnlineUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
