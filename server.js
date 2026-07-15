const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const SQLiteStore = require('better-sqlite3-session-store')(session);
const { TUTOR_NAME_ALIASES, normalizeTutorName, sameTutorName } = require('./lib/tutors');

const app = express();
const fs = require('fs');
const LOCAL_PATH = path.join(__dirname, 'data.db');
let DB_PATH = process.env.DB_PATH || LOCAL_PATH;
try {
  fs.accessSync('/data', fs.constants.W_OK);
  DB_PATH = '/data/data.db';
} catch (e) {}
if (DB_PATH === '/data/data.db' && !fs.existsSync(DB_PATH) && fs.existsSync(LOCAL_PATH)) {
  fs.copyFileSync(LOCAL_PATH, DB_PATH);
  console.log('Migrated local data.db to volume');
}
const db = new Database(DB_PATH);
const IS_VOLUME_DATABASE = DB_PATH !== LOCAL_PATH;
const ALLOW_DB_BOOTSTRAP = process.env.ALLOW_DB_BOOTSTRAP === 'true' || !IS_VOLUME_DATABASE;


if (ALLOW_DB_BOOTSTRAP) db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'teacher',
    code TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sheet_statuses (
    row_number INTEGER PRIMARY KEY,
    status TEXT DEFAULT 'New',
    demo_status TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    tutor_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    slot TEXT NOT NULL,
    student_name TEXT NOT NULL,
    student_age TEXT NOT NULL,
    language TEXT NOT NULL,
    level TEXT NOT NULL,
    topics_known TEXT DEFAULT '[]',
    topics_covered TEXT DEFAULT '[]',
    start_topic TEXT DEFAULT '',
    revision_topics TEXT DEFAULT '[]',
    feedback TEXT NOT NULL,
    interest_level INTEGER NOT NULL,
    additional_remarks TEXT DEFAULT '',
    date TEXT DEFAULT '',
    time TEXT DEFAULT '',
    status TEXT DEFAULT 'New',
    sheet_row INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

if (ALLOW_DB_BOOTSTRAP) {
  try { db.exec('ALTER TABLE assessments ADD COLUMN sheet_row INTEGER DEFAULT NULL'); } catch (e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN code TEXT UNIQUE'); } catch (e) {}
  try { db.exec('ALTER TABLE sheet_statuses ADD COLUMN demo_status TEXT'); } catch (e) {}
} else {
  for (const table of ['users', 'sheet_statuses', 'assessments']) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
      throw new Error(`Required table ${table} is missing; database bootstrap is disabled`);
    }
  }
}

function nameHash(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function generateTutorCode(name, existingCodes = new Set()) {
  let code;
  for (let i = 1; i <= 9999; i++) {
    code = String(i).padStart(4, '0');
    if (!existingCodes.has(code)) {
      existingCodes.add(code);
      return code;
    }
  }
  return '0001';
}

function syncTutorsFromSheet(entries) {
  const names = [...new Set((entries || sheetDataCache).map(e => e.tutor_name).filter(Boolean))];
  const allTeachers = db.prepare("SELECT id, name, code FROM users WHERE role = 'teacher'").all();
  const existingByName = new Map();
  const canonicalToIds = new Map();
  for (const t of allTeachers) {
    const key = t.name.trim().toLowerCase();
    const stripped = key.replace(/[^a-z0-9 ]/g, '');
    const canon = TUTOR_NAME_ALIASES[key] || TUTOR_NAME_ALIASES[stripped] || t.name.trim();
    existingByName.set(key, t);
    if (!canonicalToIds.has(canon)) canonicalToIds.set(canon, []);
    canonicalToIds.get(canon).push(t);
  }
  const existingCodes = new Set(allTeachers.filter(t => t.code).map(t => t.code));
  const dummyPass = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key || existingByName.has(key)) continue;
    const code = generateTutorCode(name, existingCodes);
    const email = key.replace(/[^a-z0-9]/g, '') + '@tutor.local';
    db.prepare('INSERT INTO users (name, email, password, role, code) VALUES (?, ?, ?, ?, ?)').run(name.trim(), email, dummyPass, 'teacher', code);
    existingByName.set(key, { name: name.trim() });
    console.log(`Auto-created tutor from sheet: ${name.trim()} -> code ${code}`);
  }
  for (const [canonical, ids] of canonicalToIds) {
    if (ids.length > 1) {
      const keep = ids[0];
      for (let i = 1; i < ids.length; i++) {
        const dup = ids[i];
        console.log(`Merging duplicate tutor: ${dup.name} (id=${dup.id}) -> ${canonical} (id=${keep.id})`);
        db.prepare('UPDATE assessments SET tutor_name = ? WHERE tutor_name = ?').run(canonical, dup.name);
        db.prepare('DELETE FROM users WHERE id = ?').run(dup.id);
        existingByName.delete(dup.name.trim().toLowerCase());
      }
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(canonical, keep.id);
    }
  }
  syncTutorCodesToSheet();
}

if (ALLOW_DB_BOOTSTRAP) {
  const tutorsWithoutCode = db.prepare("SELECT id, name FROM users WHERE role = 'teacher' AND (code IS NULL OR code = '')").all();
  const existingCodes = new Set(db.prepare("SELECT code FROM users WHERE role = 'teacher' AND code IS NOT NULL").all().map(r => r.code));
  for (const t of tutorsWithoutCode) {
    const code = generateTutorCode(t.name, existingCodes);
    db.prepare('UPDATE users SET code = ? WHERE id = ?').run(code, t.id);
  }

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminEmail && adminPassword.length >= 12 && !db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail)) {
    const hash = bcrypt.hashSync(adminPassword, 10);
    db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)').run('Admin', adminEmail, hash, 'admin');
    console.log('Bootstrap admin created from environment variables');
  }
}

const INITIAL_TUTORS = [
  "Madhumita","Saya M S","Abhishek","Thanseeha","Satheesh P","Vikrant Jaglan",
  "Nithish kumar","Nihar Hareesh","Gagan Bharadwaj","Ashitha KM","Vishnu cg",
  "Jishna","lakshya","Prashanth Reddy","ANAND J","Yathin Pradeep",
  "Afreen Tabassum","Selin","Rakshit Batra","Malavika R","Muhammad Bilal",
  "Ajaya Bose","Latheef","Vishnu","Varsha","Surya","Ann","ALEENA","ayswarya",
  "Haebel","Yadu","ANAND","AKHILJITH KC","Gaurav","ARYAN","amit","kessia",
  "malavika","Rejith","Gopakumar","Yasar","Safvan","Salman","Shivangi","Suhail",
  "Bhagya","Mishail","Joseph","Keerthana","Theertha","Nizar FT","Anjana SG",
  "Ebin FT","Athul","Abhijith","Arijith","Manu","Adesh","U.Abhijith",
  "Abhishek T.M","Karan","Sreehari","Devika","Alan ET"
];

const existingTutorCount = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'teacher'").get().cnt;
if (ALLOW_DB_BOOTSTRAP && existingTutorCount === 0) {
  const insert = db.prepare('INSERT INTO users (name, email, password, role, code) VALUES (?, ?, ?, ?, ?)');
  const dummyPass = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
  const allCodes = new Set();
  for (const name of INITIAL_TUTORS) {
    const code = generateTutorCode(name, allCodes);
    const email = name.toLowerCase().replace(/[^a-z0-9]/g, '') + '@tutor.local';
    insert.run(name, email, dummyPass, 'teacher', code);
  }
  console.log(`Seeded ${INITIAL_TUTORS.length} initial tutors with codes`);
}

app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");
  if (req.path.startsWith('/api/') || req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
const sessionSecret = process.env.SESSION_SECRET || (!IS_VOLUME_DATABASE ? 'local-development-only-secret' : '');
if (!sessionSecret) throw new Error('SESSION_SECRET is required when using the persistent database');
app.use(session({
  store: new SQLiteStore({
    client: db,
    expired: { clear: true, intervalMs: 900000 }
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_VOLUME_DATABASE,
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('host')) return next();
  } catch (e) {}
  return res.status(403).json({ error: 'Cross-origin request rejected' });
}

const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (loginAttempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  recent.push(now);
  loginAttempts.set(key, recent);
  next();
}

function canAccessTutor(req, tutorName) {
  return req.session.role === 'admin' || (req.session.role === 'teacher' && sameTutorName(req.session.name, tutorName));
}

function validateRowAccess(req, row) {
  const entry = sheetDataCache.find(e => e.row === row);
  return Boolean(entry && canAccessTutor(req, entry.tutor_name));
}

app.post('/api/login', loginRateLimit, requireSameOrigin, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || user.role !== 'admin') {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.name = user.name;
    res.json({ success: true, role: user.role, name: user.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', requireSameOrigin, (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, name: req.session.name, role: req.session.role });
});

app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    let storage = null;
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(path.dirname(DB_PATH));
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      storage = {
        freePercent: totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 1000) / 10 : null,
        low: totalBytes > 0 && freeBytes / totalBytes < 0.1,
      };
    }
    res.json({ status: storage?.low ? 'degraded' : 'ok', database: 'ok', storage });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

app.get('/api/admin/tutors/debug-raw', requireAuth, requireAdmin, (req, res) => {
  const tutors = db.prepare("SELECT id, name, code, role, created_at FROM users WHERE role = 'teacher' ORDER BY name ASC").all();
  res.json(tutors);
});

app.post('/api/admin/change-password', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || typeof newPassword !== 'string' || newPassword.length < 12) {
      return res.status(400).json({ error: 'Current password and a new password of at least 12 characters are required' });
    }
    const admin = db.prepare("SELECT id, password FROM users WHERE id = ? AND role = 'admin'").get(req.session.userId);
    if (!admin || !(await bcrypt.compare(currentPassword, admin.password))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, admin.id);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/tutors', requireAuth, requireAdmin, (req, res) => {
  const tutors = db.prepare("SELECT id, name, code, role, created_at FROM users WHERE role = 'teacher' ORDER BY created_at DESC").all();
  const seen = new Set();
  const deduped = [];
  for (const t of tutors) {
    const canon = TUTOR_NAME_ALIASES[t.name.trim().toLowerCase()] || t.name.trim();
    const key = canon.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    t.name = canon;
    deduped.push(t);
  }
  res.json(deduped);
});

app.post('/api/admin/tutors', requireAuth, requireAdmin, requireSameOrigin, (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name || !code) {
      return res.status(400).json({ error: 'Name and code are required' });
    }
    if (code.length < 3) {
      return res.status(400).json({ error: 'Code must be at least 3 characters' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE code = ?').get(code);
    if (existing) {
      return res.status(409).json({ error: 'This code is already in use' });
    }
    const dummyEmail = `tutor_${code}@internal.local`;
    const dummyPass = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    db.prepare('INSERT INTO users (name, email, password, role, code) VALUES (?, ?, ?, ?, ?)').run(name, dummyEmail, dummyPass, 'teacher', code);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/tutors/:id', requireAuth, requireAdmin, requireSameOrigin, (req, res) => {
  const tutor = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!tutor) return res.status(404).json({ error: 'Tutor not found' });
  if (tutor.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin users' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/tutors/:id/reset-code', requireAuth, requireAdmin, requireSameOrigin, (req, res) => {
  try {
    const tutor = db.prepare('SELECT id, name FROM users WHERE id = ? AND role = ?').get(req.params.id, 'teacher');
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' });
    const canon = TUTOR_NAME_ALIASES[tutor.name.trim().toLowerCase()] || tutor.name.trim();
    const canonKey = canon.toLowerCase();
    const allTeachers = db.prepare("SELECT id, name, code FROM users WHERE role = 'teacher'").all();
    const existingCodes = new Set();
    const sameTutorIds = [];
    for (const t of allTeachers) {
      const tCanon = (TUTOR_NAME_ALIASES[t.name.trim().toLowerCase()] || t.name.trim()).toLowerCase();
      if (tCanon === canonKey) {
        sameTutorIds.push(t.id);
        continue;
      }
      if (t.code) existingCodes.add(t.code);
    }
    let code;
    for (let i = 1; i <= 9999; i++) {
      const c = String(i).padStart(4, '0');
      if (!existingCodes.has(c)) { code = c; break; }
    }
    if (!code) return res.status(500).json({ error: 'No available codes' });
    for (const id of sameTutorIds) {
      db.prepare('UPDATE users SET code = ? WHERE id = ?').run(code, id);
    }
    res.json({ success: true, code, updatedCount: sameTutorIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

function requireTutor(req, res, next) {
  if (!req.session.userId || req.session.role !== 'teacher') {
    return res.status(401).json({ error: 'Tutor access required' });
  }
  next();
}

app.post('/api/tutor/login', loginRateLimit, requireSameOrigin, (req, res) => {
  try {
    const { code, tutor_name } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });
    const tutor = db.prepare("SELECT id, name, role FROM users WHERE code = ? AND role = 'teacher'").get(code);
    if (!tutor) return res.status(401).json({ error: 'Invalid code' });
    if (tutor_name && !sameTutorName(tutor.name, tutor_name)) return res.status(401).json({ error: 'Code does not match the selected tutor' });
    req.session.userId = tutor.id;
    req.session.role = tutor.role;
    req.session.name = normalizeTutorName(tutor.name) || tutor.name;
    res.json({ success: true, name: req.session.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tutor/assessments', requireTutor, (req, res) => {
  const tutorName = req.session.name;
  const list = db.prepare("SELECT id, tutor_name, phone, slot, student_name, student_age, language, level, interest_level, status, date, time, created_at FROM assessments WHERE tutor_name = ? ORDER BY created_at DESC").all(tutorName);
  res.json(list);
});

app.get('/api/tutor-names', (req, res) => {
  const tutors = db.prepare("SELECT name FROM users WHERE role = 'teacher' ORDER BY name ASC").all();
  const seen = new Set();
  const deduped = [];
  for (const t of tutors) {
    const canon = normalizeTutorName(t.name);
    const key = canon.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(canon);
  }
  res.json(deduped);
});

app.get('/api/slots', (req, res) => {
  const slots = [];
  for (let i = 1; i <= 26; i++) {
    slots.push(`Slot ${i}`);
  }
  res.json(slots);
});

const TOPICS = {
  Beginner: [
    'Coordinates',
    'Piece Movements',
    'Value of Pieces',
    'Capture',
    'Check',
    'Escaping Check',
    'Checkmate',
    'Checkmate Patterns',
    'Special moves',
    'All draws',
    'King and queen mate',
    'King and rook mate',
    'Opening principles',
    'Hanging pieces',
    'Counting pieces',
    'Double attack',
    'Skewer',
    'Pin',
    'Discovered attack'
  ],
  Intermediate: [
    'Tournament Rules',
    'Phases of the Game',
    'Italian Game',
    'Smothered mate',
    'Sicilian Defense',
    'Desperado and zwichenswang',
    'Windmill',
    'Ruy Lopez',
    'Remove and destroy',
    'Zugzwang',
    'Italian bc5',
    'King opposition',
    'Rook endgames',
    'Naidorf',
    'King and pawn',
    'Passed pawn',
    'd4 Opening Basics',
    'Outpost',
    'Open file',
    'd5/Nf6',
    'Rook 7th rank',
    'Double bishop mate',
    'Reti'
  ],
  Advanced: []
};

app.get('/api/topics/:level', (req, res) => {
  const topics = TOPICS[req.params.level];
  if (!topics) return res.status(400).json({ error: 'Invalid level' });
  res.json(topics);
});

app.post('/api/assessments', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    const { tutor_name, phone, slot, student_name, student_age, language, level, topics_known, topics_covered, start_topic, revision_topics, feedback, interest_level, additional_remarks, date, time, sheet_row } = req.body;
    const required = [tutor_name, slot, student_name, student_age, language, level, feedback, date, time];
    if (required.some(value => typeof value !== 'string' || !value.trim()) || !Number.isInteger(Number(interest_level)) || Number(interest_level) < 1 || Number(interest_level) > 5) {
      return res.status(400).json({ error: 'Required fields missing' });
    }
    if ([tutor_name, phone, slot, student_name, student_age, language, level, start_topic, additional_remarks, date, time].some(value => value && String(value).length > 1000) || feedback.length > 10000) {
      return res.status(400).json({ error: 'One or more fields are too long' });
    }
    if (req.session.role === 'teacher' && !sameTutorName(req.session.name, tutor_name)) {
      return res.status(403).json({ error: 'Tutor access denied' });
    }
    const requestedRow = Number.parseInt(sheet_row, 10);
    if (req.session.role === 'teacher' && (!Number.isInteger(requestedRow) || !validateRowAccess(req, requestedRow))) {
      return res.status(403).json({ error: 'This demo is not assigned to you' });
    }
    const stmt = db.prepare(`INSERT INTO assessments
      (user_id, tutor_name, phone, slot, student_name, student_age, language, level, topics_known, topics_covered, start_topic, revision_topics, feedback, interest_level, additional_remarks, date, time, sheet_row)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const sheetRowValue = (sheet_row !== undefined && sheet_row !== null && sheet_row !== '') ? parseInt(sheet_row) : null;
    let resolvedPhone = phone;
    let resolvedSheetRow = sheetRowValue;
    if (!resolvedSheetRow) {
      const cached = sheetDataCache.find(e => e.tutor_name.toLowerCase() === (tutor_name || '').toLowerCase() && e.student_name.toLowerCase() === (student_name || '').toLowerCase() && e.slot === slot);
      if (cached) resolvedSheetRow = cached.row;
    }
    if (!resolvedPhone) {
      const cached = resolvedSheetRow ? sheetDataCache.find(e => e.row === resolvedSheetRow) : sheetDataCache.find(e => e.tutor_name.toLowerCase() === (tutor_name || '').toLowerCase() && e.student_name.toLowerCase() === (student_name || '').toLowerCase());
      if (cached && cached.phone) resolvedPhone = cached.phone;
    }
    const result = stmt.run(
      req.session.userId, tutor_name || '', resolvedPhone, slot || '', student_name || '', student_age || '', language || '', level || '',
      JSON.stringify(topics_known || []), JSON.stringify(topics_covered || []),
      start_topic || '', JSON.stringify(revision_topics || []),
      feedback, interest_level || 0, additional_remarks || '', date || '', time || '',
      resolvedSheetRow
    );
    let trialRow = resolvedSheetRow;
    if (trialRow) {
      updateSheetRow(trialRow, 'Demo Done');
      db.prepare("INSERT INTO sheet_statuses (row_number, status, demo_status) VALUES (?, ?, ?) ON CONFLICT(row_number) DO UPDATE SET status = ?, demo_status = ?, updated_at = CURRENT_TIMESTAMP").run(trialRow, 'Demo Done', 'Demo Done', 'Demo Done', 'Demo Done');
      const entry = sheetDataCache.find(e => e.row === trialRow);
      if (entry) { entry.status = 'Demo Done'; entry.demo_status = 'Demo Done'; }
      db.prepare('UPDATE assessments SET sheet_row = ? WHERE id = ?').run(trialRow, result.lastInsertRowid);
    } else {
      trialRow = await appendToSheet({
        demo_status: 'Demo Done',
        slot, date, time, tutor_name, student_name,
        age: student_age, language, phone: resolvedPhone,
      });
      if (trialRow) {
        db.prepare('UPDATE assessments SET sheet_row = ? WHERE id = ?').run(trialRow, result.lastInsertRowid);
        db.prepare("INSERT INTO sheet_statuses (row_number, status, demo_status) VALUES (?, ?, ?) ON CONFLICT(row_number) DO UPDATE SET status = ?, demo_status = ?, updated_at = CURRENT_TIMESTAMP").run(trialRow, 'Demo Done', 'Demo Done', 'Demo Done', 'Demo Done');
      }
    }
    if (trialRow) {
      writeAssessmentFeedbackToTrialSheet(trialRow, { feedback, topics_known, topics_covered, start_topic, additional_remarks });
    }
    appendAssessmentToSheet({
      tutor_name, phone: resolvedPhone, slot, student_name,
      student_age, language, level,
      topics_known, topics_covered, start_topic,
      revision_topics, feedback, interest_level,
      additional_remarks, date, time, sheet_row: resolvedSheetRow,
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/assessments', requireAuth, requireAdmin, (req, res) => {
  const { tutor } = req.query;
  let list;
  if (tutor) {
    list = db.prepare("SELECT id, tutor_name, phone, slot, student_name, student_age, language, level, interest_level, status, date, time, sheet_row, created_at FROM assessments WHERE tutor_name = ? ORDER BY created_at DESC").all(tutor);
  } else {
    list = db.prepare("SELECT id, tutor_name, phone, slot, student_name, student_age, language, level, interest_level, status, date, time, sheet_row, created_at FROM assessments ORDER BY created_at DESC").all();
  }
  res.json(list);
});

app.get('/api/assessments/by-row/:row', requireAuth, (req, res) => {
  const row = parseInt(req.params.row);
  if (!Number.isInteger(row) || row < 1) return res.status(400).json({ error: 'Invalid row' });
  if (!validateRowAccess(req, row)) return res.status(403).json({ error: 'Access denied' });
  let a = db.prepare('SELECT * FROM assessments WHERE sheet_row = ? ORDER BY created_at DESC LIMIT 1').get(row);
  if (!a) {
    const entry = sheetDataCache.find(e => e.row === row);
    if (entry && entry.tutor_name && entry.student_name) {
      a = db.prepare(`SELECT * FROM assessments WHERE
        LOWER(tutor_name) = LOWER(?) AND
        LOWER(student_name) = LOWER(?) AND
        slot = ? AND
        date = ? AND
        time = ?
        ORDER BY created_at DESC LIMIT 1`).get(entry.tutor_name, entry.student_name, entry.slot || '', entry.date || '', entry.time || '');
      if (!a) {
        a = db.prepare(`SELECT * FROM assessments WHERE
          LOWER(tutor_name) = LOWER(?) AND
          LOWER(student_name) = LOWER(?)
          ORDER BY created_at DESC LIMIT 1`).get(entry.tutor_name, entry.student_name);
      }
    }
  }
  if (!a) return res.json(null);
  if (req.query.tutor && a.tutor_name && a.tutor_name.toLowerCase() !== req.query.tutor.toLowerCase()) {
    return res.json(null);
  }
  a.topics_known = JSON.parse(a.topics_known || '[]');
  a.topics_covered = JSON.parse(a.topics_covered || '[]');
  a.revision_topics = JSON.parse(a.revision_topics || '[]');
  res.json(a);
});

app.get('/api/assessments/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!canAccessTutor(req, a.tutor_name)) return res.status(403).json({ error: 'Access denied' });
  a.topics_known = JSON.parse(a.topics_known || '[]');
  a.topics_covered = JSON.parse(a.topics_covered || '[]');
  a.revision_topics = JSON.parse(a.revision_topics || '[]');
  res.json(a);
});

app.delete('/api/assessments/:id', requireAuth, requireSameOrigin, (req, res) => {
  const a = db.prepare('SELECT id, tutor_name FROM assessments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!canAccessTutor(req, a.tutor_name)) return res.status(403).json({ error: 'Access denied' });
  db.prepare('DELETE FROM assessments WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/assessments/by-row/:row', requireAuth, requireSameOrigin, async (req, res) => {
  try {
    const row = parseInt(req.params.row);
    if (!Number.isInteger(row) || !validateRowAccess(req, row)) return res.status(403).json({ error: 'Access denied' });
    db.prepare('DELETE FROM assessments WHERE sheet_row = ?').run(row);
    db.prepare("INSERT INTO sheet_statuses (row_number, status, demo_status) VALUES (?, ?, ?) ON CONFLICT(row_number) DO UPDATE SET status = ?, demo_status = ?, updated_at = CURRENT_TIMESTAMP").run(row, 'New', 'New', 'New', 'New');
    const entry = sheetDataCache.find(e => e.row === row);
    if (entry) { entry.status = 'New'; entry.demo_status = 'New'; }
    await updateSheetRow(row, '');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/assessments/:id/status', requireAuth, requireAdmin, requireSameOrigin, (req, res) => {
  const { status } = req.body;
  const valid = ['New', 'Contacted', 'CNR and Messaged', 'Hot/Potential', 'CNR 1', 'CNR 2', 'CNR 3', 'Not Interested', 'Converted'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE assessments SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

app.get('/api/tutors', requireAuth, requireAdmin, (req, res) => {
  const tutors = db.prepare("SELECT DISTINCT tutor_name FROM assessments WHERE tutor_name != '' ORDER BY tutor_name").all();
  res.json(tutors.map(t => t.tutor_name));
});

app.get('/api/analytics/summary', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM assessments').get().count;
  const byLevel = db.prepare('SELECT level, COUNT(*) as count FROM assessments GROUP BY level').all();
  const byLanguage = db.prepare('SELECT language, COUNT(*) as count FROM assessments GROUP BY language').all();
  const byInterest = db.prepare('SELECT interest_level, COUNT(*) as count FROM assessments GROUP BY interest_level ORDER BY interest_level').all();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM assessments GROUP BY status').all();
  const avgInterest = db.prepare('SELECT ROUND(AVG(interest_level), 1) as avg FROM assessments').get();
  const bySlot = db.prepare('SELECT slot, COUNT(*) as count FROM assessments GROUP BY slot ORDER BY slot').all();
  res.json({ total, byLevel, byLanguage, byInterest, byStatus, avgInterest: avgInterest.avg || 0, bySlot });
});

app.get('/api/analytics/over-time', requireAuth, (req, res) => {
  const data = db.prepare("SELECT DATE(created_at) as date, COUNT(*) as count FROM assessments GROUP BY DATE(created_at) ORDER BY date").all();
  res.json(data);
});

// Google Sheets integration
const { google } = require('googleapis');
const SPREADSHEET_ID = '1nYvdZwZgqymw89waZXr1gyOVgPtmPN9CuAzQWx5y8Mg';
const ASSESSMENTS_SHEET_ID = process.env.ASSESSMENTS_SHEET_ID || '1ZjfrqObcRpqYOKvnDBPmiM1H4jQCJXuS01oSLot7_zY';

let CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  const tmp = path.join('/tmp', 'google-credentials.json');
  fs.writeFileSync(tmp, process.env.GOOGLE_CREDENTIALS_JSON);
  CREDENTIALS_PATH = tmp;
}

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFilename: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function updateSheetRow(row, status) {
  if (!row) { console.error('updateSheetRow called with invalid row:', row); return; }
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Trial 2.0'!A${row}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[status]] },
    });
    console.log(`Sheet row ${row} updated to "${status}"`);
  } catch (err) {
    console.error(`Sheet update error for row ${row}:`, err.message);
  }
}

async function appendToSheet(data) {
  try {
    const sheets = getSheetsClient();
    const values = [[
      data.demo_status || 'Demo Done',
      '',
      data.slot || '',
      '', '', '',
      data.date || '',
      data.time || '',
      data.tutor_name || '',
      data.student_name || '',
      '',
      data.age || '',
      data.language || '',
      data.agent_name || '',
      '', '', '',
      data.phone || ''
    ]];
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Trial 2.0'!A:R",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
    const range = res.data?.updates?.updatedRange || '';
    const m = range.match(/R(\d+)$/);
    const row = m ? parseInt(m[1]) : null;
    if (row) {
      console.log(`Appended row ${row} to Trial 2.0 sheet for ${data.tutor_name}/${data.student_name}`);
    } else {
      console.warn('Sheet append completed but could not parse row number from range:', range);
    }
    return row;
  } catch (err) {
    console.error('Sheet append error:', err.message);
    return null;
  }
}

let assessmentSheetTab = 'Sheet1';

async function initAssessmentSheet() {
  try {
    const sheets = getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: ASSESSMENTS_SHEET_ID });
    assessmentSheetTab = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
    const range = `'${assessmentSheetTab}'!A1:R1`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range,
    });
    if (!res.data.values || !res.data.values[0] || !res.data.values[0][0]) {
      const headers = ['Timestamp', 'Tutor Name', 'Phone', 'Student Name', 'Age', 'Language', 'Level', 'Slot', 'Date', 'Time', 'Interest Level', 'Feedback', 'Topics Known', 'Topics Covered', 'Start Topic', 'Revision Topics', 'Additional Remarks', 'Sheet Row'];
      await sheets.spreadsheets.values.update({
        spreadsheetId: ASSESSMENTS_SHEET_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [headers] },
      });
      console.log(`Assessment sheet initialized (tab: ${assessmentSheetTab})`);
    }
  } catch (err) {
    console.error('Assessment sheet init error:', err.message);
  }
}

async function appendAssessmentToSheet(data) {
  try {
    const sheets = getSheetsClient();
    const values = [[
      new Date().toISOString(),
      data.tutor_name || '',
      data.phone || '',
      data.student_name || '',
      data.student_age || '',
      data.language || '',
      data.level || '',
      data.slot || '',
      data.date || '',
      data.time || '',
      data.interest_level || '',
      data.feedback || '',
      (data.topics_known || []).join(', '),
      (data.topics_covered || []).join(', '),
      data.start_topic || '',
      (data.revision_topics || []).join(', '),
      data.additional_remarks || '',
      data.sheet_row || '',
    ]];
    await sheets.spreadsheets.values.append({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range: `'${assessmentSheetTab}'!A:R`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
    console.log('Assessment appended to sheet for', data.student_name);
  } catch (err) {
    console.error('Assessment sheet append error:', err.message);
  }
}

async function writeAssessmentFeedbackToTrialSheet(row, data) {
  if (!row) return;
  try {
    const sheets = getSheetsClient();
    const vals = [[data.feedback || '', (data.topics_known || []).join(', '), (data.topics_covered || []).join(', '), data.start_topic || '', data.additional_remarks || '']];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Trial 2.0'!T${row}:X${row}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: vals },
    });
  } catch (err) {
    console.error(`Failed writing feedback to Trial 2.0 row ${row}:`, err.message);
  }
}

async function syncTutorCodesToSheet() {
  try {
    const tutors = db.prepare("SELECT name, code FROM users WHERE role = 'teacher' AND code IS NOT NULL AND code != '' ORDER BY name ASC").all();
    if (!tutors.length) return;
    const sheets = getSheetsClient();
    const headers = [['Name', 'Code']];
    const rows = tutors.map(t => [t.name, t.code]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Tutor Code'!A1",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [...headers, ...rows] },
    });
    console.log(`Tutor codes synced to 'Tutor Code' tab: ${tutors.length} tutors`);
  } catch (err) {
    if (err.message && (err.message.includes('named range') || err.message.includes('does not exist') || err.message.includes('Unable to parse'))) {
      try {
        const sheets = getSheetsClient();
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: 'Tutor Code' } } }] },
        });
        console.log("Created 'Tutor Code' tab");
        await syncTutorCodesToSheet();
      } catch (e2) {
        console.error('Failed to create Tutor Code tab:', e2.message);
      }
    } else {
      console.error('Tutor code sheet sync error:', err.message);
    }
  }
}

let sheetDataCache = [];
let lastSync = null;

async function syncSheet() {
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Trial 2.0'!A:R",
    });
    const rows = res.data.values || [];
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r[0] === 'ETE - please don\'t delete' || ((!r[0] || r[0].trim() === '') && (!r[8] || r[8].trim() === ''))) continue;
      if (i + 1 < 2) continue;
      const rawName = (r[8] || '').trim();
      const normalized = normalizeTutorName(rawName);
      if (!normalized) continue;
      const ss = db.prepare('SELECT status, demo_status FROM sheet_statuses WHERE row_number = ?').get(i + 1);
      const sheetDemo = (r[0] || '').trim() || 'New';
      const storedDemo = ss ? ss.demo_status : null;
      let useDemo;
      const hasAssessment = db.prepare('SELECT id FROM assessments WHERE sheet_row = ? LIMIT 1').get(i + 1);
      if (hasAssessment) {
        useDemo = 'Demo Done';
      } else if (storedDemo === 'Demo Not Done') {
        useDemo = 'Demo Not Done';
      } else if (sheetDemo === 'Demo Not Done') {
        useDemo = 'Demo Not Done';
      } else if (sheetDemo === 'Converted' || storedDemo === 'Converted') {
        useDemo = 'Converted';
      } else {
        useDemo = 'New';
      }
      entries.push({
        row: i + 1,
        demo_status: useDemo,
        slot: (r[2] || '').trim(),
        date: (r[6] || '').trim(),
        time: (r[7] || '').trim(),
        tutor_name: normalized,
        student_name: (r[9] || '').trim(),
        age: (r[11] || '').trim(),
        language: (r[12] || '').trim(),
        agent_name: (r[13] || '').trim(),
        phone: (r[17] || '').trim(),
        status: ss ? ss.status : 'New',
      });
    }
    // Keep production sync read-only: adding tutors remains an explicit admin action.
    const allTeachers = db.prepare("SELECT id, name, code FROM users WHERE role = 'teacher' AND code IS NOT NULL AND code != ''").all();
    const knownTutorNames = new Set(allTeachers.map(t => (normalizeTutorName(t.name) || '').toLowerCase()));
    const filtered = entries.filter(e => knownTutorNames.has((normalizeTutorName(e.tutor_name) || '').toLowerCase()));
    sheetDataCache = filtered;
    lastSync = new Date().toISOString();
    console.log(`Sheet synced: ${filtered.length} entries (filtered from ${entries.length})`);
  } catch (err) {
    console.error('Sheet sync error:', err.message);
  }
}

function normalizeDate(d) {
  if (!d) return '';
  const m = d.match(/^(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})$/);
  if (m) {
    let a = m[1], b = m[2], c = m[3];
    if (a.length === 4) {
      return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    }
    if (c.length === 4) {
      return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    }
    let dd = a.padStart(2, '0'), mm = b.padStart(2, '0'), yy = c;
    if (yy.length === 2) yy = '20' + yy;
    return `${yy}-${mm}-${dd}`;
  }
  return d.trim();
}

function fixExistingMismatches() {
  const assessments = db.prepare('SELECT id, sheet_row, tutor_name, student_name FROM assessments WHERE sheet_row IS NOT NULL').all();
  let fixed = 0;
  for (const a of assessments) {
    if (!a.sheet_row) continue;
    const entry = sheetDataCache.find(e => e.row === a.sheet_row);
    if (!entry) continue;
    const ds = entry.demo_status || '';
    if (ds !== 'New' && ds !== 'Demo Not Done' && ds !== 'Assessment Pending') continue;
    if (!entry.tutor_name || !a.tutor_name) continue;
    if (entry.tutor_name.toLowerCase() !== a.tutor_name.toLowerCase()) continue;
    if (!entry.student_name || !a.student_name) continue;
    if (entry.student_name.toLowerCase() !== a.student_name.toLowerCase()) continue;
    updateSheetRow(entry.row, 'Demo Done');
    entry.demo_status = 'Demo Done';
    db.prepare("INSERT INTO sheet_statuses (row_number, status, demo_status) VALUES (?, ?, ?) ON CONFLICT(row_number) DO UPDATE SET demo_status = ?, updated_at = CURRENT_TIMESTAMP").run(entry.row, 'New', 'Demo Done', 'Demo Done');
    fixed++;
  }
  if (fixed > 0) console.log(`Fixed ${fixed} already-linked assessments with wrong sheet status`);
}

function cleanStudentName(name) {
  return (name || '').replace(/\s*\(.*?\)\s*/g, '').replace(/\s*\[.*?\]\s*/g, '').trim();
}

function backfillAssessments() {
  const allTeachers = db.prepare("SELECT id, name, code FROM users WHERE role = 'teacher' AND code IS NOT NULL AND code != ''").all();
  const knownTutorNames = new Set(allTeachers.map(t => t.name.trim().toLowerCase()));

  const existingLinks = db.prepare('SELECT sheet_row, count(*) as cnt FROM assessments WHERE sheet_row IS NOT NULL GROUP BY sheet_row HAVING cnt > 0').all();
  const usedSheetRows = new Set(existingLinks.map(r => r.sheet_row));

  const unlinked = db.prepare("SELECT * FROM assessments WHERE sheet_row IS NULL AND tutor_name != '' AND student_name != '' AND slot != ''").all();
  let linked = 0;
  for (const a of unlinked) {
    if (!a.tutor_name || !a.student_name || !a.slot) continue;
    const aTutor = a.tutor_name.trim().toLowerCase();
    const aStudent = cleanStudentName(a.student_name).toLowerCase();

    const candidates = sheetDataCache.filter(e => {
      if (!e.tutor_name || !e.student_name || !e.slot) return false;
      if (e.tutor_name.toLowerCase() !== aTutor) return false;
      if (usedSheetRows.has(e.row)) return false;
      const eStudent = cleanStudentName(e.student_name).toLowerCase();
      if (eStudent !== aStudent && !aStudent.startsWith(eStudent) && !eStudent.startsWith(aStudent)) return false;
      if (e.slot !== a.slot) return false;
      return true;
    });

    if (candidates.length === 0) continue;

    let pick = null;
    if (candidates.length === 1) {
      pick = candidates[0];
    } else {
      const aDateNorm = normalizeDate(a.date || '');
      const aTimeNorm = (a.time || '').toLowerCase().replace(/\s+/g, '');
      for (const c of candidates) {
        const cDateNorm = normalizeDate(c.date || '');
        const cTimeNorm = (c.time || '').toLowerCase().replace(/\s+/g, '');
        if (cDateNorm && aDateNorm && cDateNorm === aDateNorm && cTimeNorm && aTimeNorm && cTimeNorm === aTimeNorm) {
          pick = c;
          break;
        }
      }
      if (!pick) pick = candidates[0];
    }

    if (pick) {
      db.prepare('UPDATE assessments SET sheet_row = ? WHERE id = ?').run(pick.row, a.id);
      db.prepare("INSERT INTO sheet_statuses (row_number, status, demo_status) VALUES (?, ?, ?) ON CONFLICT(row_number) DO UPDATE SET status = ?, demo_status = ?, updated_at = CURRENT_TIMESTAMP").run(pick.row, 'New', 'Demo Done', 'Demo Done', 'Demo Done');
      updateSheetRow(pick.row, 'Demo Done');
      if (pick.demo_status === 'New' || pick.demo_status === 'Assessment Pending') {
        pick.demo_status = 'Demo Done';
      }
      usedSheetRows.add(pick.row);
      linked++;
    }
  }
  if (linked > 0) console.log(`Backfill: linked ${linked} assessments to sheet rows`);
  const stillMissing = db.prepare("SELECT id, tutor_name, student_name, slot, date, time FROM assessments WHERE sheet_row IS NULL AND tutor_name != '' AND student_name != '' AND slot != ''").all();
  if (stillMissing.length > 0) {
    console.log(`Backfill: ${stillMissing.length} assessments still unmatched:`, stillMissing.map(a => `${a.tutor_name}/${a.student_name}/${a.slot}`).join(', '));
  }
}

app.get('/api/sheet-tutors', requireAuth, (req, res) => {
  const tutors = [...new Set(sheetDataCache.map(e => e.tutor_name).filter(Boolean))].sort();
  res.json(tutors);
});

app.get('/api/sheet-tutor/:name', requireAuth, (req, res) => {
  const requestedName = normalizeTutorName(decodeURIComponent(req.params.name)) || '';
  const effectiveName = req.session.role === 'teacher' ? req.session.name : requestedName;
  if (!canAccessTutor(req, effectiveName)) return res.status(403).json({ error: 'Access denied' });
  const tutorName = (normalizeTutorName(effectiveName) || '').toLowerCase();
  let entries = sheetDataCache.filter(e => sameTutorName(e.tutor_name, tutorName));
  if (req.session.role === 'admin' && !entries.length) {
    const firstWord = tutorName.split(/\s+/)[0];
    if (firstWord.length > 0) {
      entries = sheetDataCache.filter(e => {
        const sn = e.tutor_name.toLowerCase();
        if (!sn) return false;
        return sn === firstWord || sn.startsWith(firstWord) || firstWord.startsWith(sn) || sn.includes(firstWord) || firstWord.includes(sn);
      });
    }
  }
  if (req.session.role === 'admin' && !entries.length) {
    const words = tutorName.split(/\s+/);
    entries = sheetDataCache.filter(e => {
      const sn = e.tutor_name.toLowerCase();
      if (!sn) return false;
      return words.some(w => w.length > 1 && sn.includes(w));
    });
  }
  const safe = entries.map(({ phone, ...rest }) => rest);
  res.json(safe.sort((a, b) => b.row - a.row));
});

app.get('/api/demo-completion', requireAuth, (req, res) => {
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();
  let entries = sheetDataCache;
  if (from || to) {
    entries = entries.filter(e => {
      const d = e.date || '';
      const m = d.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
      let nd = d;
      if (m) {
        let dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0'), yy = m[3];
        if (yy.length === 2) yy = '20' + yy;
        nd = `${yy}-${mm}-${dd}`;
      }
      if (from && nd < from) return false;
      if (to && nd > to) return false;
      return true;
    });
  }
  const total = entries.length;
  const completed = entries.filter(e => {
    const s = (e.demo_status || '').toLowerCase();
    return (s.includes('done') && !s.includes('not')) || s === 'assessment pending';
  }).length;
  const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
  res.json({ total, completed, rate });
});

app.get('/api/conversion-rate', requireAuth, (req, res) => {
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();
  let entries = sheetDataCache;
  if (from || to) {
    entries = entries.filter(e => {
      const d = e.date || '';
      const m = d.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
      let nd = d;
      if (m) {
        let dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0'), yy = m[3];
        if (yy.length === 2) yy = '20' + yy;
        nd = `${yy}-${mm}-${dd}`;
      }
      if (from && nd < from) return false;
      if (to && nd > to) return false;
      return true;
    });
  }
  const demoDone = entries.filter(e => {
    const s = (e.demo_status || '').toLowerCase();
    return (s.includes('done') && !s.includes('not')) || s === 'assessment pending';
  }).length;
  const converted = entries.filter(e => (e.demo_status || '').toLowerCase() === 'converted').length;
  const total = demoDone + converted;
  const rate = total > 0 ? Math.round((converted / total) * 100) : 0;
  res.json({ demoDone, converted, total, rate });
});

app.get('/api/demo-count', requireAuth, (req, res) => {
  const target = (req.query.date || '').trim();
  if (!target) return res.json({ count: 0 });
  const count = sheetDataCache.filter(e => {
    const d = e.date || '';
    const m = d.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
    if (!m) return d === target;
    let dd = m[1].padStart(2, '0'), mm = m[2].padStart(2, '0'), yy = m[3];
    if (yy.length === 2) yy = '20' + yy;
    return `${yy}-${mm}-${dd}` === target;
  }).length;
  res.json({ count });
});

app.get('/api/sheet-data', requireAuth, requireAdmin, (req, res) => {
  let entries = sheetDataCache;
  if (req.query.tutor) {
    const t = req.query.tutor.toLowerCase();
    entries = entries.filter(e => e.tutor_name.toLowerCase() === t);
  }
  res.json({ entries, lastSync });
});

app.patch('/api/sheet-data/:row/demo-not-done', requireAuth, requireSameOrigin, async (req, res) => {
  const row = parseInt(req.params.row);
  if (!Number.isInteger(row) || !validateRowAccess(req, row)) return res.status(403).json({ error: 'Access denied' });
  const entry = sheetDataCache.find(e => e.row === row);
  if (entry) entry.demo_status = 'Demo Not Done';
  db.prepare("INSERT INTO sheet_statuses (row_number, status, demo_status) VALUES (?, ?, ?) ON CONFLICT(row_number) DO UPDATE SET demo_status = ?, updated_at = CURRENT_TIMESTAMP").run(row, 'New', 'Demo Not Done', 'Demo Not Done');
  try {
    await updateSheetRow(row, 'Demo Not Done');
  } catch (e) {
    console.error('Failed to update sheet:', e.message);
  }
  res.json({ success: true });
});

app.patch('/api/sheet-data/:row/status', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  const { status } = req.body;
  const valid = ['New', 'In Conversation', 'CNR', 'Hot', 'Converted'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const row = parseInt(req.params.row);
  const entry = sheetDataCache.find(e => e.row === row);
  const wasConverted = entry && entry.status === 'Converted';
  db.prepare('INSERT INTO sheet_statuses (row_number, status) VALUES (?, ?) ON CONFLICT(row_number) DO UPDATE SET status = ?, updated_at = CURRENT_TIMESTAMP').run(row, status, status);
  if (entry) entry.status = status;
  if (status === 'Converted') {
    if (entry) entry.demo_status = 'Converted';
    try {
      await updateSheetRow(row, 'Converted');
    } catch (e) {
      console.error('Failed to update sheet:', e.message);
    }
  } else if (wasConverted) {
    const assessment = db.prepare('SELECT id FROM assessments WHERE sheet_row = ?').get(row);
    const revertStatus = assessment ? 'Demo Done' : 'New';
    if (entry) entry.demo_status = revertStatus;
    try {
      await updateSheetRow(row, revertStatus);
    } catch (e) {
      console.error('Failed to update sheet:', e.message);
    }
  }
  res.json({ success: true });
});

app.post('/api/sync-sheet', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  await syncSheet();
  res.json({ success: true, count: sheetDataCache.length, lastSync });
});

async function recoverUnlinkedAssessments() {
  console.log('Starting assessment recovery (link-only, no append)...');
  backfillAssessments();
  const stillMissing = db.prepare("SELECT id, tutor_name, student_name, slot FROM assessments WHERE sheet_row IS NULL AND tutor_name != '' AND student_name != '' AND slot != ''").all();
  if (stillMissing.length > 0) {
    console.log(`Recovery: ${stillMissing.length} assessments remain unlinked (no matching Trial row)`);
  }
  await backfillAssessmentSheetPhones();
}

async function backfillAssessmentSheetPhones() {
  try {
    const sheets = getSheetsClient();
    const range = `'${assessmentSheetTab}'!A:R`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range,
    });
    const rows = res.data.values || [];
    if (rows.length < 2) { console.log('Assessment sheet has no data rows'); return 0; }
    let updated = 0;
    let emptyChecked = 0;
    let overwritten = 0;
    let unmatched = 0;
    let foundByRow = 0;
    let foundByName = 0;
    let foundPhone = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const currentPhone = (row[2] || '').trim();
      const sheetRow = (row[17] || '').trim();
      const tutorName = (row[1] || '').trim().toLowerCase();
      const rawStudentName = (row[3] || '').trim().toLowerCase();
      const studentName = cleanStudentName(rawStudentName).toLowerCase();
      let entry = null;
      if (tutorName && rawStudentName) {
        entry = sheetDataCache.find(e => e.tutor_name.toLowerCase() === tutorName && e.student_name.toLowerCase() === rawStudentName);
        if (!entry) {
          entry = sheetDataCache.find(e => e.tutor_name.toLowerCase() === tutorName && cleanStudentName(e.student_name).toLowerCase() === studentName);
        }
        if (entry) foundByName++;
      }
      if (!entry && sheetRow) {
        entry = sheetDataCache.find(e => String(e.row) === sheetRow);
        if (entry) foundByRow++;
      }
      if (!entry) { unmatched++; continue; }
      const trialPhone = (entry.phone || '').trim();
      if (trialPhone && trialPhone !== currentPhone) {
        try {
          await sheets.spreadsheets.values.update({
            spreadsheetId: ASSESSMENTS_SHEET_ID,
            range: `'${assessmentSheetTab}'!C${i + 1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[trialPhone]] },
          });
          if (!currentPhone) emptyChecked++;
          else overwritten++;
          updated++;
        } catch (updateErr) {
          console.error(`Failed to update Assessment Sheet row ${i + 1}: ${updateErr.message}`);
        }
      } else if (trialPhone) {
        foundPhone++;
      }
    }
    console.log(`Phone sync: unmatched=${unmatched}, filled=${emptyChecked}, overwritten=${overwritten}, alreadyMatched=${foundPhone}`);
    return { updated, emptyChecked, overwritten, unmatched };
  } catch (err) {
    console.error('Assessment sheet phone sync error:', err.message);
    return { updated: -1, error: err.message };
  }
}

app.post('/api/backfill-phones', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const result = await backfillAssessmentSheetPhones();
    res.json({ success: true, phoneBackfill: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/sync-phones-to-assessment', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const result = await backfillAssessmentSheetPhones();
    res.json({ success: true, message: 'Assessment Sheet phones synced from Trial 2.0', stats: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

async function backfillAssessmentFeedbackToTrialSheet() {
  try {
    const sheets = getSheetsClient();
    const range = `'${assessmentSheetTab}'!A:X`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range,
    });
    const rows = res.data.values || [];
    if (rows.length < 2) { console.log('Assessment sheet has no data rows'); return 0; }
    let written = 0;
    let skipped = 0;
    let matched = 0;
    let phoneVerified = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const tutor = (row[1] || '').trim();
      const phone = (row[2] || '').trim();
      const rawStudent = (row[3] || '').trim();
      const student = cleanStudentName(rawStudent).trim();
      if (!tutor || !student) { skipped++; continue; }
      const feedback = (row[11] || '').trim();
      const topicsKnown = (row[12] || '').trim();
      const topicsCovered = (row[13] || '').trim();
      const startTopic = (row[14] || '').trim();
      const additionalRemarks = (row[16] || '').trim();
      if (!feedback && !topicsKnown && !topicsCovered && !startTopic && !additionalRemarks) { skipped++; continue; }
      let cacheEntry = null;
      // Step 1: exact name match (raw student name)
      if (rawStudent) {
        cacheEntry = sheetDataCache.find(e =>
          e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
          e.student_name.toLowerCase() === rawStudent.toLowerCase()
        );
      }
      // Step 2: fallback to cleaned name match
      if (!cacheEntry) {
        cacheEntry = sheetDataCache.find(e =>
          e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
          cleanStudentName(e.student_name).toLowerCase() === student.toLowerCase()
        );
      }
      // Step 3: verify by phone, redirect if needed
      if (cacheEntry && phone) {
        if (cacheEntry.phone === phone) {
          phoneVerified++;
        } else {
          const phoneMatch = sheetDataCache.find(e =>
            e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
            e.phone === phone
          );
          if (phoneMatch) {
            console.log(`PHONE REDIRECT: "${tutor}/${rawStudent}" name->row ${cacheEntry.row}, phone->row ${phoneMatch.row}`);
            cacheEntry = phoneMatch;
          }
        }
      }
      if (!cacheEntry) { skipped++; continue; }
      matched++;
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'Trial 2.0'!T${cacheEntry.row}:X${cacheEntry.row}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[feedback, topicsKnown, topicsCovered, startTopic, additionalRemarks]] },
        });
        written++;
      } catch (e) {
        console.error(`Failed writing to Trial 2.0 row ${cacheEntry.row}:`, e.message);
      }
    }
    console.log(`Assessment feedback backfill: matched=${matched}, phoneVerified=${phoneVerified}, written=${written}, skipped=${skipped}`);
    return written;
  } catch (err) {
    console.error('Assessment feedback backfill error:', err.message);
    return -1;
  }
}

async function fixFeedbackMatching() {
  const sheets = getSheetsClient();
  const assRes = await sheets.spreadsheets.values.get({
    spreadsheetId: ASSESSMENTS_SHEET_ID,
    range: `'${assessmentSheetTab}'!A:X`,
  });
  const assRows = assRes.data.values || [];
  if (assRows.length < 2) { console.log('Assessment sheet has no data rows'); return { fixed: 0, cleared: 0, skipped: 0 }; }

  // Read current Trial 2.0 T-X values
  const trialRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Trial 2.0'!T:X",
  });
  const trialRows = trialRes.data.values || [];

  let fixed = 0;
  let cleared = 0;
  let skipped = 0;
  let phoneVerified = 0;

  // Map of correct Trial row → feedback values from Assessment Sheet
  const corrections = {};
  // Rows that were name-matched but were NOT the phone-verified correct row (stale data to clear)
  const staleRows = new Set();

  for (let i = 1; i < assRows.length; i++) {
    const row = assRows[i];
    const tutor = (row[1] || '').trim();
    const phone = (row[2] || '').trim();
    const rawStudent = (row[3] || '').trim();
    const student = cleanStudentName(rawStudent).trim();
    if (!tutor || !student) { skipped++; continue; }

    const feedback = (row[11] || '').trim();
    const topicsKnown = (row[12] || '').trim();
    const topicsCovered = (row[13] || '').trim();
    const startTopic = (row[14] || '').trim();
    const additionalRemarks = (row[16] || '').trim();
    if (!feedback && !topicsKnown && !topicsCovered && !startTopic && !additionalRemarks) { skipped++; continue; }

    const feedbackVals = [feedback, topicsKnown, topicsCovered, startTopic, additionalRemarks];

    // Find name-matched candidate (old behavior)
    let nameMatch = null;
    if (rawStudent) {
      nameMatch = sheetDataCache.find(e =>
        e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
        e.student_name.toLowerCase() === rawStudent.toLowerCase()
      );
    }
    if (!nameMatch) {
      nameMatch = sheetDataCache.find(e =>
        e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
        cleanStudentName(e.student_name).toLowerCase() === student.toLowerCase()
      );
    }

    // Find phone-verified correct entry
    let correctEntry = null;
    if (nameMatch && phone) {
      if (nameMatch.phone === phone) {
        correctEntry = nameMatch;
        phoneVerified++;
      } else {
        const phoneMatch = sheetDataCache.find(e =>
          e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
          e.phone === phone
        );
        if (phoneMatch) {
          console.log(`FIX: "${tutor}/${rawStudent}" name->row ${nameMatch.row}, phone->row ${phoneMatch.row}`);
          correctEntry = phoneMatch;
          if (nameMatch.row !== phoneMatch.row) {
            staleRows.add(nameMatch.row);
          }
        } else {
          correctEntry = nameMatch;
        }
      }
    } else {
      correctEntry = nameMatch;
    }

    if (!correctEntry) { skipped++; continue; }
    corrections[correctEntry.row] = { vals: feedbackVals, tutor, student: rawStudent };
  }

  // Build batch update requests
  const batchRequests = [];

  // Clear stale data from wrong rows
  for (const row of staleRows) {
    const currentVals = trialRows[row - 1] || [];
    const hasData = currentVals && currentVals.some(v => (v || '').trim());
    if (hasData) {
      batchRequests.push({
        range: `'Trial 2.0'!T${row}:X${row}`,
        values: [['', '', '', '', '']],
      });
      cleared++;
    }
  }

  // Write correct feedback to all correct rows
  for (const [row, data] of Object.entries(corrections)) {
    batchRequests.push({
      range: `'Trial 2.0'!T${row}:X${row}`,
      values: [data.vals],
    });
    fixed++;
  }

  // Apply all updates in batches of 50 to stay under rate limits
  const BATCH_SIZE = 50;
  for (let i = 0; i < batchRequests.length; i += BATCH_SIZE) {
    const batch = batchRequests.slice(i, i + BATCH_SIZE);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: batch,
      },
    });
    if (i + BATCH_SIZE < batchRequests.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`Fix feedback matching: fixed=${fixed}, cleared=${cleared}, skipped=${skipped}, phoneVerified=${phoneVerified}, totalBatchUpdates=${batchRequests.length}`);
  return { fixed, cleared, skipped, phoneVerified };
}

async function backfillPhonesToTrialSheet() {
  try {
    const sheets = getSheetsClient();
    const range = `'${assessmentSheetTab}'!A:R`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range,
    });
    const rows = res.data.values || [];
    if (rows.length < 2) { console.log('Assessment sheet has no data rows'); return 0; }
    let updated = 0;
    let checked = 0;
    let matched = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const phone = (row[2] || '').trim();
      if (!phone) continue;
      const tutor = (row[1] || '').trim();
      const student = cleanStudentName(row[3] || '').trim();
      if (!tutor || !student) continue;
      checked++;
      const cacheEntry = sheetDataCache.find(e =>
        e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
        cleanStudentName(e.student_name).toLowerCase() === student.toLowerCase()
      );
      if (!cacheEntry) continue;
      matched++;
      const existing = (cacheEntry.phone || '').trim();
      if (existing === phone) continue;
      if (existing) continue;
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'Trial 2.0'!R${cacheEntry.row}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[phone]] },
        });
        const currentEntry = sheetDataCache.find(e => e.row === cacheEntry.row);
        if (currentEntry) currentEntry.phone = phone;
        updated++;
      } catch (e) {
        console.error(`Failed updating Trial 2.0 row ${cacheEntry.row} phone:`, e.message);
      }
    }
    console.log(`Phone push to Trial 2.0: checked=${checked}, matched=${matched}, updated=${updated}`);
    return updated;
  } catch (err) {
    console.error('Phone push to Trial 2.0 error:', err.message);
    return -1;
  }
}

app.post('/api/backfill-phones-to-trial', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const count = await backfillPhonesToTrialSheet();
    res.json({ success: true, phonePush: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search-phone/:phone', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const target = req.params.phone;
    const range = `'${assessmentSheetTab}'!A:R`;
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range,
    });
    const rows = result.data.values || [];
    const found = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const phone = (row[2] || '').trim();
      if (phone.includes(target)) {
        const tutor = (row[1] || '').trim();
        const student = (row[3] || '').trim();
        const sheetRow = (row[17] || '').trim();
        const cacheEntry = sheetDataCache.find(e =>
          e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
          cleanStudentName(e.student_name).toLowerCase() === cleanStudentName(student).toLowerCase()
        );
        found.push({
          assessmentRow: i + 1,
          tutor, student, phone,
          sheetRow,
          trialRow: cacheEntry ? cacheEntry.row : null,
          trialPhone: cacheEntry ? (cacheEntry.phone || '') : null,
          inTrialCache: !!cacheEntry,
        });
      }
    }
    res.json({ searchPhone: target, found: found.length, results: found });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/check-trial-row/:row', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const rowNum = parseInt(req.params.row);
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Trial 2.0'!A${rowNum}:R${rowNum}`,
    });
    const row = result.data.values ? result.data.values[0] : [];
    const allResult = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Trial 2.0'!A:R`,
    });
    const allRows = allResult.data.values || [];
    const allRow = allRows[rowNum - 1] || [];
    const cacheEntry = sheetDataCache.find(e => e.row === rowNum);
    res.json({
      trialRow: rowNum,
      columns: ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R'],
      valuesExplicitRange: row,
      phoneExplicit: row[17] || '',
      valuesAllRange: allRow,
      phoneAllRange: allRow[17] || '',
      cachePhone: cacheEntry ? (cacheEntry.phone || '') : null,
      inCache: !!cacheEntry,
      explicitLength: row.length,
      allRangeLength: allRow.length,
      allRowsTotal: allRows.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/diagnose-phones', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const asRange = `'${assessmentSheetTab}'!A:X`;
    const asResult = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range: asRange,
    });
    const asRows = asResult.data.values || [];
    let hasPhone = 0, noPhone = 0, matched = 0, phoneMatch = 0, phoneDiff = 0, noMatch = 0;
    const diffs = [];
    const noMatches = [];
    for (let i = 1; i < asRows.length; i++) {
      const row = asRows[i];
      const phone = (row[2] || '').trim();
      const tutor = (row[1] || '').trim();
      const student = cleanStudentName(row[3] || '').trim();
      if (!phone) { noPhone++; continue; }
      if (!tutor || !student) { noPhone++; continue; }
      hasPhone++;
      const ce = sheetDataCache.find(e =>
        e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
        cleanStudentName(e.student_name).toLowerCase() === student.toLowerCase()
      );
      if (!ce) {
        noMatches.push({ row: i+1, tutor, student, phone, slot: (row[7]||'').trim(), date: (row[8]||'').trim(), time: (row[9]||'').trim(), age: (row[4]||'').trim(), language: (row[5]||'').trim() });
        noMatch++;
        continue;
      }
      matched++;
      if ((ce.phone || '') === phone) { phoneMatch++; continue; }
      phoneDiff++;
      diffs.push({ row: i+1, tutor, student, asPhone: phone, trialPhone: ce.phone || '', trialRow: ce.row });
    }
    res.json({
      assessmentRows: asRows.length - 1,
      hasPhone, noPhone, matched, phoneMatch, phoneDiff, noMatch,
      diffs,
      noMatches,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reverse-trial-phones', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const range = `'${assessmentSheetTab}'!A:R`;
    const asResult = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range,
    });
    const asRows = asResult.data.values || [];
    const toClear = [];
    for (let i = 1; i < asRows.length; i++) {
      const row = asRows[i];
      const phone = (row[2] || '').trim();
      const tutor = (row[1] || '').trim();
      const student = cleanStudentName(row[3] || '').trim();
      if (!phone || !tutor || !student) continue;
      const ce = sheetDataCache.find(e =>
        e.tutor_name.toLowerCase() === tutor.toLowerCase() &&
        cleanStudentName(e.student_name).toLowerCase() === student.toLowerCase()
      );
      if (!ce) continue;
      if ((ce.phone || '').trim() !== phone) continue;
      toClear.push(ce.row);
    }
    const unique = [...new Set(toClear)];
    let cleared = 0;
    for (const r of unique) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'Trial 2.0'!R${r}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['']] },
        });
        const entry = sheetDataCache.find(e => e.row === r);
        if (entry) entry.phone = '';
        cleared++;
      } catch (e) {
        console.error(`Failed to clear Trial 2.0 row ${r} phone:`, e.message);
      }
    }
    res.json({ success: true, cleared, uniqueRows: unique.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clear-trial-feedback', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const range = `'${assessmentSheetTab}'!A:R`;
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range,
    });
    const rows = result.data.values || [];
    const toClear = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const sheetRow = (row[17] || '').trim();
      if (sheetRow) toClear.push(parseInt(sheetRow));
    }
    let cleared = 0;
    const uniqueRows = [...new Set(toClear)];
    for (const r of uniqueRows) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'Trial 2.0'!T${r}:X${r}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['', '', '', '', '']] },
        });
        cleared++;
      } catch (e) {
        console.error(`Failed to clear Trial 2.0 row ${r}:`, e.message);
      }
    }
    res.json({ success: true, cleared, uniqueRows: uniqueRows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/verify-trial-mapping', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const range = `'${assessmentSheetTab}'!A:R`;
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range,
    });
    const rows = result.data.values || [];
    const samples = [];
    let checked = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const sheetRow = (row[17] || '').trim();
      checked++;
      if (sheetRow) {
        const trialRow = parseInt(sheetRow);
        const cacheEntry = sheetDataCache.find(e => e.row === trialRow);
        samples.push({
          assessmentRow: i + 1,
          tutor: (row[1] || '').trim(),
          student: (row[3] || '').trim(),
          phone: (row[2] || '').trim(),
          sheetRow: sheetRow,
          cacheTutor: cacheEntry ? cacheEntry.tutor_name : null,
          cacheStudent: cacheEntry ? cacheEntry.student_name : null,
          cachePhone: cacheEntry ? (cacheEntry.phone || '') : null,
          match: cacheEntry ? (cacheEntry.tutor_name.toLowerCase() === (row[1] || '').trim().toLowerCase()) : false,
          feedback: (row[11] || '').trim().substring(0, 30),
          topicsKnown: (row[12] || '').trim().substring(0, 30),
          topicsCovered: (row[13] || '').trim().substring(0, 30),
          startTopic: (row[14] || '').trim().substring(0, 30),
          additionalRemarks: (row[16] || '').trim().substring(0, 30),
        });
      }
    }
    const bad = samples.filter(s => s.cacheTutor && !s.match);
    const noCache = samples.filter(s => !s.cacheTutor);
    res.json({
      totalRows: rows.length,
      checked,
      rowsWithSheetRow: samples.length,
      mismatchCount: bad.length,
      noCacheCount: noCache.length,
      samples: samples.slice(0, 30),
      badMappings: bad.slice(0, 20),
      noCacheRows: noCache.slice(0, 20),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backfill-trial-sheet', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const count = await backfillAssessmentFeedbackToTrialSheet();
    res.json({ success: true, backfilled: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fix-feedback', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const result = await fixFeedbackMatching();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/assessment-sheet', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: ASSESSMENTS_SHEET_ID,
      range: `'${assessmentSheetTab}'!A:R`,
    });
    const rows = result.data.values || [];
    const checks = [];
    for (let i = 1; i < Math.min(rows.length, 408); i++) {
      const row = rows[i];
      const phone = (row[2] || '').trim();
      const sheetRow = (row[17] || '').trim();
      const tutor = (row[1] || '').trim();
      const student = (row[3] || '').trim();
      if (!phone) {
        let byRow = null;
        let byName = null;
        if (sheetRow) {
          const sr = sheetDataCache.find(e => String(e.row) === sheetRow);
          if (sr) byRow = { phone: sr.phone, tutor_co: sr.tutor_name, student_co: sr.student_name };
        }
        if (tutor && student) {
          const sn = sheetDataCache.find(e => e.tutor_name.toLowerCase() === tutor.toLowerCase() && e.student_name.toLowerCase() === student.toLowerCase());
          if (sn) byName = { phone: sn.phone, row_co: sn.row, tutor_co: sn.tutor_name, student_co: sn.student_name };
        }
        checks.push({ assessmentRow: i + 1, tutor, student, sheetRow, byRow, byName });
      }
    }
    // Check if specific names exist in cache
    const cacheSample = sheetDataCache.filter(e => ['afreen tabassum', 'aleena', 'thanseeha'].includes(e.tutor_name.toLowerCase())).slice(0, 5).map(e => ({ row: e.row, tutor: e.tutor_name, student: e.student_name, phone: e.phone }));
    // Quick write test — update first match
    let writeTest = null;
    if (checks.length > 0 && checks[0].byName) {
      try {
        const target = checks[0];
        await sheets.spreadsheets.values.update({
          spreadsheetId: ASSESSMENTS_SHEET_ID,
          range: `'${assessmentSheetTab}'!C${target.assessmentRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[target.byName.phone]] },
        });
        writeTest = { assessmentRow: target.assessmentRow, newPhone: target.byName.phone, status: 'ok' };
      } catch (e) {
        writeTest = { assessmentRow: checks[0].assessmentRow, error: e.message };
      }
    }
    const summary = { totalEmpty: 0, matchByName: 0, matchByRow: 0, wouldUpdate: 0 };
    for (const c of checks) {
      summary.totalEmpty++;
      if (c.byName) summary.matchByName++;
      if (c.byRow) summary.matchByRow++;
      if (c.byName && c.byName.phone) summary.wouldUpdate++;
      else if (c.byRow && c.byRow.phone) summary.wouldUpdate++;
    }
    res.json({
      totalRows: rows.length,
      cacheSize: sheetDataCache.length,
      assessmentSheetTab,
      checks: checks.slice(0, 30),
      summary,
      cacheSample,
      writeTest,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/recover-assessments', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    await syncSheet();
    backfillAssessments();
    const stillMissing = db.prepare("SELECT id, tutor_name, student_name, slot FROM assessments WHERE sheet_row IS NULL AND tutor_name != '' AND student_name != '' AND slot != ''").all();
    console.log(`Recover: ${stillMissing.length} remain unlinked (no matching Trial row — will NOT append new rows)`);
    const phoneResult = await backfillAssessmentSheetPhones();
    const trialFeedbackResult = await backfillAssessmentFeedbackToTrialSheet();
    const phonePushResult = await backfillPhonesToTrialSheet();
    const linked = db.prepare("SELECT COUNT(*) as cnt FROM assessments WHERE sheet_row IS NOT NULL").get().cnt;
    const unlinked = db.prepare("SELECT COUNT(*) as cnt FROM assessments WHERE sheet_row IS NULL AND tutor_name != '' AND student_name != '' AND slot != ''").get().cnt;
    res.json({ success: true, totalLinked: linked, totalUnlinked: unlinked, phoneBackfill: phoneResult, trialFeedbackBackfill: trialFeedbackResult, phonePushToTrial: phonePushResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cleanup-wrong-links', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const assessments = db.prepare("SELECT id, tutor_name, student_name, sheet_row FROM assessments WHERE sheet_row IS NOT NULL").all();
    let unlinked = 0;
    let kept = 0;
    for (const a of assessments) {
      if (!a.sheet_row) continue;
      const entry = sheetDataCache.find(e => e.row === a.sheet_row);
      if (!entry) {
        db.prepare('UPDATE assessments SET sheet_row = NULL WHERE id = ?').run(a.id);
        unlinked++;
        continue;
      }
      const aStudent = cleanStudentName(a.student_name || '').toLowerCase();
      const eStudent = cleanStudentName(entry.student_name || '').toLowerCase();
      if (entry.tutor_name.toLowerCase() !== a.tutor_name.toLowerCase() || (aStudent && eStudent && aStudent !== eStudent)) {
        db.prepare('UPDATE assessments SET sheet_row = NULL WHERE id = ?').run(a.id);
        unlinked++;
      } else {
        kept++;
      }
    }
    console.log(`Cleanup: unlinked ${unlinked} wrong links, kept ${kept} correct`);
    const stillLinked = db.prepare("SELECT COUNT(*) as cnt FROM assessments WHERE sheet_row IS NOT NULL").get().cnt;
    const stillUnlinked = db.prepare("SELECT COUNT(*) as cnt FROM assessments WHERE sheet_row IS NULL AND tutor_name != '' AND student_name != '' AND slot != ''").get().cnt;
    res.json({ success: true, unlinked, kept, stillLinked, stillUnlinked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cleanup-garbage', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
  try {
    const sheets = getSheetsClient();

    // Find test entries and duplicate-appended rows to delete from DB
    const testEntries = db.prepare("SELECT id, sheet_row FROM assessments WHERE tutor_name LIKE 'TEST_%' OR tutor_name LIKE 'test%' OR (tutor_name LIKE '%DEBUG%' AND tutor_name NOT IN ('TEST_DEBUG','TEST_DEBUG2'))").all();
    const garbageRows = new Set();

    for (const t of testEntries) {
      if (t.sheet_row) garbageRows.add(t.sheet_row);
      db.prepare('DELETE FROM assessments WHERE id = ?').run(t.id);
    }
    console.log(`Deleted ${testEntries.length} test entries from DB`);

    // Find duplicate combos where multiple assessments share same tutor/student/slot
    // but have DIFFERENT sheet_rows (the later ones are garbage from recoverUnlinked)
    const allAssessments = db.prepare("SELECT id, tutor_name, student_name, slot, sheet_row FROM assessments WHERE sheet_row IS NOT NULL ORDER BY id ASC").all();
    const comboGroups = {};
    for (const a of allAssessments) {
      const key = `${a.tutor_name}|${a.student_name}|${a.slot}`.toLowerCase();
      if (!comboGroups[key]) comboGroups[key] = [];
      comboGroups[key].push(a);
    }
    let unlinkedDuplicates = 0;
    for (const [key, items] of Object.entries(comboGroups)) {
      if (items.length <= 1) continue;
      // Keep the first (earliest id) entry, unlink the rest
      const keepRow = items[0].sheet_row;
      for (let i = 1; i < items.length; i++) {
        const a = items[i];
        if (a.sheet_row && a.sheet_row !== keepRow) {
          garbageRows.add(a.sheet_row);
          db.prepare('UPDATE assessments SET sheet_row = NULL WHERE id = ?').run(a.id);
          unlinkedDuplicates++;
        } else if (a.sheet_row === keepRow) {
          // Same row — keep one, delete extras
          db.prepare('DELETE FROM assessments WHERE id = ?').run(a.id);
          unlinkedDuplicates++;
        }
      }
    }
    console.log(`Unlinked ${unlinkedDuplicates} duplicate assessments, keeping earliest`);

    // Clear content from garbage Trial rows (batch update)
    const clearBatch = [];
    for (const row of garbageRows) {
      clearBatch.push({ range: `'Trial 2.0'!A${row}:R${row}`, values: [[...Array(18).fill('')]] });
    }
    // Also clear rows 1757-1763 (known test rows)
    for (let row = 1757; row <= 1763; row++) {
      if (!garbageRows.has(row)) {
        clearBatch.push({ range: `'Trial 2.0'!A${row}:R${row}`, values: [[...Array(18).fill('')]] });
      }
    }

    if (clearBatch.length > 0) {
      const BATCH = 50;
      for (let i = 0; i < clearBatch.length; i += BATCH) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { valueInputOption: 'USER_ENTERED', data: clearBatch.slice(i, i + BATCH) },
        });
        if (i + BATCH < clearBatch.length) await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Clear sheet_statuses for garbage rows
    for (const row of garbageRows) {
      db.prepare('DELETE FROM sheet_statuses WHERE row_number = ?').run(row);
    }

    // Re-sync
    await syncSheet();

    const remainingAssessments = db.prepare('SELECT COUNT(*) as cnt FROM assessments').get().cnt;
    const linked = db.prepare("SELECT COUNT(*) as cnt FROM assessments WHERE sheet_row IS NOT NULL").get().cnt;
    const unlinked = db.prepare("SELECT COUNT(*) as cnt FROM assessments WHERE sheet_row IS NULL AND tutor_name != '' AND student_name != '' AND slot != ''").get().cnt;
    res.json({
      success: true,
      deletedTestEntries: testEntries.length,
      unlinkedDuplicates,
      clearedGarbageRows: clearBatch.length,
      remainingAssessments,
      linked,
      unlinked,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sync-health', requireAuth, (req, res) => {
  const totalAssessments = db.prepare('SELECT COUNT(*) as cnt FROM assessments').get().cnt;
  const linked = db.prepare("SELECT COUNT(*) as cnt FROM assessments WHERE sheet_row IS NOT NULL").get().cnt;
  const unlinked = db.prepare("SELECT COUNT(*) as cnt FROM assessments WHERE sheet_row IS NULL AND tutor_name != '' AND student_name != '' AND slot != ''").get().cnt;
  const demoDone = db.prepare("SELECT COUNT(*) as cnt FROM assessments WHERE sheet_row IS NOT NULL").get().cnt;
  res.json({
    totalAssessments,
    linkedToSheet: linked,
    unlinked,
    sheetCacheSize: sheetDataCache.length,
    lastSync,
    demoDoneInSheet: demoDone,
  });
});

// Production startup is read-only for the existing database. Maintenance and
// destructive recovery operations are available only through authenticated
// admin endpoints and are never run automatically.
syncSheet();
setTimeout(syncSheet, 5000);
setTimeout(syncSheet, 15000);
const SYNC_INTERVAL = 30000;
setInterval(syncSheet, SYNC_INTERVAL);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
