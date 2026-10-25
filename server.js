const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MONGO_URI = "mongodb+srv://adminchat:MonPass1234@chat.5mznug4.mongodb.net/chat?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connecté à MongoDB Atlas !"))
  .catch(err => console.error("❌ Erreur MongoDB:", err));

// Fonction pour envoyer une notification push via ntfy.sh
function sendNtfyAlert(topic, title, message) {
  if (!topic) return;
  fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    body: message,
    headers: {
      'Title': title,
      'Priority': 'high',
      'Tags': 'speech_balloon'
    }
  }).catch(err => console.error("Erreur ntfy:", err));
}

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  ntfyTopic: { type: String, default: "" } // Canal ntfy personnel de l'utilisateur
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
  socket.on('register', async ({ username, passwordHash, ntfyTopic }, callback) => {
    try {
      const existing = await User.findOne({ username });
      if (existing) return callback({ success: false, message: "Ce pseudo existe déjà." });
      
      const newUser = new User({ username, passwordHash, ntfyTopic: ntfyTopic || "" });
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

  // Mise à jour du canal ntfy une fois connecté
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

  socket.on('send-message', async ({ recipient, text }, callback) => {
    try {
      const sender = socket.data.username || Object.keys(userSockets).find(user => userSockets[user] === socket.id);
      if (!sender) return callback({ success: false, message: "Non authentifié." });

      if (recipient === 'patchnote') {
        const allowedAdmins = ['Wifmat', 'Vortex'];
        if (!allowedAdmins.some(admin => admin.toLowerCase() === sender.toLowerCase())) {
          return callback({ success: false, message: "Seuls Wifmat et Vortex peuvent écrire dans les patchnotes." });
        }
      }

      const newMsg = new Message({ sender, recipient, text });
      await newMsg.save();

      if (recipient === 'patchnote') {
        io.emit('new-message', { sender, recipient: 'patchnote', text, timestamp: newMsg.timestamp });
        
        // Notifier tous les utilisateurs abonnés à ntfy
        const usersWithNtfy = await User.find({ ntfyTopic: { $ne: "" } });
        usersWithNtfy.forEach(u => {
          if (u.username !== sender) {
            sendNtfyAlert(u.ntfyTopic, "📢 Nouveau #patchnote", `${sender} a publié : ${text}`);
          }
        });
      } else {
        const recipientSocketId = userSockets[recipient];
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('new-message', { sender, recipient: sender, text, timestamp: newMsg.timestamp });
        } else {
          // Destinataire hors ligne -> Alerte ntfy
          const recipientUser = await User.findOne({ username: recipient });
          if (recipientUser && recipientUser.ntfyTopic) {
            sendNtfyAlert(recipientUser.ntfyTopic, `💬 Message de @${sender}`, `${sender} : "${text}"`);
          }
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
