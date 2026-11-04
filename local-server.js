const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const PRIVATE_SEED_FILE = path.join(DATA_DIR, 'seed-private.json');
const SEED_FILE = fs.existsSync(PRIVATE_SEED_FILE) ? PRIVATE_SEED_FILE : path.join(ROOT, 'seed.json');
const PORT = Number(process.env.PORT) || 3000;
const TEACHER_CODE_ENV = process.env.TEACHER_CODE || '';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const studentIds = new Set(seed.students.map(s => s.id));
const lessonIds = new Set(seed.lessons.map(l => l.id));
const missionCodes = new Set(seed.missions.map(m => m.code));

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Persistent state                                                    */
/* ------------------------------------------------------------------ */

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

let reports = (() => {
  const parsed = loadJson(REPORTS_FILE, {});
  return parsed && parsed.reports ? parsed.reports : {};
})();

let auth = (() => {
  const parsed = loadJson(AUTH_FILE, {});
  return {
    version: Number(parsed.version) || 1,
    teacherCode: typeof parsed.teacherCode === 'string' ? parsed.teacherCode : '',
    studentCodes: parsed.studentCodes && typeof parsed.studentCodes === 'object' ? parsed.studentCodes : {},
    createdAt: parsed.createdAt || new Date().toISOString()
  };
})();

let writeTimer = null;
let authWriteTimer = null;
let writing = false;

function persistReports() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (writing) {
      persistReports();
      return;
    }
    writing = true;
    const tmp = `${REPORTS_FILE}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), reports }, null, 2), 'utf8');
      fs.renameSync(tmp, REPORTS_FILE);
    } catch (err) {
      console.error('[reports] save failed:', err.message);
    } finally {
      writing = false;
    }
  }, 120);
}

function saveAuthNow() {
  const tmp = `${AUTH_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8');
  fs.renameSync(tmp, AUTH_FILE);
}

function persistAuth() {
  if (authWriteTimer) return;
  authWriteTimer = setTimeout(() => {
    authWriteTimer = null;
    try {
      saveAuthNow();
    } catch (err) {
      console.error('[auth] save failed:', err.message);
    }
  }, 120);
}

/* ------------------------------------------------------------------ */
/* Entry codes                                                         */
/* ------------------------------------------------------------------ */

function normalizeTeacherCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomTeacherCode() {
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function currentTeacherCode() {
  return TEACHER_CODE_ENV ? normalizeTeacherCode(TEACHER_CODE_ENV) : normalizeTeacherCode(auth.teacherCode);
}

function formatTeacherCode(code) {
  const normalized = normalizeTeacherCode(code);
  if (normalized.length === 8) return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
  return normalized;
}

function initializeAuth() {
  let changed = false;
  if (!TEACHER_CODE_ENV && !normalizeTeacherCode(auth.teacherCode)) {
    auth.teacherCode = randomTeacherCode();
    changed = true;
  }
  if (auth.version < 2) {
    for (const student of seed.students) {
      auth.studentCodes[student.id] = '0000';
    }
    auth.version = 2;
    changed = true;
  } else {
    for (const student of seed.students) {
      if (!auth.studentCodes[student.id]) {
        auth.studentCodes[student.id] = '0000';
        changed = true;
      }
    }
  }
  if (changed) saveAuthNow();
}

initializeAuth();

/* ------------------------------------------------------------------ */
/* Sessions and rate limiting                                          */
/* ------------------------------------------------------------------ */

const sessions = new Map();
const loginAttempts = new Map();

function createSession(role, studentId = null, mustChange = false) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    role,
    studentId,
    mustChange,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL,
    lastSeen: Date.now()
  });
  return token;
}

function sessionFromRequest(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.lastSeen = Date.now();
  return { token, ...session };
}

function clientAddress(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function allowLoginAttempt(req) {
  const now = Date.now();
  const key = clientAddress(req);
  const entry = loginAttempts.get(key) || { times: [] };
  entry.times = entry.times.filter(time => now - time < 5 * 60 * 1000);
  if (entry.times.length >= 30) {
    loginAttempts.set(key, entry);
    return false;
  }
  entry.times.push(now);
  loginAttempts.set(key, entry);
  return true;
}

function clearLoginAttempts(req) {
  loginAttempts.delete(clientAddress(req));
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
  for (const [key, entry] of loginAttempts) {
    entry.times = entry.times.filter(time => now - time < 5 * 60 * 1000);
    if (!entry.times.length) loginAttempts.delete(key);
  }
}, 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Data helpers                                                        */
/* ------------------------------------------------------------------ */

function flagsFor(studentId, lessonId) {
  const base = (seed.baseline[studentId] || {})[lessonId] || {};
  const report = reports[`${studentId}__${lessonId}`];
  return report ? { ...base, ...report.missions } : { ...base };
}

function levelFromFlags(flags) {
  let level = 0;
  if (flags.VC) level = 1;
  if (flags.ST) level = Math.max(level, 2);
  if (flags.RP) level = Math.max(level, 3);
  if (flags['RP+']) level = Math.max(level, 4);
  if (flags.WT || flags.PT || flags.V || flags.SP || flags.TM) level = 5;
  return level;
}

function missionCount(flags) {
  return seed.missions.reduce((count, mission) => count + (flags[mission.code] ? 1 : 0), 0);
}

function reportsForStudent(studentId) {
  const result = {};
  for (const [key, report] of Object.entries(reports)) {
    if (report.studentId === studentId) result[key] = report;
  }
  return result;
}

function classStandings() {
  return seed.classes.map(cls => {
    const students = seed.students.filter(student => student.classId === cls.id);
    let total = 0;
    let possible = 0;
    let levelSum = 0;
    let diamond = 0;
    for (const student of students) {
      let maxLevel = 0;
      for (const lesson of seed.lessons) {
        const flags = flagsFor(student.id, lesson.id);
        total += missionCount(flags);
        possible += seed.missions.length;
        const level = levelFromFlags(flags);
        levelSum += level;
        maxLevel = Math.max(maxLevel, level);
      }
      if (maxLevel >= 5) diamond += 1;
    }
    return {
      id: cls.id,
      name: cls.name,
      count: students.length,
      progress: possible ? (total / possible) * 100 : 0,
      avgLevel: students.length ? levelSum / (students.length * seed.lessons.length) : 0,
      diamond,
      reported: Object.values(reports).filter(report => report.classId === cls.id).length
    };
  });
}

function studentSeed(studentId) {
  return {
    meta: seed.meta,
    tiers: seed.tiers,
    missions: seed.missions,
    lessons: seed.lessons,
    classes: seed.classes,
    students: seed.students.filter(student => student.id === studentId),
    baseline: { [studentId]: seed.baseline[studentId] || {} },
    studentId
  };
}

function codesPayload() {
  return {
    teacherCode: formatTeacherCode(currentTeacherCode()),
    generatedAt: auth.createdAt,
    students: seed.students.map(student => ({
      id: student.id,
      classId: student.classId,
      className: seed.classes.find(cls => cls.id === student.classId)?.name || `${student.classId}반`,
      no: student.no,
      name: student.name,
      code: auth.studentCodes[student.id] || '0000',
      mustChange: (auth.studentCodes[student.id] || '0000') === '0000'
    }))
  };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function requireRole(req, res, role, options = {}) {
  const session = sessionFromRequest(req);
  if (!session || session.role !== role) {
    sendJson(res, 401, { error: '로그인이 필요합니다.' });
    return null;
  }
  if (role === 'student' && session.mustChange && !options.allowMustChange) {
    sendJson(res, 403, { error: '먼저 개인 입장 코드를 변경해 주세요.', code: 'CODE_CHANGE_REQUIRED' });
    return null;
  }
  return session;
}

function sanitizeMissions(input) {
  const missions = {};
  if (!input || typeof input !== 'object') throw new Error('Missing missions');
  for (const [code, value] of Object.entries(input)) {
    if (!missionCodes.has(code)) continue;
    missions[code] = value ? 1 : 0;
  }
  return missions;
}

function saveStudentReport(session, input) {
  const lessonId = String(input.lessonId || '');
  if (!lessonIds.has(lessonId)) throw new Error('Unknown lesson');
  const student = seed.students.find(item => item.id === session.studentId);
  if (!student) throw new Error('Unknown student');
  const missions = sanitizeMissions(input.missions);
  const note = typeof input.note === 'string' ? input.note.slice(0, 200) : '';
  const key = `${student.id}__${lessonId}`;
  const record = {
    studentId: student.id,
    lessonId,
    missions,
    note,
    studentName: student.name,
    classId: student.classId,
    updatedAt: new Date().toISOString(),
    source: 'student'
  };
  reports[key] = record;
  persistReports();
  return record;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel || rel === '/') rel = 'index.html';
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (!path.extname(rel)) return serveStatic(req, res, '/index.html');
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60'
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      res.writeHead(500);
      res.end('Read error');
    });
    stream.pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/auth/bootstrap' && req.method === 'GET') {
      sendJson(res, 200, {
        meta: {
          title: seed.meta.title,
          subtitle: seed.meta.subtitle,
          school: seed.meta.school,
          studentCount: seed.meta.studentCount,
          classCount: seed.meta.classCount,
          lessonCount: seed.meta.lessonCount
        },
        classes: seed.classes,
        students: seed.students.map(student => ({
          id: student.id,
          classId: student.classId,
          no: student.no,
          name: student.name
        }))
      });
      return;
    }

    if (pathname === '/api/auth/student' && req.method === 'POST') {
      if (!allowLoginAttempt(req)) {
        sendJson(res, 429, { error: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
        return;
      }
      const body = await readBody(req);
      const studentId = String(body.studentId || '');
      const code = String(body.code || '').replace(/\D/g, '');
      const student = seed.students.find(item => item.id === studentId);
      if (!studentIds.has(studentId) || !student || auth.studentCodes[studentId] !== code) {
        sendJson(res, 401, { error: '입장 코드가 올바르지 않습니다.' });
        return;
      }
      clearLoginAttempts(req);
      const mustChange = auth.studentCodes[studentId] === '0000';
      const token = createSession('student', studentId, mustChange);
      sendJson(res, 200, {
        token,
        role: 'student',
        mustChangeCode: mustChange,
        student: { id: student.id, classId: student.classId, no: student.no, name: student.name }
      });
      return;
    }

    if (pathname === '/api/auth/teacher' && req.method === 'POST') {
      if (!allowLoginAttempt(req)) {
        sendJson(res, 429, { error: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
        return;
      }
      const body = await readBody(req);
      const code = normalizeTeacherCode(body.code);
      if (!code || code !== currentTeacherCode()) {
        sendJson(res, 401, { error: '교사 입장 코드가 올바르지 않습니다.' });
        return;
      }
      clearLoginAttempts(req);
      const token = createSession('teacher');
      sendJson(res, 200, { token, role: 'teacher' });
      return;
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const session = sessionFromRequest(req);
      if (session) sessions.delete(session.token);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const session = sessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: '로그인이 필요합니다.' });
        return;
      }
      const student = session.studentId ? seed.students.find(item => item.id === session.studentId) : null;
      sendJson(res, 200, {
        role: session.role,
        mustChange: Boolean(session.mustChange),
        student: student ? { id: student.id, classId: student.classId, no: student.no, name: student.name } : null
      });
      return;
    }

    if (pathname === '/api/student/code' && req.method === 'POST') {
      const session = requireRole(req, res, 'student', { allowMustChange: true });
      if (!session) return;
      const body = await readBody(req);
      const newCode = String(body.newCode || '').replace(/\D/g, '');
      if (!/^\d{4}$/.test(newCode) || newCode === '0000') {
        sendJson(res, 400, { error: '0000이 아닌 4자리 숫자를 입력해 주세요.' });
        return;
      }
      auth.studentCodes[session.studentId] = newCode;
      saveAuthNow();
      sessions.delete(session.token);
      const token = createSession('student', session.studentId, false);
      sendJson(res, 200, { ok: true, token, code: newCode });
      return;
    }

    if (pathname === '/api/student/state' && req.method === 'GET') {
      const session = requireRole(req, res, 'student');
      if (!session) return;
      sendJson(res, 200, {
        seed: studentSeed(session.studentId),
        reports: reportsForStudent(session.studentId),
        classStandings: classStandings(),
        serverTime: new Date().toISOString()
      });
      return;
    }

    if (pathname === '/api/student/report' && req.method === 'POST') {
      const session = requireRole(req, res, 'student');
      if (!session) return;
      const body = await readBody(req);
      const record = saveStudentReport(session, body);
      sendJson(res, 200, { ok: true, report: record });
      return;
    }

    if (pathname === '/api/teacher/state' && req.method === 'GET') {
      const session = requireRole(req, res, 'teacher');
      if (!session) return;
      sendJson(res, 200, {
        seed,
        reports,
        codes: codesPayload(),
        serverTime: new Date().toISOString()
      });
      return;
    }

    if (pathname === '/api/teacher/codes' && req.method === 'GET') {
      const session = requireRole(req, res, 'teacher');
      if (!session) return;
      sendJson(res, 200, codesPayload());
      return;
    }

    if (pathname === '/api/teacher/codes/regenerate' && req.method === 'POST') {
      const session = requireRole(req, res, 'teacher');
      if (!session) return;
      const body = await readBody(req);
      const studentId = String(body.studentId || '');
      if (!studentIds.has(studentId)) {
        sendJson(res, 400, { error: 'Unknown student' });
        return;
      }
      auth.studentCodes[studentId] = '0000';
      saveAuthNow();
      for (const [token, session] of sessions) {
        if (session.role === 'student' && session.studentId === studentId) sessions.delete(token);
      }
      sendJson(res, 200, { ok: true, studentId, code: '0000' });
      return;
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, reports: Object.keys(reports).length });
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Unknown API route' });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    sendJson(res, 400, { error: err.message || 'Bad request' });
  }
});

function getLanAddresses() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address);
    }
  }
  return result;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  LAON Level Up Challenge server is running');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of getLanAddresses()) {
    console.log(`  Network: http://${ip}:${PORT}`);
  }
  console.log('');
  console.log(`  Teacher entry code: ${formatTeacherCode(currentTeacherCode())}`);
  console.log('  Initial student code: 0000 (change on first login)');
  console.log('  Student entry codes: teacher dashboard > 입장 코드');
  console.log('');
});
