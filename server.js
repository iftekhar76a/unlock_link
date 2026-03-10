require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB connection will use environment variable from Vercel
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is not set');
  process.exit(1);
}

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ========== SCHEMAS ==========
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  accessUntil: { type: Date, default: null },
  lastAdWatch: { type: Date, default: null },
  totalClicks: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});
const Admin = mongoose.model('Admin', adminSchema);

const settingSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});
const Setting = mongoose.model('Setting', settingSchema);

const linkSchema = new mongoose.Schema({
  shortCode: { type: String, required: true, unique: true },
  targetUrl: { type: String, required: true },
  totalClicks: { type: Number, default: 0 },
  totalUnlocks: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Link = mongoose.model('Link', linkSchema);

// ========== INIT DEFAULT ADMIN & SETTINGS ==========
async function initAdmin() {
  const admin = await Admin.findOne({ username: 'admin' });
  if (!admin) {
    const hashedPassword = await bcrypt.hash('12312345', 10);
    await Admin.create({ username: 'admin', password: hashedPassword });
    console.log('✅ Default admin created: admin / 12312345');
  }
}
initAdmin();

async function initSettings() {
  const defaultSettings = { adDuration: 10, accessHours: 24, defaultTargetUrl: 'https://example.com' };
  for (const [key, value] of Object.entries(defaultSettings)) {
    const exists = await Setting.findOne({ key });
    if (!exists) await Setting.create({ key, value });
  }
}
initSettings();

// ========== MIDDLEWARE ==========
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, process.env.JWT_SECRET || 'mySuperSecretKey123', (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ========== API ROUTES ==========
app.get('/api/check-access', async (req, res) => {
  const { userId, link } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  let user = await User.findOne({ userId });
  const hasAccess = user && user.accessUntil && user.accessUntil > new Date();
  let linkData = null;
  if (link) {
    linkData = await Link.findOne({ shortCode: link });
    if (linkData) { linkData.totalClicks += 1; await linkData.save(); }
  }
  res.json({ 
    hasAccess: !!hasAccess, 
    accessUntil: user?.accessUntil || null, 
    targetUrl: linkData ? linkData.targetUrl : null 
  });
});

app.post('/api/grant-access', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  let user = await User.findOne({ userId });
  if (!user) user = new User({ userId });
  const accessHoursSetting = await Setting.findOne({ key: 'accessHours' });
  const accessHours = accessHoursSetting ? accessHoursSetting.value : 24;
  const accessUntil = new Date(); accessUntil.setHours(accessUntil.getHours() + accessHours);
  user.accessUntil = accessUntil; user.lastAdWatch = new Date(); user.totalClicks += 1;
  await user.save();
  res.json({ success: true, accessUntil });
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const admin = await Admin.findOne({ username });
  if (!admin || !(await bcrypt.compare(password, admin.password))) 
    return res.status(401).json({ message: 'Invalid credentials' });
  const token = jwt.sign({ username }, process.env.JWT_SECRET || 'mySuperSecretKey123', { expiresIn: '24h' });
  res.json({ token });
});

app.get('/api/admin/settings', authenticateToken, async (req, res) => {
  const settings = await Setting.find();
  const obj = {}; settings.forEach(s => obj[s.key] = s.value);
  res.json(obj);
});

app.post('/api/admin/settings', authenticateToken, async (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
  }
  res.json({ success: true });
});

app.get('/api/admin/users', authenticateToken, async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  res.json(users);
});

app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  const totalUsers = await User.countDocuments();
  const activeUsers = await User.countDocuments({ accessUntil: { $gt: new Date() } });
  const totalClicksAgg = await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalClicks' } } }]);
  const today = new Date(); today.setHours(0,0,0,0);
  const todayClicks = await User.countDocuments({ lastAdWatch: { $gte: today } });
  res.json({ totalUsers, activeUsers, totalClicks: totalClicksAgg[0]?.total || 0, todayClicks });
});

app.post('/api/admin/links', authenticateToken, async (req, res) => {
  const { targetUrl } = req.body;
  if (!targetUrl) return res.status(400).json({ error: 'targetUrl required' });
  const shortCode = Math.random().toString(36).substring(2, 8);
  const link = new Link({ shortCode, targetUrl });
  await link.save();
  res.json({ shortCode, targetUrl });
});

app.get('/api/admin/links', authenticateToken, async (req, res) => {
  const links = await Link.find().sort({ createdAt: -1 });
  res.json(links);
});

app.delete('/api/admin/links/:id', authenticateToken, async (req, res) => {
  await Link.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ========== STATIC FILES & FALLBACK ==========
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
