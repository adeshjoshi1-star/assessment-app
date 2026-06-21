const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');
const SQLiteStore = require('better-sqlite3-session-store')(session);

const app = express();
const db = new Database(path.join(__dirname, 'data.db'));


db.exec(`
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

try { db.exec('ALTER TABLE assessments ADD COLUMN sheet_row INTEGER DEFAULT NULL'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN code TEXT UNIQUE'); } catch (e) {}

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

function syncTutorsFromSheet() {
  const names = [...new Set(sheetDataCache.map(e => e.tutor_name).filter(Boolean))];
  const existing = new Set(db.prepare("SELECT name, code FROM users WHERE role = 'teacher'").all().map(r => r.name.trim().toLowerCase()));
  const existingCodes = new Set(db.prepare("SELECT code FROM users WHERE role = 'teacher' AND code IS NOT NULL").all().map(r => r.code));
  const dummyPass = bcrypt.hashSync('tutor123', 10);
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key || existing.has(key)) continue;
    const code = generateTutorCode(name, existingCodes);
    const email = key.replace(/[^a-z0-9]/g, '') + '@tutor.local';
    db.prepare('INSERT INTO users (name, email, password, role, code) VALUES (?, ?, ?, ?, ?)').run(name.trim(), email, dummyPass, 'teacher', code);
    existing.add(key);
    console.log(`Auto-created tutor from sheet: ${name.trim()} -> code ${code}`);
  }
}

const tutorsWithoutCode = db.prepare("SELECT id, name FROM users WHERE role = 'teacher' AND (code IS NULL OR code = '')").all();
const existingCodes = new Set(db.prepare("SELECT code FROM users WHERE role = 'teacher' AND code IS NOT NULL").all().map(r => r.code));
for (const t of tutorsWithoutCode) {
  const code = generateTutorCode(t.name, existingCodes);
  db.prepare('UPDATE users SET code = ? WHERE id = ?').run(code, t.id);
  console.log(`Generated code ${code} for tutor ${t.name}`);
}

const ADMIN_EMAIL = 'admin@ete.com';
const ADMIN_PASSWORD = 'chessislive';
const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL);
if (!existingAdmin) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)').run('Admin', ADMIN_EMAIL, hash, 'admin');
  console.log('Default admin seeded: admin@ete.com / chessislive');
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
if (existingTutorCount === 0) {
  const insert = db.prepare('INSERT INTO users (name, email, password, role, code) VALUES (?, ?, ?, ?, ?)');
  const dummyPass = bcrypt.hashSync('tutor123', 10);
  const allCodes = new Set();
  for (const name of INITIAL_TUTORS) {
    const code = generateTutorCode(name, allCodes);
    const email = name.toLowerCase().replace(/[^a-z0-9]/g, '') + '@tutor.local';
    insert.run(name, email, dummyPass, 'teacher', code);
  }
  console.log(`Seeded ${INITIAL_TUTORS.length} initial tutors with codes`);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore({
    client: db,
    expired: { clear: true, intervalMs: 900000 }
  }),
  secret: process.env.SESSION_SECRET || 'asmnt-secret-k3y-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
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

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, name: req.session.name, role: req.session.role });
});

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

app.get('/api/admin/tutors', requireAuth, requireAdmin, (req, res) => {
  const tutors = db.prepare("SELECT id, name, code, role, created_at FROM users WHERE role = 'teacher' ORDER BY created_at DESC").all();
  res.json(tutors);
});

app.post('/api/admin/tutors', requireAuth, requireAdmin, (req, res) => {
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
    const dummyPass = bcrypt.hashSync('internal', 10);
    db.prepare('INSERT INTO users (name, email, password, role, code) VALUES (?, ?, ?, ?, ?)').run(name, dummyEmail, dummyPass, 'teacher', code);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/tutors/:id', requireAuth, requireAdmin, (req, res) => {
  const tutor = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!tutor) return res.status(404).json({ error: 'Tutor not found' });
  if (tutor.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin users' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

function requireTutor(req, res, next) {
  if (!req.session.userId || req.session.role !== 'teacher') {
    return res.status(401).json({ error: 'Tutor access required' });
  }
  next();
}

app.post('/api/tutor/login', (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });
    const tutor = db.prepare("SELECT id, name, role FROM users WHERE code = ? AND role = 'teacher'").get(code);
    if (!tutor) return res.status(401).json({ error: 'Invalid code' });
    req.session.userId = tutor.id;
    req.session.role = tutor.role;
    req.session.name = tutor.name;
    res.json({ success: true, name: tutor.name });
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
  res.json(tutors.map(t => t.name));
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

app.post('/api/assessments', (req, res) => {
  try {
    const { tutor_name, phone, slot, student_name, student_age, language, level, topics_known, topics_covered, start_topic, revision_topics, feedback, interest_level, additional_remarks, date, time, sheet_row } = req.body;
    if (!slot || !student_name || !student_age || !language || !level || !feedback || !interest_level) {
      return res.status(400).json({ error: 'Required fields missing' });
    }
    const stmt = db.prepare(`INSERT INTO assessments
      (user_id, tutor_name, phone, slot, student_name, student_age, language, level, topics_known, topics_covered, start_topic, revision_topics, feedback, interest_level, additional_remarks, date, time, sheet_row)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(
      req.session.userId, tutor_name || '', phone || '', slot, student_name, student_age, language, level,
      JSON.stringify(topics_known || []), JSON.stringify(topics_covered || []),
      start_topic || '', JSON.stringify(revision_topics || []),
      feedback, interest_level, additional_remarks || '', date || '', time || '',
      sheet_row || null
    );
    if (sheet_row) {
      updateSheetRow(sheet_row, 'Demo Done');
      db.prepare('INSERT INTO sheet_statuses (row_number, status) VALUES (?, ?) ON CONFLICT(row_number) DO UPDATE SET status = ?, updated_at = CURRENT_TIMESTAMP').run(sheet_row, 'Demo Done', 'Demo Done');
      const entry = sheetDataCache.find(e => e.row === parseInt(sheet_row));
      if (entry) entry.status = 'Demo Done';
    } else {
      appendToSheet({
        demo_status: 'Demo Done',
        slot, date, time, tutor_name, student_name,
        age: student_age, language, phone,
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/assessments', requireAuth, (req, res) => {
  const { tutor } = req.query;
  let list;
  if (tutor) {
    list = db.prepare("SELECT id, tutor_name, phone, slot, student_name, student_age, language, level, interest_level, status, date, time, created_at FROM assessments WHERE tutor_name = ? ORDER BY created_at DESC").all(tutor);
  } else {
    list = db.prepare("SELECT id, tutor_name, phone, slot, student_name, student_age, language, level, interest_level, status, date, time, created_at FROM assessments ORDER BY created_at DESC").all();
  }
  res.json(list);
});

app.get('/api/assessments/by-row/:row', (req, res) => {
  const a = db.prepare('SELECT * FROM assessments WHERE sheet_row = ? ORDER BY created_at DESC LIMIT 1').get(req.params.row);
  if (!a) return res.json(null);
  a.topics_known = JSON.parse(a.topics_known || '[]');
  a.topics_covered = JSON.parse(a.topics_covered || '[]');
  a.revision_topics = JSON.parse(a.revision_topics || '[]');
  res.json(a);
});

app.get('/api/assessments/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  a.topics_known = JSON.parse(a.topics_known || '[]');
  a.topics_covered = JSON.parse(a.topics_covered || '[]');
  a.revision_topics = JSON.parse(a.revision_topics || '[]');
  res.json(a);
});

app.delete('/api/assessments/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM assessments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM assessments WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.patch('/api/assessments/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const valid = ['New', 'Contacted', 'CNR and Messaged', 'Hot/Potential', 'CNR 1', 'CNR 2', 'CNR 3', 'Not Interested', 'Converted'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE assessments SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

app.get('/api/tutors', requireAuth, (req, res) => {
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
const fs = require('fs');
const SPREADSHEET_ID = '1nYvdZwZgqymw89waZXr1gyOVgPtmPN9CuAzQWx5y8Mg';

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
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Trial 2.0'!A${row}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[status]] },
    });
  } catch (err) {
    console.error('Sheet update error:', err.message);
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
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Trial 2.0'!A:R",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
  } catch (err) {
    console.error('Sheet append error:', err.message);
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
      if (i + 1 < 2904) continue;
      const statusRow = db.prepare('SELECT status FROM sheet_statuses WHERE row_number = ?').get(i + 1);
      entries.push({
        row: i + 1,
        demo_status: (r[0] || '').trim() || 'New',
        slot: (r[2] || '').trim(),
        date: (r[6] || '').trim(),
        time: (r[7] || '').trim(),
        tutor_name: (r[8] || '').trim(),
        student_name: (r[9] || '').trim(),
        age: (r[11] || '').trim(),
        language: (r[12] || '').trim(),
        agent_name: (r[13] || '').trim(),
        phone: (r[17] || '').trim(),
        status: statusRow ? statusRow.status : 'New',
      });
    }
    sheetDataCache = entries;
    lastSync = new Date().toISOString();
    console.log(`Sheet synced: ${entries.length} entries`);
    syncTutorsFromSheet();
  } catch (err) {
    console.error('Sheet sync error:', err.message);
  }
}

app.get('/api/sheet-tutors', (req, res) => {
  const tutors = [...new Set(sheetDataCache.map(e => e.tutor_name).filter(Boolean))].sort();
  res.json(tutors);
});

app.get('/api/sheet-tutor/:name', (req, res) => {
  const tutorName = decodeURIComponent(req.params.name).trim().toLowerCase();
  let entries = sheetDataCache.filter(e => e.tutor_name.toLowerCase() === tutorName);
  if (!entries.length) {
    const firstWord = tutorName.split(/\s+/)[0];
    if (firstWord.length > 0) {
      entries = sheetDataCache.filter(e => {
        const sn = e.tutor_name.toLowerCase();
        if (!sn) return false;
        return sn === firstWord || sn.startsWith(firstWord) || firstWord.startsWith(sn) || sn.includes(firstWord) || firstWord.includes(sn);
      });
    }
  }
  if (!entries.length) {
    const words = tutorName.split(/\s+/);
    entries = sheetDataCache.filter(e => {
      const sn = e.tutor_name.toLowerCase();
      if (!sn) return false;
      return words.some(w => w.length > 1 && sn.includes(w));
    });
  }
  res.json(entries);
});

app.get('/api/sheet-data', requireAuth, (req, res) => {
  let entries = sheetDataCache;
  if (req.query.tutor) {
    const t = req.query.tutor.toLowerCase();
    entries = entries.filter(e => e.tutor_name.toLowerCase() === t);
  }
  res.json({ entries, lastSync });
});

app.patch('/api/sheet-data/:row/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  const valid = ['New', 'Contacted', 'Demo Done', 'Demo Rescheduled', 'Demo Cancelled', 'Demo Not Done', 'Converted', 'Not Interested'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('INSERT INTO sheet_statuses (row_number, status) VALUES (?, ?) ON CONFLICT(row_number) DO UPDATE SET status = ?, updated_at = CURRENT_TIMESTAMP').run(req.params.row, status, status);
  const entry = sheetDataCache.find(e => e.row === parseInt(req.params.row));
  if (entry) entry.status = status;
  try {
    await updateSheetRow(req.params.row, status);
  } catch (e) {
    console.error('Failed to update sheet:', e.message);
  }
  res.json({ success: true });
});

app.post('/api/sync-sheet', requireAuth, async (req, res) => {
  await syncSheet();
  res.json({ success: true, count: sheetDataCache.length, lastSync });
});

syncSheet();
setTimeout(syncSheet, 5000);
setTimeout(syncSheet, 15000);
const SYNC_INTERVAL = 30000;
setInterval(syncSheet, SYNC_INTERVAL);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});


