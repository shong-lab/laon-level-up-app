'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const seed = require('../seed.json');

const lessonIds = new Set(seed.lessons.map(lesson => lesson.id));
const missionCodes = new Set(seed.missions.map(mission => mission.code));

const TOKEN_SECRET = process.env.LAON_TOKEN_SECRET || 'laon-public-demo-token-secret-2026';
const TEACHER_CODE = normalizeTeacherCode(process.env.TEACHER_CODE || 'DEMO2026');
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE_STORE = process.env.LAON_STORE_URL || 'https://mantledb.sh/v2/laon-level-up-7f3a91c2';
const TMP_REPORTS = path.join(os.tmpdir(), 'laon-reports.json');
const TMP_OVERRIDES = path.join(os.tmpdir(), 'laon-code-overrides.json');
const TMP_ROSTER = path.join(os.tmpdir(), 'laon-roster.json');
const MEMORY = globalThis.__LAON_VERCEL_MEMORY__ || (globalThis.__LAON_VERCEL_MEMORY__ = {
  reports: null,
  overrides: null,
  roster: null,
  attempts: new Map()
});

function normalizeTeacherCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatTeacherCode(code) {
  const normalized = normalizeTeacherCode(code);
  if (normalized.length === 8) return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
  return normalized;
}

function safeParse(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallback;
  }
}

function loadTmp(file, fallback) {
  try {
    return safeParse(fs.readFileSync(file, 'utf8'), fallback);
  } catch (error) {
    return fallback;
  }
}

function saveTmp(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch (error) {
    /* ephemeral filesystem may be unavailable */
  }
}

function normalizeRoster(input) {
  const roster = input && typeof input === 'object' ? input : {};
  return {
    version: Number(roster.version) || 1,
    names: roster.names && typeof roster.names === 'object' ? roster.names : {},
    added: Array.isArray(roster.added) ? roster.added : [],
    removed: Array.isArray(roster.removed) ? roster.removed : [],
    updatedAt: roster.updatedAt || null
  };
}

function ensureRoster(store) {
  store.roster = normalizeRoster(store.roster);
  return store.roster;
}

function rosterStudents(store) {
  const roster = normalizeRoster(store.roster);
  const removed = new Set(roster.removed);
  const students = seed.students
    .filter(student => !removed.has(student.id))
    .map(student => {
      const override = roster.names[student.id];
      return {
        id: student.id,
        classId: student.classId,
        no: student.no,
        name: typeof override === 'string' && override.trim() ? override : student.name,
        added: false
      };
    });
  for (const student of roster.added) {
    if (!student || !student.id || removed.has(student.id)) continue;
    const classId = Number(student.classId);
    if (!seed.classes.some(cls => cls.id === classId)) continue;
    students.push({
      id: String(student.id),
      classId,
      no: Number(student.no) || 0,
      name: String(student.name || ''),
      added: true
    });
  }
  return students.sort((a, b) => a.classId - b.classId || a.no - b.no || a.name.localeCompare(b.name, 'ko'));
}

function classesWithCounts(store) {
  const students = rosterStudents(store);
  return seed.classes.map(cls => ({
    ...cls,
    studentCount: students.filter(student => student.classId === cls.id).length
  }));
}

function rosterSeed(store) {
  const students = rosterStudents(store);
  return {
    ...seed,
    meta: { ...seed.meta, studentCount: students.length, classCount: seed.classes.length },
    classes: classesWithCounts(store),
    students
  };
}

function activeStudent(store, studentId) {
  return rosterStudents(store).find(student => student.id === studentId) || null;
}

function cleanStudentName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 30);
}

function nextStudentNumber(students, classId) {
  const used = new Set(students.filter(student => student.classId === classId).map(student => student.no));
  let no = 1;
  while (used.has(no)) no += 1;
  return no;
}

function newStudentId(students) {
  const used = new Set([...seed.students.map(student => student.id), ...students.map(student => student.id)]);
  let id = '';
  do {
    id = `add-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  } while (used.has(id));
  return id;
}

function applyStudentAction(store, body) {
  ensureRoster(store);
  const roster = store.roster;
  const students = rosterStudents(store);
  const action = String(body.action || '');

  if (action === 'add') {
    const classId = Number(body.classId);
    if (!seed.classes.some(cls => cls.id === classId)) throw new Error('학급을 선택해 주세요.');
    const name = cleanStudentName(body.name);
    if (!name) throw new Error('학생 이름을 입력해 주세요.');
    let no = Number(body.no);
    if (!Number.isFinite(no) || no < 1) no = nextStudentNumber(students, classId);
    no = Math.floor(no);
    if (students.some(student => student.classId === classId && student.no === no)) {
      throw new Error('같은 반에 같은 번호의 학생이 이미 있습니다.');
    }
    const student = {
      id: newStudentId(students),
      classId,
      no,
      name,
      addedAt: new Date().toISOString()
    };
    roster.added.push(student);
    roster.updatedAt = new Date().toISOString();
    return { action, student: { ...student, added: true } };
  }

  if (action === 'rename') {
    const studentId = String(body.studentId || '');
    const student = students.find(item => item.id === studentId);
    if (!student) throw new Error('학생을 찾을 수 없습니다.');
    const name = cleanStudentName(body.name);
    if (!name) throw new Error('학생 이름을 입력해 주세요.');
    const added = roster.added.find(item => item.id === studentId);
    if (added) added.name = name;
    else roster.names[studentId] = name;
    for (const report of Object.values(store.reports)) {
      if (report.studentId === studentId) report.studentName = name;
    }
    roster.updatedAt = new Date().toISOString();
    return { action, student: { ...student, name } };
  }

  if (action === 'delete') {
    const studentId = String(body.studentId || '');
    const student = students.find(item => item.id === studentId);
    if (!student) throw new Error('학생을 찾을 수 없습니다.');
    const addedIndex = roster.added.findIndex(item => item.id === studentId);
    if (addedIndex >= 0) roster.added.splice(addedIndex, 1);
    else if (!roster.removed.includes(studentId)) roster.removed.push(studentId);
    delete roster.names[studentId];
    delete store.overrides[studentId];
    for (const [key, report] of Object.entries(store.reports)) {
      if (report.studentId === studentId) delete store.reports[key];
    }
    roster.updatedAt = new Date().toISOString();
    return { action, student };
  }

  throw new Error('Unknown action');
}

async function kvCommand(command) {
  const response = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error('KV request failed');
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload.result;
}

async function remoteGet(entryPath) {
  const response = await fetch(`${REMOTE_STORE}/${entryPath}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Remote store read failed (${response.status})`);
  return await response.json();
}

async function remoteSet(entryPath, value) {
  const response = await fetch(`${REMOTE_STORE}/${entryPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`Remote store write failed (${response.status})`);
}

function splitReportsByLesson(reports) {
  const byLesson = {};
  for (const lesson of seed.lessons) byLesson[lesson.id] = {};
  for (const [key, report] of Object.entries(reports)) {
    const target = byLesson[report.lessonId];
    if (target) target[key] = report;
  }
  return byLesson;
}

async function getStore() {
  if (KV_URL && KV_TOKEN) {
    const [reportsRaw, overridesRaw, rosterRaw] = await Promise.all([
      kvCommand(['GET', 'laon:reports']),
      kvCommand(['GET', 'laon:code-overrides']),
      kvCommand(['GET', 'laon:roster'])
    ]);
    return {
      reports: safeParse(reportsRaw, {}),
      overrides: safeParse(overridesRaw, {}),
      roster: normalizeRoster(safeParse(rosterRaw, null)),
      source: 'kv'
    };
  }

  try {
    const state = await remoteGet('state');
    if (state && !state.split) {
      return {
        reports: state.reports && typeof state.reports === 'object' ? state.reports : {},
        overrides: state.overrides && typeof state.overrides === 'object' ? state.overrides : {},
        roster: normalizeRoster(state.roster),
        source: 'remote'
      };
    }
    const lessonEntries = await Promise.all(seed.lessons.map(lesson => remoteGet(`reports-${lesson.id}`)));
    const reports = {};
    for (const entry of lessonEntries) {
      if (entry && typeof entry === 'object') Object.assign(reports, entry);
    }
    return {
      reports,
      overrides: state && state.overrides && typeof state.overrides === 'object' ? state.overrides : {},
      roster: normalizeRoster(state && state.roster),
      source: 'remote-split'
    };
  } catch (error) {
    /* fall back to the ephemeral store if the shared store is unavailable */
  }

  if (!MEMORY.reports) MEMORY.reports = loadTmp(TMP_REPORTS, {});
  if (!MEMORY.overrides) MEMORY.overrides = loadTmp(TMP_OVERRIDES, {});
  if (!MEMORY.roster) MEMORY.roster = normalizeRoster(loadTmp(TMP_ROSTER, null));
  return {
    reports: MEMORY.reports,
    overrides: MEMORY.overrides,
    roster: MEMORY.roster,
    source: 'memory'
  };
}

async function saveStore(store) {
  if (KV_URL && KV_TOKEN) {
    await Promise.all([
      kvCommand(['SET', 'laon:reports', JSON.stringify(store.reports)]),
      kvCommand(['SET', 'laon:code-overrides', JSON.stringify(store.overrides)]),
      kvCommand(['SET', 'laon:roster', JSON.stringify(store.roster)])
    ]);
    return;
  }

  try {
    const payload = {
      reports: store.reports,
      overrides: store.overrides,
      roster: store.roster,
      updatedAt: new Date().toISOString()
    };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 60000) {
      await remoteSet('state', payload);
      return;
    }
    await remoteSet('state', {
      split: true,
      overrides: store.overrides,
      roster: store.roster,
      updatedAt: new Date().toISOString()
    });
    const byLesson = splitReportsByLesson(store.reports);
    await Promise.all(seed.lessons.map(lesson => remoteSet(`reports-${lesson.id}`, byLesson[lesson.id])));
    return;
  } catch (error) {
    /* keep the request working even if the shared store is temporarily down */
  }

  MEMORY.reports = store.reports;
  MEMORY.overrides = store.overrides;
  MEMORY.roster = store.roster;
  saveTmp(TMP_REPORTS, store.reports);
  saveTmp(TMP_OVERRIDES, store.overrides);
  saveTmp(TMP_ROSTER, store.roster);
}

function studentCodeFor(studentId, overrides = {}) {
  return overrides[studentId] || '0000';
}

function flagsFor(studentId, lessonId, reports) {
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

function reportsForStudent(studentId, reports) {
  const result = {};
  for (const [key, report] of Object.entries(reports)) {
    if (report.studentId === studentId) result[key] = report;
  }
  return result;
}

function classStandings(reports, store) {
  return seed.classes.map(cls => {
    const students = rosterStudents(store).filter(student => student.classId === cls.id);
    let total = 0;
    let possible = 0;
    let levelSum = 0;
    let diamond = 0;
    for (const student of students) {
      let maxLevel = 0;
      for (const lesson of seed.lessons) {
        const flags = flagsFor(student.id, lesson.id, reports);
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

function studentSeed(studentId, store) {
  const base = rosterSeed(store);
  return {
    meta: base.meta,
    tiers: base.tiers,
    missions: base.missions,
    lessons: base.lessons,
    classes: base.classes,
    students: base.students.filter(student => student.id === studentId),
    baseline: { [studentId]: seed.baseline[studentId] || {} },
    studentId
  };
}

function codesPayload(store) {
  return {
    teacherCode: formatTeacherCode(TEACHER_CODE),
    generatedAt: new Date().toISOString(),
    students: rosterStudents(store).map(student => ({
      id: student.id,
      classId: student.classId,
      className: seed.classes.find(cls => cls.id === student.classId)?.name || `${student.classId}반`,
      no: student.no,
      name: student.name,
      added: Boolean(student.added),
      code: studentCodeFor(student.id, store.overrides),
      mustChange: studentCodeFor(student.id, store.overrides) === '0000'
    }))
  };
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function createToken(role, studentId = null, mustChange = false) {
  const payload = {
    role,
    studentId,
    mustChange,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  };
  const body = encodeBase64Url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function sessionFromRequest(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? verifyToken(match[1].trim()) : null;
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

function clientAddress(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function allowLoginAttempt(req) {
  const now = Date.now();
  const key = clientAddress(req);
  const entry = MEMORY.attempts.get(key) || { times: [] };
  entry.times = entry.times.filter(time => now - time < 5 * 60 * 1000);
  if (entry.times.length >= 30) {
    MEMORY.attempts.set(key, entry);
    return false;
  }
  entry.times.push(now);
  MEMORY.attempts.set(key, entry);
  return true;
}

function clearLoginAttempts(req) {
  MEMORY.attempts.delete(clientAddress(req));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return safeParse(req.body, {});
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
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function sanitizeMissions(input) {
  if (!input || typeof input !== 'object') throw new Error('Missing missions');
  const missions = {};
  for (const [code, value] of Object.entries(input)) {
    if (!missionCodes.has(code)) continue;
    missions[code] = value ? 1 : 0;
  }
  return missions;
}

function saveStudentReport(session, input, reports, store) {
  const lessonId = String(input.lessonId || '');
  if (!lessonIds.has(lessonId)) throw new Error('Unknown lesson');
  const student = activeStudent(store, session.studentId);
  if (!student) throw new Error('Unknown student');
  const record = {
    studentId: student.id,
    lessonId,
    missions: sanitizeMissions(input.missions),
    note: typeof input.note === 'string' ? input.note.slice(0, 200) : '',
    studentName: student.name,
    classId: student.classId,
    updatedAt: new Date().toISOString(),
    source: 'student'
  };
  reports[`${student.id}__${lessonId}`] = record;
  return record;
}

async function handle(req, res, pathname) {
  try {
    const route = pathname.replace(/\/+$/, '') || '/';

    if (route === '/api/health' && req.method === 'GET') {
      const store = await getStore();
      sendJson(res, 200, {
        ok: true,
        reports: Object.keys(store.reports).length,
        storage: store.source,
        mode: 'vercel'
      });
      return;
    }

    if (route === '/api/auth/bootstrap' && req.method === 'GET') {
      const store = await getStore();
      const roster = rosterSeed(store);
      sendJson(res, 200, {
        meta: {
          title: roster.meta.title,
          subtitle: roster.meta.subtitle,
          school: roster.meta.school,
          studentCount: roster.meta.studentCount,
          classCount: roster.meta.classCount,
          lessonCount: roster.meta.lessonCount
        },
        classes: roster.classes,
        students: roster.students.map(student => ({
          id: student.id,
          classId: student.classId,
          no: student.no,
          name: student.name,
          added: Boolean(student.added)
        }))
      });
      return;
    }

    if (route === '/api/auth/student' && req.method === 'POST') {
      if (!allowLoginAttempt(req)) {
        sendJson(res, 429, { error: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
        return;
      }
      const body = await readJsonBody(req);
      const studentId = String(body.studentId || '');
      const code = String(body.code || '').replace(/\D/g, '');
      const store = await getStore();
      const student = activeStudent(store, studentId);
      const currentCode = studentCodeFor(studentId, store.overrides);
      if (!student || currentCode !== code) {
        sendJson(res, 401, { error: '입장 코드가 올바르지 않습니다.' });
        return;
      }
      clearLoginAttempts(req);
      const mustChange = currentCode === '0000';
      sendJson(res, 200, {
        token: createToken('student', studentId, mustChange),
        role: 'student',
        mustChangeCode: mustChange,
        student: { id: student.id, classId: student.classId, no: student.no, name: student.name }
      });
      return;
    }

    if (route === '/api/auth/teacher' && req.method === 'POST') {
      if (!allowLoginAttempt(req)) {
        sendJson(res, 429, { error: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
        return;
      }
      const body = await readJsonBody(req);
      const code = normalizeTeacherCode(body.code);
      if (!code || code !== TEACHER_CODE) {
        sendJson(res, 401, { error: '교사 입장 코드가 올바르지 않습니다.' });
        return;
      }
      clearLoginAttempts(req);
      sendJson(res, 200, { token: createToken('teacher'), role: 'teacher' });
      return;
    }

    if (route === '/api/auth/logout' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === '/api/me' && req.method === 'GET') {
      const session = sessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: '로그인이 필요합니다.' });
        return;
      }
      const store = await getStore();
      const student = session.studentId ? activeStudent(store, session.studentId) : null;
      if (session.role === 'student' && !student) {
        sendJson(res, 401, { error: '학생 계정을 찾을 수 없습니다.' });
        return;
      }
      sendJson(res, 200, {
        role: session.role,
        mustChange: Boolean(session.mustChange),
        student: student ? { id: student.id, classId: student.classId, no: student.no, name: student.name } : null
      });
      return;
    }

    if (route === '/api/student/code' && req.method === 'POST') {
      const session = requireRole(req, res, 'student', { allowMustChange: true });
      if (!session) return;
      const body = await readJsonBody(req);
      const newCode = String(body.newCode || '').replace(/\D/g, '');
      if (!/^\d{4}$/.test(newCode) || newCode === '0000') {
        sendJson(res, 400, { error: '0000이 아닌 4자리 숫자를 입력해 주세요.' });
        return;
      }
      const store = await getStore();
      if (!activeStudent(store, session.studentId)) {
        sendJson(res, 401, { error: '학생 계정을 찾을 수 없습니다.' });
        return;
      }
      store.overrides[session.studentId] = newCode;
      await saveStore(store);
      sendJson(res, 200, {
        ok: true,
        token: createToken('student', session.studentId, false),
        code: newCode
      });
      return;
    }

    if (route === '/api/student/state' && req.method === 'GET') {
      const session = requireRole(req, res, 'student');
      if (!session) return;
      const store = await getStore();
      if (!activeStudent(store, session.studentId)) {
        sendJson(res, 401, { error: '학생 계정을 찾을 수 없습니다.' });
        return;
      }
      sendJson(res, 200, {
        seed: studentSeed(session.studentId, store),
        reports: reportsForStudent(session.studentId, store.reports),
        classStandings: classStandings(store.reports, store),
        serverTime: new Date().toISOString()
      });
      return;
    }

    if (route === '/api/student/report' && req.method === 'POST') {
      const session = requireRole(req, res, 'student');
      if (!session) return;
      const body = await readJsonBody(req);
      const store = await getStore();
      if (!activeStudent(store, session.studentId)) {
        sendJson(res, 401, { error: '학생 계정을 찾을 수 없습니다.' });
        return;
      }
      const record = saveStudentReport(session, body, store.reports, store);
      await saveStore(store);
      sendJson(res, 200, { ok: true, report: record });
      return;
    }

    if (route === '/api/teacher/state' && req.method === 'GET') {
      const session = requireRole(req, res, 'teacher');
      if (!session) return;
      const store = await getStore();
      sendJson(res, 200, {
        seed: rosterSeed(store),
        reports: store.reports,
        codes: codesPayload(store),
        rosterUpdatedAt: store.roster.updatedAt,
        serverTime: new Date().toISOString()
      });
      return;
    }

    if (route === '/api/teacher/codes' && req.method === 'POST') {
      const session = requireRole(req, res, 'teacher');
      if (!session) return;
      const body = await readJsonBody(req);
      const store = await getStore();
      const result = applyStudentAction(store, body);
      await saveStore(store);
      sendJson(res, 200, {
        ok: true,
        action: result.action,
        student: result.student,
        students: rosterStudents(store),
        classes: classesWithCounts(store),
        rosterUpdatedAt: store.roster.updatedAt
      });
      return;
    }

    if (route === '/api/teacher/codes' && req.method === 'GET') {
      const session = requireRole(req, res, 'teacher');
      if (!session) return;
      const store = await getStore();
      sendJson(res, 200, codesPayload(store));
      return;
    }

    if (route === '/api/teacher/codes/regenerate' && req.method === 'POST') {
      const session = requireRole(req, res, 'teacher');
      if (!session) return;
      const body = await readJsonBody(req);
      const studentId = String(body.studentId || '');
      const store = await getStore();
      if (!activeStudent(store, studentId)) {
        sendJson(res, 400, { error: 'Unknown student' });
        return;
      }
      delete store.overrides[studentId];
      await saveStore(store);
      sendJson(res, 200, { ok: true, studentId, code: '0000' });
      return;
    }

    sendJson(res, 404, { error: 'Unknown API route' });
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Bad request' });
  }
}

module.exports = { handle, formatTeacherCode, TEACHER_CODE };
