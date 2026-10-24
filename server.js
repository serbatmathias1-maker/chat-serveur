const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MONGO_URI = "mongodb+srv://adminchat:MonPass1234@chat.5mznug4.mongodb.net/chat?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connecté à MongoDB Atlas !"))
  .catch(err => console.error("❌ Erreur MongoDB:", err));

// Configuration de l'expéditeur d'emails (Tu peux mettre tes identifiants Gmail/SMTP)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'ton.email@gmail.com',
    pass: process.env.EMAIL_PASS || 'votre_mot_de_passe_app'
  }
});

function sendEmailNotification(toEmail, subject, textContent) {
  if (!toEmail) return;
  const mailOptions = {
    from: '"Chat App" <noreply@chatapp.com>',
    to: toEmail,
    subject: subject,
    text: textContent
  };
  transporter.sendMail(mailOptions, (err, info) => {
    if (err) console.error("Erreur envoi email:", err);
    else console.log("Email envoyé à", toEmail);
  });
}

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  email: { type: String, default: "" } // Champ email optionnel
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
  socket.on('register', async ({ username, passwordHash, email }, callback) => {
    try {
      const existing = await User.findOne({ username });
      if (existing) return callback({ success: false, message: "Ce pseudo existe déjà." });
      
      const newUser = new User({ username, passwordHash, email: email || "" });
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

      callback({ success: true, history, email: user.email });
    } catch (err) {
      callback({ success: false, message: "Erreur lors de la connexion." });
    }
  });

  // Mise à jour de l'email une fois connecté
  socket.on('update-email', async ({ email }, callback) => {
    const username = socket.data.username;
    if (!username) return callback({ success: false, message: "Non authentifié" });
    try {
      await User.updateOne({ username }, { email });
      callback({ success: true });
    } catch (err) {
      callback({ success: false, message: "Erreur mise à jour email" });
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
        
        // Notifier tous les utilisateurs possédant un email
        const usersWithEmail = await User.find({ email: { $ne: "" } });
        usersWithEmail.forEach(u => {
          if (u.username !== sender) {
            sendEmailNotification(u.email, "📢 Nouveau #patchnote", `${sender} a publié : ${text}`);
          }
        });
      } else {
        const recipientSocketId = userSockets[recipient];
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('new-message', { sender, recipient: sender, text, timestamp: newMsg.timestamp });
        } else {
          // Destinataire hors ligne -> Envoi d'un mail si disponible
          const recipientUser = await User.findOne({ username: recipient });
          if (recipientUser && recipientUser.email) {
            sendEmailNotification(recipientUser.email, `💬 Nouveau message de @${sender}`, `${sender} vous a écrit : "${text}"`);
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
