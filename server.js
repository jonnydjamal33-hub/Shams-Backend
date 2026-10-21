require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const { createServer } = require('node:http');
const { Server: SocketServer } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, { cors: { origin: process.env.CORS_ORIGINS || '*' } });
const port = Number(process.env.PORT || 5000);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET doit contenir au moins 32 caractères.');
}

fs.mkdirSync(uploadDir, { recursive: true });

const userSchema = new mongoose.Schema({
  nom: { type: String, required: true, trim: true, maxlength: 100 },
  prenom: { type: String, trim: true, maxlength: 100, default: '' },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  motDePasse: { type: String, select: false },
  telephone: { type: String, trim: true, default: '' },
  photo: { type: String, default: '' },
  role: { type: String, enum: ['CLIENT', 'ADMIN'], default: 'CLIENT' },
  fournisseur: { type: String, default: 'local' },
  fournisseurId: { type: String },
}, { timestamps: true });

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  titre: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, default: 'INFO' },
  lue: { type: Boolean, default: false },
  lien: String,
}, { timestamps: true });

const consultationSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  statut: { type: String, enum: ['OUVERTE', 'EN_COURS', 'FERMEE'], default: 'OUVERTE' },
  dernierMessage: { type: Date, default: Date.now },
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  consultation: { type: mongoose.Schema.Types.ObjectId, ref: 'Consultation', required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contenu: { type: String, required: true, trim: true, maxlength: 2000 },
  lu: { type: Boolean, default: false },
}, { timestamps: true });

const ritualSchema = new mongoose.Schema({
  titre: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  duree: { type: String, required: true, trim: true, maxlength: 40 },
  prix: { type: Number, required: true, min: 0 },
  devise: { type: String, default: 'MGA' },
  actif: { type: Boolean, default: true },
  ordre: { type: Number, default: 0 },
}, { timestamps: true });

const ritualOrderSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  rituel: { type: mongoose.Schema.Types.ObjectId, ref: 'Ritual', required: true },
  statut: { type: String, enum: ['EN_ATTENTE', 'EN_COURS', 'TERMINE', 'ANNULE'], default: 'EN_ATTENTE' },
  noteClient: { type: String, trim: true, maxlength: 1000, default: '' },
  compteRendu: { type: String, trim: true, maxlength: 5000, default: '' },
}, { timestamps: true });

const geomancyReadingSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  question: { type: String, required: true, trim: true, maxlength: 240 },
  figures: { type: [mongoose.Schema.Types.Mixed], required: true },
  reponse: { type: String, enum: ['OUI', 'NON'], required: true },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const Consultation = mongoose.model('Consultation', consultationSchema);
const Message = mongoose.model('Message', messageSchema);
const Ritual = mongoose.model('Ritual', ritualSchema);
const RitualOrder = mongoose.model('RitualOrder', ritualOrderSchema);
const GeomancyReading = mongoose.model('GeomancyReading', geomancyReadingSchema);

let onlineAdminCount = 0;

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const allowedOrigins = (process.env.CORS_ORIGINS || '*').split(',').map((item) => item.trim());
app.use(cors({ origin: allowedOrigins.includes('*') ? '*' : allowedOrigins }));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir, { dotfiles: 'deny', index: false }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDir),
    filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    callback(allowed.has(file.mimetype) ? null : new Error('Format de fichier non autorisé.'), allowed.has(file.mimetype));
  },
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const respondError = (res, status, message) => res.status(status).json({ message });

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

function publicUser(user) {
  return { _id: user.id, nom: user.nom, prenom: user.prenom, email: user.email, role: user.role, telephone: user.telephone, photo: user.photo };
}

const requireAuth = asyncRoute(async (req, res, next) => {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return respondError(res, 401, 'Authentification requise.');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(payload.sub);
    if (!req.user) return respondError(res, 401, 'Session invalide.');
    next();
  } catch (_error) {
    return respondError(res, 401, 'Session invalide ou expirée.');
  }
});

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'ADMIN') return respondError(res, 403, 'Accès réservé à l’administration.');
  next();
};

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'shams-mobile-api' }));

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const { nom, prenom = '', email, motDePasse, telephone = '' } = req.body;
  if (!nom || !email || !motDePasse) return respondError(res, 400, 'Nom, e-mail et mot de passe sont obligatoires.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respondError(res, 400, 'Adresse e-mail invalide.');
  if (String(motDePasse).length < 8) return respondError(res, 400, 'Le mot de passe doit contenir au moins 8 caractères.');
  if (await User.exists({ email: String(email).toLowerCase().trim() })) return respondError(res, 409, 'Cette adresse e-mail est déjà utilisée.');
  const normalizedEmail = String(email).toLowerCase().trim();
  const user = await User.create({ nom, prenom, email: normalizedEmail, telephone, role: adminEmails.has(normalizedEmail) ? 'ADMIN' : 'CLIENT', motDePasse: await bcrypt.hash(motDePasse, 12) });
  const token = signToken(user);
  res.status(201).json({ data: { token, user: publicUser(user) } });
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const user = await User.findOne({ email }).select('+motDePasse');
  if (!user || !user.motDePasse || !(await bcrypt.compare(String(req.body.motDePasse || ''), user.motDePasse))) {
    return respondError(res, 401, 'E-mail ou mot de passe incorrect.');
  }
  if (adminEmails.has(email) && user.role !== 'ADMIN') {
    user.role = 'ADMIN';
    await user.save();
  }
  res.json({ ...publicUser(user), token: signToken(user) });
}));

app.post('/api/auth/login/2fa', authLimiter, (_req, res) => respondError(res, 503, 'La validation SMS à deux facteurs nécessite un fournisseur SMS configuré.'));
app.post('/api/auth/sms/login/send', authLimiter, (_req, res) => respondError(res, 503, 'La connexion par SMS nécessite un fournisseur SMS configuré.'));
app.post('/api/auth/sms/login/verify', authLimiter, (_req, res) => respondError(res, 503, 'La connexion par SMS nécessite un fournisseur SMS configuré.'));
app.post('/api/auth/forgot-password', authLimiter, (_req, res) => respondError(res, 503, 'La récupération du mot de passe nécessite un fournisseur e-mail configuré.'));
app.post('/api/auth/reset-password', authLimiter, (_req, res) => respondError(res, 503, 'La récupération du mot de passe nécessite un fournisseur e-mail configuré.'));

app.post('/api/auth/google', authLimiter, asyncRoute(async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return respondError(res, 503, 'GOOGLE_CLIENT_ID n’est pas configuré.');
  const credential = req.body.idToken || req.body.token;
  if (!credential) return respondError(res, 400, 'token est obligatoire.');
  let profile;
  if (req.body.idToken) {
    const ticket = await new OAuth2Client(process.env.GOOGLE_CLIENT_ID).verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    profile = ticket.getPayload();
  } else {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${credential}` } });
    profile = await response.json();
    if (!response.ok) return respondError(res, 401, 'Jeton Google invalide.');
  }
  if (!profile?.email || profile.email_verified === false) return respondError(res, 401, 'Compte Google non vérifié.');
  const user = await findOrCreateSocialUser({ email: profile.email, nom: profile.family_name || profile.name || 'Utilisateur', prenom: profile.given_name || '', photo: profile.picture || '', fournisseur: 'google', fournisseurId: profile.sub });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.post('/api/auth/facebook', authLimiter, asyncRoute(async (req, res) => {
  if (!process.env.FACEBOOK_APP_ID) return respondError(res, 503, 'FACEBOOK_APP_ID n’est pas configuré.');
  const accessToken = req.body.accessToken || req.body.token;
  if (!accessToken) return respondError(res, 400, 'token est obligatoire.');
  const url = new URL('https://graph.facebook.com/me');
  url.searchParams.set('fields', 'id,name,first_name,last_name,email,picture');
  url.searchParams.set('access_token', accessToken);
  const response = await fetch(url);
  const profile = await response.json();
  if (!response.ok || !profile.email) return respondError(res, 401, 'Jeton Facebook invalide ou adresse e-mail indisponible.');
  const user = await findOrCreateSocialUser({ email: profile.email, nom: profile.last_name || profile.name, prenom: profile.first_name || '', photo: profile.picture?.data?.url || '', fournisseur: 'facebook', fournisseurId: profile.id });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

async function findOrCreateSocialUser(profile) {
  let user = await User.findOne({ $or: [{ email: profile.email.toLowerCase() }, { fournisseur: profile.fournisseur, fournisseurId: profile.fournisseurId }] });
  if (!user) user = await User.create({ ...profile, role: adminEmails.has(profile.email.toLowerCase()) ? 'ADMIN' : 'CLIENT' });
  else {
    let changed = false;
    if (!user.fournisseurId) {
      user.fournisseur = profile.fournisseur;
      user.fournisseurId = profile.fournisseurId;
      changed = true;
    }
    if (adminEmails.has(profile.email.toLowerCase()) && user.role !== 'ADMIN') {
      user.role = 'ADMIN';
      changed = true;
    }
    if (changed) await user.save();
  }
  return user;
}

app.post('/api/auth/me/photo', requireAuth, upload.single('photo'), asyncRoute(async (req, res) => {
  if (!req.file) return respondError(res, 400, 'La photo est obligatoire.');
  req.user.photo = `/uploads/${req.file.filename}`;
  await req.user.save();
  res.json({ user: publicUser(req.user) });
}));

app.get('/api/notifications', requireAuth, asyncRoute(async (req, res) => res.json(await Notification.find({ user: req.user.id }).sort({ createdAt: -1 }))));
app.put('/api/notifications/:id/read', requireAuth, asyncRoute(async (req, res) => {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user.id }, { lue: true }, { new: true });
  if (!notification) return respondError(res, 404, 'Notification introuvable.');
  res.json(notification);
}));

async function findAccessibleConsultation(consultationId, user) {
  const consultation = await Consultation.findById(consultationId);
  if (!consultation) return null;
  if (user.role !== 'ADMIN' && String(consultation.client) !== user.id) return null;
  return consultation;
}

app.get('/api/consultations', requireAuth, asyncRoute(async (req, res) => {
  if (req.user.role === 'ADMIN') {
    return res.json(await Consultation.find().populate('client', 'nom prenom email photo').sort({ dernierMessage: -1 }));
  }
  let consultation = await Consultation.findOne({ client: req.user.id, statut: { $ne: 'FERMEE' } }).sort({ updatedAt: -1 });
  if (!consultation) {
    consultation = await Consultation.create({ client: req.user.id });
    io.to('admins').emit('consultation:new', await consultation.populate('client', 'nom prenom email photo'));
  }
  const messages = await Message.find({ consultation: consultation.id }).populate('sender', 'nom prenom role').sort({ createdAt: 1 }).limit(200);
  return res.json({ ...consultation.toObject(), messages });
}));

app.post('/api/consultations', requireAuth, asyncRoute(async (req, res) => {
  const consultation = await Consultation.create({ client: req.user.id });
  io.to('admins').emit('consultation:new', consultation);
  res.status(201).json(consultation);
}));

app.get('/api/consultations/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  const consultation = await findAccessibleConsultation(req.params.id, req.user);
  if (!consultation) return respondError(res, 404, 'Consultation introuvable.');
  const messages = await Message.find({ consultation: consultation.id }).populate('sender', 'nom prenom role').sort({ createdAt: 1 }).limit(200);
  res.json(messages);
}));

app.post('/api/consultations/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  const consultation = await findAccessibleConsultation(req.params.id, req.user);
  const contenu = String(req.body.contenu || '').trim();
  if (!consultation) return respondError(res, 404, 'Consultation introuvable.');
  if (consultation.statut === 'FERMEE') return respondError(res, 409, 'Cette consultation est fermée.');
  if (!contenu || contenu.length > 2000) return respondError(res, 400, 'Le message doit contenir entre 1 et 2000 caractères.');
  const message = await Message.create({ consultation: consultation.id, sender: req.user.id, contenu });
  consultation.dernierMessage = new Date();
  if (req.user.role === 'ADMIN' && consultation.statut === 'OUVERTE') {
    consultation.statut = 'EN_COURS';
    consultation.admin = req.user.id;
  }
  await consultation.save();
  const populatedMessage = await message.populate('sender', 'nom prenom role');
  io.to(`consultation:${consultation.id}`).emit('message:new', populatedMessage);
  if (req.user.role !== 'ADMIN') io.to('admins').emit('consultation:message', { consultationId: consultation.id, message: populatedMessage });
  res.status(201).json(populatedMessage);
}));

app.patch('/api/consultations/:id/status', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const validStatuses = ['OUVERTE', 'EN_COURS', 'FERMEE'];
  if (!validStatuses.includes(req.body.statut)) return respondError(res, 400, 'Statut de consultation invalide.');
  const consultation = await Consultation.findByIdAndUpdate(req.params.id, { statut: req.body.statut, admin: req.user.id }, { new: true });
  if (!consultation) return respondError(res, 404, 'Consultation introuvable.');
  io.to(`consultation:${consultation.id}`).emit('consultation:updated', consultation);
  res.json(consultation);
}));

app.get('/api/rituals', asyncRoute(async (_req, res) => res.json(await Ritual.find({ actif: true }).sort({ ordre: 1, createdAt: 1 }))));
app.post('/api/rituals', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const ritual = await Ritual.create(req.body);
  res.status(201).json(ritual);
}));
app.put('/api/rituals/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const allowed = ['titre', 'description', 'duree', 'prix', 'devise', 'actif', 'ordre'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)));
  const ritual = await Ritual.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
  if (!ritual) return respondError(res, 404, 'Rituel introuvable.');
  res.json(ritual);
}));
app.delete('/api/rituals/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const ritual = await Ritual.findByIdAndUpdate(req.params.id, { actif: false }, { new: true });
  if (!ritual) return respondError(res, 404, 'Rituel introuvable.');
  res.json({ message: 'Rituel désactivé.', data: ritual });
}));
app.post('/api/rituals/:id/orders', requireAuth, asyncRoute(async (req, res) => {
  const ritual = await Ritual.findOne({ _id: req.params.id, actif: true });
  if (!ritual) return respondError(res, 404, 'Rituel indisponible.');
  const order = await RitualOrder.create({ client: req.user.id, rituel: ritual.id, noteClient: String(req.body.noteClient || '').slice(0, 1000) });
  res.status(201).json(await order.populate('rituel'));
}));
app.get('/api/rituals/orders/mine', requireAuth, asyncRoute(async (req, res) => res.json(await RitualOrder.find({ client: req.user.id }).populate('rituel').sort({ createdAt: -1 }))));
app.get('/api/rituals/orders', requireAuth, requireAdmin, asyncRoute(async (_req, res) => res.json(await RitualOrder.find().populate('client', 'nom prenom email').populate('rituel').sort({ createdAt: -1 }))));
app.put('/api/rituals/orders/:id/status', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const statuses = ['EN_ATTENTE', 'EN_COURS', 'TERMINE', 'ANNULE'];
  if (!statuses.includes(req.body.statut)) return respondError(res, 400, 'Statut de commande invalide.');
  const compteRendu = String(req.body.compteRendu || '').trim();
  if (req.body.statut === 'TERMINE' && !compteRendu) return respondError(res, 400, 'Un compte-rendu est obligatoire pour terminer un rituel.');
  const order = await RitualOrder.findByIdAndUpdate(
    req.params.id,
    { statut: req.body.statut, ...(compteRendu ? { compteRendu } : {}) },
    { new: true, runValidators: true },
  ).populate('rituel');
  if (!order) return respondError(res, 404, 'Commande introuvable.');
  res.json(order);
}));

function xorFigure(left, right) {
  return left.map((line, index) => line === right[index] ? 2 : 1);
}

app.post('/api/geomancy/readings', requireAuth, asyncRoute(async (req, res) => {
  const question = String(req.body.question || '').trim();
  if (!question || question.length > 240) return respondError(res, 400, 'La question doit contenir entre 1 et 240 caractères.');
  const mothers = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => crypto.randomInt(0, 2) ? 1 : 2));
  const daughters = Array.from({ length: 4 }, (_, column) => mothers.map((mother) => mother[column]));
  const figures = [
    ...mothers.map((lines, index) => ({ nom: `Mère ${index + 1}`, lignes: lines })),
    ...daughters.map((lines, index) => ({ nom: `Fille ${index + 1}`, lignes: lines })),
  ];
  const nieces = [xorFigure(figures[0].lignes, figures[1].lignes), xorFigure(figures[2].lignes, figures[3].lignes), xorFigure(figures[4].lignes, figures[5].lignes), xorFigure(figures[6].lignes, figures[7].lignes)];
  figures.push(...nieces.map((lines, index) => ({ nom: `Nièce ${index + 1}`, lignes: lines })));
  const witnesses = [xorFigure(nieces[0], nieces[1]), xorFigure(nieces[2], nieces[3])];
  figures.push(...witnesses.map((lines, index) => ({ nom: `Témoin ${index + 1}`, lignes: lines })));
  const judge = xorFigure(witnesses[0], witnesses[1]);
  figures.push({ nom: 'Juge', lignes: judge });
  const reponse = judge.reduce((sum, line) => sum + line, 0) % 2 === 0 ? 'OUI' : 'NON';
  const reading = await GeomancyReading.create({ client: req.user.id, question, figures, reponse });
  res.status(201).json({ _id: reading.id, question, figures, reponse, interpretation: reponse === 'OUI' ? 'Le tirage invite à avancer avec confiance, tout en restant attentif aux circonstances.' : 'Le tirage invite à la prudence et à prendre le temps de clarifier vos priorités.' });
}));
app.get('/api/geomancy/readings', requireAuth, asyncRoute(async (req, res) => res.json(await GeomancyReading.find({ client: req.user.id }).sort({ createdAt: -1 }).limit(50))));

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string') return next(new Error('Authentification requise.'));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) return next(new Error('Session invalide.'));
    socket.user = user;
    next();
  } catch (_error) {
    next(new Error('Session invalide ou expirée.'));
  }
});

io.on('connection', (socket) => {
  if (socket.user.role === 'ADMIN') {
    socket.join('admins');
    onlineAdminCount += 1;
    io.emit('team:availability', { online: onlineAdminCount > 0 });
  }
  socket.on('consultation:join', async (payload, acknowledge = () => {}) => {
    const consultation = await findAccessibleConsultation(payload?.consultationId, socket.user);
    if (!consultation) return acknowledge({ error: 'Consultation introuvable.' });
    socket.join(`consultation:${consultation.id}`);
    acknowledge({ ok: true });
  });
  socket.on('message:send', async (payload, acknowledge = () => {}) => {
    try {
      const consultation = await findAccessibleConsultation(payload?.consultationId, socket.user);
      const contenu = String(payload?.contenu || '').trim();
      if (!consultation || !socket.rooms.has(`consultation:${consultation.id}`)) return acknowledge({ error: 'Rejoignez une consultation autorisée avant d’envoyer un message.' });
      if (consultation.statut === 'FERMEE') return acknowledge({ error: 'Cette consultation est fermée.' });
      if (!contenu || contenu.length > 2000) return acknowledge({ error: 'Le message doit contenir entre 1 et 2000 caractères.' });
      const message = await Message.create({ consultation: consultation.id, sender: socket.user.id, contenu });
      consultation.dernierMessage = new Date();
      if (socket.user.role === 'ADMIN' && consultation.statut === 'OUVERTE') {
        consultation.statut = 'EN_COURS';
        consultation.admin = socket.user.id;
      }
      await consultation.save();
      const populated = await message.populate('sender', 'nom prenom role');
      io.to(`consultation:${consultation.id}`).emit('message:new', populated);
      if (socket.user.role !== 'ADMIN') io.to('admins').emit('consultation:message', { consultationId: consultation.id, message: populated });
      acknowledge({ ok: true, message: populated });
    } catch (error) {
      acknowledge({ error: error.message || 'Impossible d’envoyer le message.' });
    }
  });
  socket.on('disconnect', () => {
    if (socket.user.role === 'ADMIN') {
      onlineAdminCount = Math.max(0, onlineAdminCount - 1);
      io.emit('team:availability', { online: onlineAdminCount > 0 });
    }
  });
});

app.use((req, res) => respondError(res, 404, `Route inconnue : ${req.method} ${req.path}`));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return respondError(res, 400, error.code === 'LIMIT_FILE_SIZE' ? 'Fichier limité à 8 Mo.' : 'Dépôt de fichier invalide.');
  if (error instanceof mongoose.Error.ValidationError) return respondError(res, 400, error.message);
  if (error.code === 11000) return respondError(res, 409, 'Cette adresse e-mail est déjà utilisée.');
  if (process.env.NODE_ENV !== 'production') console.error(error);
  return respondError(res, error.status || 500, error.status ? error.message : 'Erreur interne du serveur.');
});

async function start() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shams');
  httpServer.listen(port, '0.0.0.0', () => console.log(`Shams API listening on port ${port}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Unable to start Shams API:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { app, io, start };