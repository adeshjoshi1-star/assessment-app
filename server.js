const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');
const SQLiteStore = require('better-sqlite3-session-store')(session);

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

try { db.exec('ALTER TABLE assessments ADD COLUMN sheet_row INTEGER DEFAULT NULL'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN code TEXT UNIQUE'); } catch (e) {}
try { db.exec('ALTER TABLE sheet_statuses ADD COLUMN demo_status TEXT'); } catch (e) {}
try { db.exec("UPDATE sheet_statuses SET demo_status = 'Demo Done' WHERE row_number IN (SELECT sheet_row FROM assessments WHERE sheet_row IS NOT NULL) AND (demo_status IS NULL OR demo_status = '')"); } catch (e) {}

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

const TUTOR_NAME_ALIASES = {
  'sumith': 'Sumith',
  'sumit': 'Sumith',
  'sumith rajan': 'Sumith',
  'sumith ranjan': 'Sumith',
  'sumith raj': 'Sumith',
  'malavika': 'Malavika',
  'malavika r': 'Malavika',
  'yatin': 'Yatin',
  'yathin': 'Yatin',
  'yathin pradeep': 'Yatin',
  'yatin pradeep': 'Yatin',
  'abhishek': 'Abhishek',
  'abhishek tm': 'Abhishek',
  'ashitha': 'Ashitha KM',
  'ashitha km': 'Ashitha KM',
  'ashitaa': 'Ashitha KM',
  'ashitaa k m': 'Ashitha KM',
};

function normalizeTutorName(raw) {
  const key = (raw || '').trim().toLowerCase();
  if (!key || key.length < 3) return null;
  if (key === 'su') return null;
  const stripped = key.replace(/[^a-z0-9 ]/g, '');
  return TUTOR_NAME_ALIASES[key] || TUTOR_NAME_ALIASES[stripped] || raw.trim();
}

function syncTutorsFromSheet() {
  const names = [...new Set(sheetDataCache.map(e => e.tutor_name).filter(Boolean))];
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
  const dummyPass = bcrypt.hashSync('tutor123', 10);
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
  const seen = new Set();
  const deduped = [];
  for (const t of tutors) {
    const canon = TUTOR_NAME_ALIASES[t.name.trim().toLowerCase()] || t.name.trim();
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

app.post('/api/assessments', async (req, res) => {
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
      db.prepare("INSERT INTO sheet_statuses (row_number, status, demo_status) VALUES (?, ?, ?) ON CONFLICT(row_number) DO UPDATE SET status = ?, demo_status = ?, updated_at = CURRENT_TIMESTAMP").run(sheet_row, 'Demo Done', 'Demo Done', 'Demo Done', 'Demo Done');
      const entry = sheetDataCache.find(e => e.row === parseInt(sheet_row));
      if (entry) { entry.status = 'Demo Done'; entry.demo_status = 'Demo Done'; }
    } else {
      const newRow = await appendToSheet({
        demo_status: 'Demo Done',
        slot, date, time, tutor_name, student_name,
        age: student_age, language, phone,
      });
      if (newRow) {
        sheet_row = newRow;
        db.prepare('UPDATE assessments SET sheet_row = ? WHERE id = ?').run(newRow, result.lastInsertRowid);
        db.prepare("INSERT INTO sheet_statuses (row_number, status, demo_status) VALUES (?, ?, ?) ON CONFLICT(row_number) DO UPDATE SET status = ?, demo_status = ?, updated_at = CURRENT_TIMESTAMP").run(newRow, 'Demo Done', 'Demo Done', 'Demo Done', 'Demo Done');
      }
    }
    appendAssessmentToSheet({
      tutor_name, phone, slot, student_name,
      student_age, language, level,
      topics_known, topics_covered, start_topic,
      revision_topics, feedback, interest_level,
      additional_remarks, date, time, sheet_row: sheet_row,
    });
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
  const row = parseInt(req.params.row);
  const a = db.prepare('SELECT * FROM assessments WHERE sheet_row = ? ORDER BY created_at DESC LIMIT 1').get(row);
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

app.delete('/api/assessments/by-row/:row', async (req, res) => {
  try {
    const row = parseInt(req.params.row);
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
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Trial 2.0'!A:R",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
    const range = res.data?.updates?.updatedRange || '';
    const m = range.match(/R(\d+)$/);
    return m ? parseInt(m[1]) : null;
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
      if (i + 1 < 2904) continue;
      const rawName = (r[8] || '').trim();
      const normalized = normalizeTutorName(rawName);
      if (!normalized) continue;
      const ss = db.prepare('SELECT status, demo_status FROM sheet_statuses WHERE row_number = ?').get(i + 1);
      const sheetDemo = (r[0] || '').trim() || 'New';
      const storedDemo = ss ? ss.demo_status : null;
      let useDemo;
      if (storedDemo) {
        useDemo = storedDemo;
      } else if (sheetDemo === 'Demo Not Done') {
        useDemo = 'New';
      } else if (sheetDemo === 'Demo Done') {
        useDemo = 'Assessment Pending';
      } else {
        useDemo = sheetDemo;
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
    sheetDataCache = entries;
    lastSync = new Date().toISOString();
    console.log(`Sheet synced: ${entries.length} entries`);
    syncTutorsFromSheet();
    backfillAssessments();
  } catch (err) {
    console.error('Sheet sync error:', err.message);
  }
}

function backfillAssessments() {
  const assessments = db.prepare('SELECT * FROM assessments WHERE sheet_row IS NOT NULL').all();
  let cleared = 0;
  for (const a of assessments) {
    const entry = sheetDataCache.find(e => e.row === a.sheet_row);
    if (!entry) {
      db.prepare('UPDATE assessments SET sheet_row = NULL WHERE id = ?').run(a.id);
      cleared++;
    } else if (
      entry.tutor_name && a.tutor_name &&
      entry.tutor_name.toLowerCase() === a.tutor_name.toLowerCase() &&
      entry.student_name && a.student_name &&
      entry.student_name.toLowerCase() === a.student_name.toLowerCase() &&
      entry.slot && a.slot && entry.slot === a.slot &&
      entry.date && a.date && entry.date === a.date &&
      entry.time && a.time && entry.time === a.time
    ) {
      // valid match, keep it
    } else {
      db.prepare('UPDATE assessments SET sheet_row = NULL WHERE id = ?').run(a.id);
      cleared++;
    }
  }
  if (cleared > 0) console.log(`Cleared ${cleared} incorrect sheet_row values`);
  const unlinked = db.prepare('SELECT * FROM assessments WHERE sheet_row IS NULL').all();
  let linked = 0;
  for (const a of unlinked) {
    const entry = sheetDataCache.find(e => {
      if (!e.tutor_name || !a.tutor_name) return false;
      if (e.tutor_name.toLowerCase() !== a.tutor_name.toLowerCase()) return false;
      if (!e.student_name || !a.student_name) return false;
      if (e.student_name.toLowerCase() !== a.student_name.toLowerCase()) return false;
      if (!e.slot || !a.slot) return false;
      if (e.slot !== a.slot) return false;
      if (!e.date || !a.date) return false;
      if (e.date !== a.date) return false;
      if (!e.time || !a.time) return false;
      if (e.time !== a.time) return false;
      return true;
    });
    if (entry && !db.prepare('SELECT id FROM assessments WHERE sheet_row = ? AND id != ?').get(entry.row, a.id)) {
      db.prepare('UPDATE assessments SET sheet_row = ? WHERE id = ?').run(entry.row, a.id);
      linked++;
    }
  }
  if (linked > 0) console.log(`Linked ${linked} assessments by all-field match`);
}

app.get('/api/sheet-tutors', (req, res) => {
  const tutors = [...new Set(sheetDataCache.map(e => e.tutor_name).filter(Boolean))].sort();
  res.json(tutors);
});

app.get('/api/sheet-tutor/:name', (req, res) => {
  const tutorName = (normalizeTutorName(decodeURIComponent(req.params.name)) || '').toLowerCase();
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
  res.json(entries.sort((a, b) => b.row - a.row));
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
  const rate = demoDone > 0 ? Math.round((converted / demoDone) * 100) : 0;
  res.json({ demoDone, converted, rate });
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

app.get('/api/sheet-data', requireAuth, (req, res) => {
  let entries = sheetDataCache;
  if (req.query.tutor) {
    const t = req.query.tutor.toLowerCase();
    entries = entries.filter(e => e.tutor_name.toLowerCase() === t);
  }
  res.json({ entries, lastSync });
});

app.patch('/api/sheet-data/:row/demo-not-done', async (req, res) => {
  const row = parseInt(req.params.row);
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

app.patch('/api/sheet-data/:row/status', requireAuth, async (req, res) => {
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

app.post('/api/sync-sheet', requireAuth, async (req, res) => {
  await syncSheet();
  res.json({ success: true, count: sheetDataCache.length, lastSync });
});

syncSheet();
initAssessmentSheet();
syncTutorCodesToSheet();
setTimeout(syncSheet, 5000);
setTimeout(syncSheet, 15000);
setTimeout(syncTutorCodesToSheet, 10000);
const SYNC_INTERVAL = 30000;
setInterval(syncSheet, SYNC_INTERVAL);
setInterval(syncTutorCodesToSheet, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});


