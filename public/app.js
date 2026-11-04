'use strict';

const appEl = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');

const LS_STUDENT = 'laon.selectedStudent';
const LS_CLASS = 'laon.selectedClass';
const LS_LESSON = 'laon.selectedLesson';
const SS_TOKEN = 'laon.sessionToken';
const SS_ROLE = 'laon.sessionRole';
const SS_STUDENT = 'laon.sessionStudent';

const state = {
  seed: null,
  reports: {},
  serverTime: null,
  loadError: null,
  view: 'auth',
  selectedClass: 1,
  selectedStudentId: null,
  selectedLessonId: 'L7',
  teacherTab: 'overview',
  teacherClassFilter: 'all',
  teacherSearch: '',
  teacherSort: 'progress',
  classFocus: 1,
  classUnit: 'L7',
  unitFocus: 'L7',
  detailStudentId: null,
  saving: false,
  lastSync: null,
  reportFingerprint: '',
  classFingerprint: '',
  refreshing: false,
  loadingState: false,
  auth: { role: null, token: null, studentId: null },
  authStage: 'role',
  authClass: 1,
  authStudentId: null,
  authCode: '',
  authError: '',
  authBusy: false,
  bootstrap: null,
  classStandings: null,
  codes: null
};

let computeCache = null;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function avg(list) {
  if (!list.length) return 0;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function fmtPct(value, digits = 0) {
  return `${(Number(value) || 0).toFixed(digits)}%`;
}

function round(value) {
  return Math.round(Number(value) || 0);
}

function initial(name) {
  return esc(String(name || '?').slice(0, 1));
}

function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getMonth() + 1}.${date.getDate()} ${hh}:${mm}`;
}

function formatClock(date) {
  if (!date) return '';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0')).join(':');
}

function formatRelative(iso) {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  if (diff < 60000) return '방금 전';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
  return formatDateTime(iso);
}

function lessonById(id) {
  return state.seed.lessons.find(lesson => lesson.id === id) || state.seed.lessons[0];
}

function tierOf(level) {
  return state.seed.tiers.find(tier => tier.level === level) || null;
}

function missionOf(code) {
  return state.seed.missions.find(mission => mission.code === code) || null;
}

function studentById(id) {
  return state.seed.students.find(student => student.id === id) || null;
}

function classById(id) {
  return state.seed.classes.find(item => item.id === Number(id)) || null;
}

function studentsOfClass(classId) {
  return state.seed.students.filter(student => student.classId === Number(classId));
}

function reportKey(studentId, lessonId) {
  return `${studentId}__${lessonId}`;
}

function reportFor(studentId, lessonId) {
  return state.reports[reportKey(studentId, lessonId)] || null;
}

function flagsFor(studentId, lessonId) {
  const base = (state.seed.baseline[studentId] || {})[lessonId] || {};
  const report = reportFor(studentId, lessonId);
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
  return state.seed.missions.reduce((count, mission) => count + (flags[mission.code] ? 1 : 0), 0);
}

function gradeOf(level) {
  if (level >= 4) return { label: '매우잘함', cls: 'grade-4' };
  if (level === 3) return { label: '잘함', cls: 'grade-3' };
  if (level === 2) return { label: '보통', cls: 'grade-2' };
  if (level === 1) return { label: '노력요함', cls: 'grade-1' };
  return { label: '시작 전', cls: 'grade-0' };
}

function levelName(level) {
  const tier = tierOf(level);
  return tier ? tier.name : 'START';
}

function computeStudent(student) {
  const byLesson = {};
  let total = 0;
  let totalPossible = 0;
  let levelSum = 0;
  let maxLevel = 0;
  let reportedUnits = 0;
  let lastReport = null;

  for (const lesson of state.seed.lessons) {
    const flags = flagsFor(student.id, lesson.id);
    const level = levelFromFlags(flags);
    const count = missionCount(flags);
    const report = reportFor(student.id, lesson.id);
    byLesson[lesson.id] = {
      flags,
      level,
      count,
      pct: (count / state.seed.missions.length) * 100,
      reported: Boolean(report),
      reportAt: report ? report.updatedAt : null
    };
    total += count;
    totalPossible += state.seed.missions.length;
    levelSum += level;
    maxLevel = Math.max(maxLevel, level);
    if (report) {
      reportedUnits += 1;
      if (!lastReport || report.updatedAt > lastReport.updatedAt) lastReport = report;
    }
  }

  return {
    student,
    byLesson,
    totalMissions: total,
    progress: totalPossible ? (total / totalPossible) * 100 : 0,
    avgLevel: levelSum / state.seed.lessons.length,
    maxLevel,
    reportedUnits,
    lastReport
  };
}

function computeUnitStats(lessonId, classId = null) {
  const students = classId ? studentsOfClass(classId) : state.seed.students;
  const rows = students.map(student => {
    const flags = flagsFor(student.id, lessonId);
    const level = levelFromFlags(flags);
    const count = missionCount(flags);
    return {
      student,
      flags,
      level,
      count,
      pct: (count / state.seed.missions.length) * 100
    };
  });
  const n = rows.length || 1;
  const levelCounts = [0, 0, 0, 0, 0, 0];
  for (const row of rows) levelCounts[row.level] += 1;

  return {
    lessonId,
    classId,
    rows,
    count: rows.length,
    progress: avg(rows.map(row => row.pct)),
    avgLevel: avg(rows.map(row => row.level)),
    levelCounts,
    missionRates: state.seed.missions.map(mission => {
      const count = rows.filter(row => row.flags[mission.code]).length;
      return { ...mission, count, rate: (count / n) * 100 };
    }),
    diamond: rows.filter(row => row.level === 5).length,
    support: rows
      .filter(row => row.level <= 1)
      .sort((a, b) => a.count - b.count || a.student.name.localeCompare(b.student.name, 'ko'))
      .slice(0, 8),
    top: [...rows]
      .sort((a, b) => b.count - a.count || b.level - a.level || a.student.name.localeCompare(b.student.name, 'ko'))
      .slice(0, 6)
  };
}

function computed() {
  if (computeCache) return computeCache;
  const perStudent = {};
  for (const student of state.seed.students) {
    perStudent[student.id] = computeStudent(student);
  }
  const classes = state.seed.classes.map(item => {
    const students = studentsOfClass(item.id).map(student => perStudent[student.id]);
    const unitProgress = {};
    for (const lesson of state.seed.lessons) {
      unitProgress[lesson.id] = avg(students.map(student => student.byLesson[lesson.id].pct));
    }
    return {
      id: item.id,
      name: item.name,
      count: item.studentCount,
      progress: avg(students.map(student => student.progress)),
      avgLevel: avg(students.map(student => student.avgLevel)),
      diamond: students.filter(student => student.maxLevel >= 5).length,
      reported: students.reduce((sum, student) => sum + student.reportedUnits, 0),
      reportedStudents: students.filter(student => student.reportedUnits > 0).length,
      unitProgress
    };
  });
  const units = state.seed.lessons.map(lesson => {
    const stats = computeUnitStats(lesson.id, null);
    return {
      ...lesson,
      progress: stats.progress,
      avgLevel: stats.avgLevel,
      levelCounts: stats.levelCounts,
      diamond: stats.diamond
    };
  });
  computeCache = { perStudent, students: Object.values(perStudent), classes, units };
  return computeCache;
}

function invalidate() {
  computeCache = null;
}

function sortedClasses() {
  return [...computed().classes].sort((a, b) => b.progress - a.progress || a.id - b.id);
}

function summary() {
  const data = computed();
  const reportList = Object.values(state.reports);
  const tierCounts = [0, 0, 0, 0, 0, 0];
  for (const student of data.students) tierCounts[student.maxLevel] += 1;
  return {
    totalStudents: state.seed.students.length,
    avgProgress: avg(data.students.map(student => student.progress)),
    avgLevel: avg(data.students.map(student => student.avgLevel)),
    diamondStudents: data.students.filter(student => student.maxLevel >= 5).length,
    reportCount: reportList.length,
    participants: new Set(reportList.map(report => report.studentId)).size,
    tierCounts
  };
}

function pbar(pct, color = '') {
  const width = clamp(Number(pct) || 0, 0, 100);
  return `<div class="pbar"><i style="width:${width.toFixed(1)}%;${color ? `background:${color};` : ''}"></i></div>`;
}

function levelBadge(level, large = false) {
  if (!level) return `<span class="level-badge zero ${large ? 'lg' : ''}"><i></i>START</span>`;
  const tier = tierOf(level);
  if (!tier) return '';
  return `<span class="level-badge ${large ? 'lg' : ''}" style="--tier:${tier.color};--tier-soft:${tier.soft}"><i></i>${tier.name}</span>`;
}

function gradePill(level) {
  const grade = gradeOf(level);
  return `<span class="grade-pill ${grade.cls}">${grade.label}</span>`;
}

function unitMini(level, lesson) {
  if (!level) return `<span class="unit-mini" title="${esc(lesson.id)} START">·</span>`;
  const tier = tierOf(level);
  return `<span class="unit-mini has" style="background:${tier.color}" title="${esc(lesson.id)} ${tier.name}">${level}</span>`;
}

function heatStyle(pct) {
  const p = clamp(Number(pct) || 0, 0, 100);
  const alpha = 0.08 + (p / 100) * 0.56;
  return `background:rgba(79,110,247,${alpha.toFixed(2)});color:${p > 56 ? '#ffffff' : '#26314a'};`;
}

function brandMarkup() {
  return `
    <div class="brand" data-action="go-home" role="button" tabindex="0" style="cursor:pointer">
      <div class="brand-mark">LU</div>
      <div class="brand-text">
        <strong>LEVEL UP</strong>
        <span>LAON 영어 레벨업 챌린지</span>
      </div>
    </div>`;
}

function statusPill(done, doneLabel = '달성', todoLabel = '도전 가능') {
  return `<span class="status-pill ${done ? 'done' : 'todo'}">${done ? doneLabel : todoLabel}</span>`;
}

function raceChartHtml(items) {
  const sorted = [...items].sort((a, b) => b.progress - a.progress || a.id - b.id);
  return `
    <div class="race-chart">
      ${sorted.map((item, index) => {
        const fill = index === 0
          ? 'background:linear-gradient(90deg,#c79a16,#efc94c)'
          : index === 1
            ? 'background:linear-gradient(90deg,#8794a6,#b7c1cf)'
            : index === 2
              ? 'background:linear-gradient(90deg,#a96a44,#d49a6c)'
              : '';
        return `
          <div class="race-row">
            <div class="race-rank ${index < 3 ? 'top' : ''}">${index + 1}</div>
            <div class="race-name">${esc(item.name)}<span>${item.count}명 · 보고 ${item.reported}건</span></div>
            <div class="race-track"><div class="race-fill" style="width:${clamp(item.progress, 0, 100).toFixed(1)}%;${fill}"></div></div>
            <div class="race-value">${fmtPct(item.progress, 1)}</div>
            <div class="race-level">평균 ${item.avgLevel.toFixed(1)}L</div>
          </div>`;
      }).join('')}
    </div>`;
}

function stackedTierHtml(counts) {
  const total = counts.reduce((sum, count) => sum + count, 0) || 1;
  const segments = counts.map((count, level) => {
    const tier = tierOf(level);
    return `<span style="width:${(count / total) * 100}%;background:${tier ? tier.color : '#dfe4ee'}" title="${levelName(level)} ${count}명"></span>`;
  }).join('');
  const legend = counts.map((count, level) => {
    const tier = tierOf(level);
    return `
      <div class="item">
        <span class="swatch" style="background:${tier ? tier.color : '#dfe4ee'}"></span>
        <span>${levelName(level)}</span>
        <strong>${count}명</strong>
      </div>`;
  }).join('');
  return `<div class="stacked-bar">${segments}</div><div class="stacked-legend">${legend}</div>`;
}

function unitTrendSvg() {
  const data = computed().units;
  const width = 760;
  const height = 250;
  const pad = { left: 44, right: 22, top: 26, bottom: 38 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const n = data.length;
  const x = i => pad.left + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = value => pad.top + ((100 - value) / 100) * innerH;
  const points = data.map((unit, index) => ({ x: x(index), y: y(unit.progress), value: unit.progress, label: `L${unit.num}` }));
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const area = `${path} L${points[points.length - 1].x.toFixed(1)} ${(pad.top + innerH).toFixed(1)} L${points[0].x.toFixed(1)} ${(pad.top + innerH).toFixed(1)} Z`;
  const grid = [0, 25, 50, 75, 100].map(value => {
    const gy = y(value);
    return `<line x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${width - pad.right}" y2="${gy.toFixed(1)}" stroke="#e9edf5" stroke-width="1" />
      <text x="${pad.left - 10}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#8a93a7" font-weight="700">${value}%</text>`;
  }).join('');
  const labels = points.map(point => `
    <text x="${point.x.toFixed(1)}" y="${height - 14}" text-anchor="middle" font-size="10" fill="#69748e" font-weight="800">${point.label}</text>
    <text x="${point.x.toFixed(1)}" y="${(point.y - 11).toFixed(1)}" text-anchor="middle" font-size="10" fill="#3b53d3" font-weight="900">${point.value.toFixed(0)}%</text>`).join('');
  const dots = points.map(point => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="5" fill="#ffffff" stroke="#4f6ef7" stroke-width="3" />`).join('');
  return `
    <div class="line-chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="단원별 평균 미션 달성률 추이">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4f6ef7" stop-opacity="0.22" />
            <stop offset="100%" stop-color="#4f6ef7" stop-opacity="0" />
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#trendFill)" />
        <path d="${path}" fill="none" stroke="#4f6ef7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        ${dots}
        ${labels}
      </svg>
    </div>`;
}

function missionBarsHtml(rates) {
  return `
    <div class="vbar-chart">
      ${rates.map(item => `
        <div class="vbar" title="${esc(item.ko)} ${item.count}명 (${fmtPct(item.rate, 0)})">
          <span class="vbar-value">${round(item.rate)}</span>
          <div class="vbar-track"><div class="vbar-fill" style="height:${clamp(item.rate, 1.5, 100).toFixed(1)}%"></div></div>
          <span class="vbar-label">${esc(item.code)}</span>
        </div>
      `).join('')}
    </div>`;
}

function authHeaders() {
  return state.auth.token ? { Authorization: `Bearer ${state.auth.token}` } : {};
}

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), ...authHeaders() };
  const response = await fetch(url, { ...options, headers, cache: 'no-store' });
  if (response.status === 401 && state.auth.token) {
    clearAuth('세션이 만료되었습니다. 다시 로그인해 주세요.');
    throw new Error('UNAUTHORIZED');
  }
  return response;
}

function clearAuth(message = '', shouldRender = true) {
  sessionStorage.removeItem(SS_TOKEN);
  sessionStorage.removeItem(SS_ROLE);
  sessionStorage.removeItem(SS_STUDENT);
  state.auth = { role: null, token: null, studentId: null };
  state.seed = null;
  state.reports = {};
  state.codes = null;
  state.classStandings = null;
  state.selectedStudentId = null;
  state.detailStudentId = null;
  state.reportFingerprint = '';
  state.classFingerprint = '';
  state.view = 'auth';
  state.authStage = 'role';
  state.authStudentId = null;
  state.authCode = '';
  state.authBusy = false;
  state.authError = message;
  invalidate();
  if (shouldRender) render();
}

async function loadBootstrap(force = false) {
  if (state.bootstrap && !force) return true;
  try {
    const response = await fetch('/api/auth/bootstrap', { cache: 'no-store' });
    if (!response.ok) throw new Error('명단을 불러오지 못했습니다.');
    state.bootstrap = await response.json();
    if (!state.bootstrap.classes.some(item => item.id === state.authClass)) {
      state.authClass = state.bootstrap.classes[0] ? state.bootstrap.classes[0].id : 1;
    }
    return true;
  } catch (error) {
    state.authError = error.message || '학생 명단을 불러오지 못했습니다.';
    return false;
  }
}

function focusAuthCode() {
  setTimeout(() => {
    const input = document.getElementById('auth-code') || document.getElementById('auth-teacher-code');
    if (input) input.focus();
  }, 60);
}

function renderAuth() {
  const meta = state.bootstrap ? state.bootstrap.meta : null;
  const stage = state.authStage;
  const errorMarkup = state.authError ? `<div class="auth-error">${esc(state.authError)}</div>` : '';

  let panel = '';
  if (stage === 'student') {
    if (!state.bootstrap) {
      panel = `
        <div class="auth-stage-head">
          <button class="auth-back" data-action="auth-back">← 역할 선택</button>
        </div>
        <h2>학생 로그인</h2>
        <div class="empty-state" style="margin-top:22px"><strong>학생 명단을 불러오는 중입니다</strong>잠시만 기다려 주세요.</div>`;
    } else {
      const classes = state.bootstrap.classes;
      const students = state.bootstrap.students.filter(student => student.classId === state.authClass);
      const selected = state.authStudentId ? state.bootstrap.students.find(student => student.id === state.authStudentId) : null;
      panel = `
        <div class="auth-stage-head">
          <button class="auth-back" data-action="auth-back">← 역할 선택</button>
          <span class="live-badge"><span class="live-dot"></span>개인 코드 필요</span>
        </div>
        <h2>학생 로그인</h2>
        <p class="auth-sub">반과 이름을 선택한 뒤, 선생님이 알려준 6자리 개인 코드를 입력하세요.</p>
        <div class="class-tabs auth-class-tabs">
          ${classes.map(item => `<button class="class-tab ${item.id === state.authClass ? 'active' : ''}" data-action="auth-class" data-class="${item.id}">${esc(item.name)}<span>${item.studentCount}명</span></button>`).join('')}
        </div>
        <div class="auth-student-grid">
          ${students.map(student => `
            <button class="auth-student-btn ${student.id === state.authStudentId ? 'active' : ''}" data-action="auth-select-student" data-student="${esc(student.id)}">
              <span class="num">${student.no}</span><strong>${esc(student.name)}</strong>
            </button>`).join('')}
        </div>
        ${selected ? `
          <div class="auth-code-box">
            <div class="auth-code-title"><span>${esc(selected.name)}</span><small>${esc(classes.find(item => item.id === selected.classId)?.name || '')} · ${selected.no}번</small></div>
            <div class="auth-code-row">
              <input id="auth-code" class="auth-code-input" data-input="auth-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6자리 코드" value="${esc(state.authCode)}">
              <button class="btn btn-primary" data-action="auth-login-student" ${state.authBusy ? 'disabled' : ''}>${state.authBusy ? '확인 중' : '입장'}</button>
            </div>
            <p class="auth-hint">코드를 분실했다면 선생님께 다시 요청하세요.</p>
          </div>` : `<div class="auth-code-empty">이름을 선택하면 입장 코드 입력창이 열립니다.</div>`}
        ${errorMarkup}`;
    }
  } else if (stage === 'teacher') {
    panel = `
      <div class="auth-stage-head">
        <button class="auth-back" data-action="auth-back">← 역할 선택</button>
        <span class="live-badge"><span class="live-dot"></span>교사 전용</span>
      </div>
      <h2>교사 로그인</h2>
      <p class="auth-sub">교사용 종합 보고서와 학생 입장 코드를 관리하려면 교사 코드를 입력하세요.</p>
      <div class="auth-code-box" style="margin-top:22px">
        <label class="auth-label" for="auth-teacher-code">교사 입장 코드</label>
        <div class="auth-code-row">
          <input id="auth-teacher-code" class="auth-code-input" data-input="auth-code" maxlength="12" autocomplete="one-time-code" placeholder="예: ABCD-EFGH" value="${esc(state.authCode)}">
          <button class="btn btn-primary" data-action="auth-login-teacher" ${state.authBusy ? 'disabled' : ''}>${state.authBusy ? '확인 중' : '입장'}</button>
        </div>
        <p class="auth-hint">교사 코드는 학교 관리자에게 문의하세요. 로컬 실행 시 서버 콘솔과 <code>data/auth.json</code>에서 확인할 수 있습니다.</p>
      </div>
      ${errorMarkup}`;
  } else {
    panel = `
      <span class="eyebrow">Sign in</span>
      <h2 style="margin-top:12px">역할을 선택하세요</h2>
      <p class="auth-sub">학생은 자신의 개인 코드로만 입장할 수 있고, 다른 학생의 기록에는 접근할 수 없습니다.</p>
      <div class="auth-role-grid">
        <button class="auth-role-card student" data-action="auth-role-student">
          <span class="auth-role-icon">ST</span>
          <strong>학생</strong>
          <span>나의 레벨업 보드에서 미션을 통과하고 바로 보고합니다.</span>
          <em>개인 입장 코드로 시작 →</em>
        </button>
        <button class="auth-role-card teacher" data-action="auth-role-teacher">
          <span class="auth-role-icon">TE</span>
          <strong>교사</strong>
          <span>개별·반별·단원별 종합 보고서와 입장 코드를 관리합니다.</span>
          <em>교사 코드로 시작 →</em>
        </button>
      </div>
      ${errorMarkup}
      <p class="auth-note">입장 코드를 모르는 학생은 담당 선생님께 문의하세요.</p>`;
  }

  return `
    <div class="page auth-page">
      <div class="container">
        <header class="topbar">
          ${brandMarkup()}
          <span class="topbar-meta"><span class="dot"></span>학생 · 교사 입장</span>
        </header>
        <section class="auth-layout">
          <div class="auth-visual">
            <span class="eyebrow">Level Up Yourself</span>
            <h1>누구로<br><span>시작할까요?</span></h1>
            <p>자신의 실력에 맞는 레벨을 선택하고, 미션을 통과할 때마다 나의 성장을 기록하세요.</p>
            <div class="auth-visual-stats">
              <div><strong>${meta ? meta.studentCount : '—'}</strong><span>참여 학생</span></div>
              <div><strong>${meta ? meta.classCount : '—'}</strong><span>학급</span></div>
              <div><strong>5</strong><span>레벨 티어</span></div>
            </div>
            <div class="tier-preview auth-tier-preview">
              ${state.bootstrap ? state.bootstrap.classes.slice(0, 3).map((item, index) => `
                <div class="tier-preview-item">
                  <div class="tier-medal" style="background:${['#4f6ef7', '#149d95', '#c79a16'][index]}">${index + 1}</div>
                  <div><strong>${esc(item.name)}</strong><span>${item.studentCount}명 · 레벨업 레이스 참여</span></div>
                </div>`).join('') : `
                <div class="tier-preview-item"><div class="tier-medal" style="background:#4f6ef7">1</div><div><strong>BRONZE</strong><span>기초 어휘</span></div></div>
                <div class="tier-preview-item"><div class="tier-medal" style="background:#149d95">3</div><div><strong>GOLD</strong><span>역할극</span></div></div>
                <div class="tier-preview-item"><div class="tier-medal" style="background:#c79a16">5</div><div><strong>DIAMOND</strong><span>자율 창작 프로젝트</span></div></div>`}
            </div>
          </div>
          <div class="auth-card">${panel}</div>
        </section>
        <footer class="landing-footer">
          <div><strong>Level Up Yourself</strong> · LAON 영어 레벨업 챌린지</div>
          <div>2026학년도 · 5학년 2학기 영어</div>
        </footer>
      </div>
    </div>`;
}

async function loginStudent() {
  if (state.authBusy) return;
  const input = document.getElementById('auth-code');
  const code = (input ? input.value : state.authCode).replace(/\D/g, '').slice(0, 6);
  state.authCode = code;
  if (!state.authStudentId) {
    state.authError = '이름을 먼저 선택해 주세요.';
    render();
    return;
  }
  if (code.length !== 6) {
    state.authError = '6자리 개인 입장 코드를 입력해 주세요.';
    render();
    focusAuthCode();
    return;
  }
  state.authBusy = true;
  state.authError = '';
  render();
  try {
    const response = await fetch('/api/auth/student', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: state.authStudentId, code })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '입장에 실패했습니다.');
    state.auth = { role: 'student', token: payload.token, studentId: payload.student.id };
    sessionStorage.setItem(SS_TOKEN, payload.token);
    sessionStorage.setItem(SS_ROLE, 'student');
    sessionStorage.setItem(SS_STUDENT, payload.student.id);
    const loaded = await loadStudentState({ initial: true });
    if (!loaded) throw new Error('학생 데이터를 불러오지 못했습니다.');
    state.authBusy = false;
    state.authCode = '';
    state.authError = '';
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
  } catch (error) {
    state.authBusy = false;
    if (error.message === 'UNAUTHORIZED') return;
    state.authError = error.message || '입장에 실패했습니다.';
    render();
    focusAuthCode();
  }
}

async function loginTeacher() {
  if (state.authBusy) return;
  const input = document.getElementById('auth-teacher-code');
  const code = (input ? input.value : state.authCode).trim().toUpperCase();
  state.authCode = code;
  if (!code) {
    state.authError = '교사 입장 코드를 입력해 주세요.';
    render();
    focusAuthCode();
    return;
  }
  state.authBusy = true;
  state.authError = '';
  render();
  try {
    const response = await fetch('/api/auth/teacher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '입장에 실패했습니다.');
    state.auth = { role: 'teacher', token: payload.token, studentId: null };
    sessionStorage.setItem(SS_TOKEN, payload.token);
    sessionStorage.setItem(SS_ROLE, 'teacher');
    sessionStorage.removeItem(SS_STUDENT);
    const loaded = await loadTeacherState({ initial: true });
    if (!loaded) throw new Error('교사 데이터를 불러오지 못했습니다.');
    state.authBusy = false;
    state.authCode = '';
    state.authError = '';
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
  } catch (error) {
    state.authBusy = false;
    if (error.message === 'UNAUTHORIZED') return;
    state.authError = error.message || '입장에 실패했습니다.';
    render();
    focusAuthCode();
  }
}

async function logout() {
  const token = state.auth.token;
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch (error) { /* ignore */ }
  }
  clearAuth('', false);
  state.authError = '';
  render();
  showToast('로그아웃', '안전하게 로그아웃되었습니다.');
}

function renderLanding() {
  const summaryData = summary();
  const savedStudent = state.selectedStudentId ? studentById(state.selectedStudentId) : null;
  const topClass = sortedClasses()[0];

  return `
    <div class="page">
      <div class="container">
        <header class="topbar">
          ${brandMarkup()}
          <div class="topbar-actions">
            <span class="topbar-meta"><span class="dot"></span>2026 · 5학년 2학기 영어</span>
            <button class="btn btn-ghost btn-sm" data-action="mode-teacher">교사용 대시보드</button>
          </div>
        </header>

        <main>
          <section class="landing-hero">
            <div class="hero-copy">
              <span class="eyebrow">Choose your mission tier</span>
              <h1>나의 한계를 넘어<br><span>한 단계 더</span> 레벨업</h1>
              <p>
                자신의 실력에 맞는 단계를 고르고, 미션을 하나씩 통과하며 배움의 주인이 되어 보세요.
                통과한 순간, 나의 기록이 선생님의 종합 보고서에 바로 쌓입니다.
              </p>
              <div class="hero-actions">
                <button class="btn btn-primary" data-action="mode-student">학생으로 시작 <span class="btn-count">GO</span></button>
                <button class="btn btn-white-ghost" data-action="mode-teacher">교사 종합 보고서</button>
                ${savedStudent ? `<button class="btn btn-white-ghost" data-action="resume-student">${esc(savedStudent.name)} 이어서 하기</button>` : ''}
              </div>
              <div class="hero-stats">
                <div class="hero-stat"><strong>${state.seed.meta.studentCount}</strong><span>참여 학생</span></div>
                <div class="hero-stat"><strong>${state.seed.meta.classCount}</strong><span>학급</span></div>
                <div class="hero-stat"><strong>${state.seed.meta.lessonCount}</strong><span>단원</span></div>
                <div class="hero-stat"><strong>5</strong><span>레벨 티어</span></div>
              </div>
            </div>
            <aside class="hero-aside">
              <div class="tier-preview">
                ${state.seed.tiers.map(tier => `
                  <div class="tier-preview-item">
                    <div class="tier-medal" style="background:${tier.color}">${tier.level}</div>
                    <div><strong>${tier.name}</strong><span>${tier.ko} · ${tier.headline}</span></div>
                  </div>`).join('')}
              </div>
            </aside>
          </section>

          <section class="landing-features">
            <article class="feature-card">
              <div class="feature-icon">01</div>
              <h3>스스로 고르는 미션</h3>
              <p>BRONZE부터 DIAMOND까지, 나의 속도에 맞춰 단계를 선택하고 도전합니다. GOLD를 건너뛰고 PLATINUM에 도전할 수도 있어요.</p>
            </article>
            <article class="feature-card">
              <div class="feature-icon">02</div>
              <h3>통과 즉시 보고</h3>
              <p>미션을 통과할 때마다 내 기기에서 바로 보고합니다. 선생님의 종합 보고서에는 실시간으로 반영됩니다.</p>
            </article>
            <article class="feature-card">
              <div class="feature-icon">03</div>
              <h3>함께 보는 성장</h3>
              <p>개별 성취, 진도, 반별 현황, 단원별 현황을 그래프로 확인하며 우리 반의 레벨업 경쟁을 함께 응원합니다.</p>
            </article>
          </section>

          <section class="panel panel-pad" style="margin-top:22px">
            <div class="chart-head">
              <div>
                <h3>반별 레벨업 레이스</h3>
                <p>6개 반의 전체 미션 달성률 평균입니다. 지금 1위는 ${topClass ? `${esc(topClass.name)} (${fmtPct(topClass.progress, 1)})` : '-'}입니다.</p>
              </div>
              <span class="live-badge"><span class="live-dot"></span>실시간</span>
            </div>
            ${raceChartHtml(computed().classes)}
            <div class="result-line" style="margin-top:14px;margin-bottom:0">
              <span>학생 보고 <strong>${summaryData.reportCount}건</strong> · 참여 학생 <strong>${summaryData.participants}명</strong></span>
              <span>학생 기기에서 통과 보고 시 자동 반영</span>
            </div>
          </section>
        </main>

        <footer class="landing-footer">
          <div>
            <strong>Level Up Yourself</strong> · Choose your mission tier, challenge your limits, and level up!
            <span>평가 기록: ${esc(state.seed.meta.sourceAssessment)}</span>
          </div>
          <div>2026학년도 · 5학년 2학기 영어<br><span>${esc(state.seed.meta.school)}</span></div>
        </footer>
      </div>
    </div>`;
}

function renderStudentPick() {
  const classId = state.selectedClass || 1;
  const students = studentsOfClass(classId);
  const data = computed();
  return `
    <div class="page">
      <div class="container pick-wrap">
        <header class="topbar">
          ${brandMarkup()}
          <div class="topbar-actions">
            <button class="btn btn-ghost btn-sm" data-action="go-home">처음으로</button>
            <button class="btn btn-ghost btn-sm" data-action="mode-teacher">교사용 대시보드</button>
          </div>
        </header>

        <section class="pick-hero">
          <div>
            <span class="eyebrow">Student check-in</span>
            <h1>내 이름을 선택하세요</h1>
            <p>반을 고른 뒤, 내 이름을 누르면 나의 레벨업 보드로 이동합니다.</p>
          </div>
          <span class="live-badge"><span class="live-dot"></span>${state.seed.meta.studentCount}명 참여 중</span>
        </section>

        <div class="class-tabs" style="margin-bottom:18px">
          ${state.seed.classes.map(item => `
            <button class="class-tab ${item.id === classId ? 'active' : ''}" data-action="select-class" data-class="${item.id}">
              ${item.name}<span>${item.studentCount}명</span>
            </button>`).join('')}
        </div>

        <div class="panel panel-pad">
          <div class="section-head">
            <div>
              <h2>${classById(classId) ? classById(classId).name : ''} 학생</h2>
              <p>이름을 누르면 나의 단원별 미션 보드가 열립니다.</p>
            </div>
            <span class="small muted">${students.length}명</span>
          </div>
          ${students.length ? `
            <div class="student-grid">
              ${students.map(student => {
                const stats = data.perStudent[student.id];
                return `
                  <button class="student-pick" data-action="select-student" data-student="${esc(student.id)}">
                    <span class="num">${student.no}</span>
                    <strong>${esc(student.name)}</strong>
                    <span class="mini-level">${stats.maxLevel ? `L${stats.maxLevel}` : '–'}</span>
                  </button>`;
              }).join('')}
            </div>` : `<div class="pick-empty">학생 명단이 없습니다.</div>`}
        </div>

        <div class="pick-note">
          <span>선생님이신가요? 학생 보고 현황과 반별·단원별 종합 보고서를 확인할 수 있습니다.</span>
          <button class="btn btn-soft btn-sm" data-action="mode-teacher">교사용 대시보드 열기</button>
        </div>
      </div>
    </div>`;
}

function renderStudentHome() {
  const student = studentById(state.selectedStudentId);
  if (!student) {
    state.view = 'studentPick';
    return renderStudentPick();
  }
  const stats = computed().perStudent[student.id];
  const lesson = lessonById(state.selectedLessonId);
  const unit = stats.byLesson[lesson.id];
  const flags = unit.flags;
  const classList = state.classStandings || [];
  const classStats = classList.find(item => item.id === student.classId) || { avgLevel: 0, diamond: 0, progress: 0 };
  const classRank = classList.findIndex(item => item.id === student.classId) + 1;
  const nextLevel = Math.min(5, unit.level + 1);
  const nextTier = tierOf(nextLevel);
  const achievedMissions = state.seed.missions.filter(mission => flags[mission.code]);
  const diamondMissions = state.seed.missions.filter(mission => mission.group === 'diamond');
  const extraMissions = state.seed.missions.filter(mission => mission.group === 'extra');
  const diamondDone = diamondMissions.filter(mission => flags[mission.code]).length;

  const tierCards = [1, 2, 3, 4].map(level => {
    const tier = tierOf(level);
    const mission = state.seed.missions.find(item => item.tier === level && item.group === 'core');
    const done = Boolean(flags[mission.code]);
    return `
      <div class="tier-card ${done ? 'achieved' : ''}" style="--tier:${tier.color};--tier-soft:${tier.soft}">
        <div class="tier-num">${tier.level}</div>
        <div>
          <div class="tier-title-row">
            <h3>${tier.name}</h3>
            <span class="tier-ko">${tier.ko} · ${tier.headline}</span>
            ${statusPill(done)}
          </div>
          <p class="tier-desc">${esc(mission.desc)}</p>
          <div class="tier-mission-line">
            <span class="code-chip">${esc(mission.code)}</span>
            <span class="small muted">${esc(mission.name)}</span>
          </div>
        </div>
        <div class="tier-action">
          <button class="toggle-btn ${done ? 'done' : ''}" data-action="toggle-mission" data-student="${esc(student.id)}" data-lesson="${esc(lesson.id)}" data-code="${esc(mission.code)}" ${state.saving ? 'disabled' : ''}>
            ${done ? '보고 완료' : '통과 보고'}
          </button>
        </div>
      </div>`;
  }).join('');

  const diamondTier = tierOf(5);
  const diamondCard = `
    <div class="tier-card ${diamondDone ? 'achieved' : ''}" style="--tier:${diamondTier.color};--tier-soft:${diamondTier.soft}">
      <div class="tier-num">5</div>
      <div>
        <div class="tier-title-row">
          <h3>${diamondTier.name}</h3>
          <span class="tier-ko">${diamondTier.ko} · ${diamondTier.headline}</span>
          ${statusPill(diamondDone > 0)}
        </div>
        <p class="tier-desc">아래 자율 프로젝트 중 1개 이상을 완성하면 DIAMOND에 도달합니다. 나에게 맞는 방식으로 도전해 보세요.</p>
        <div class="diamond-chips">
          ${diamondMissions.map(mission => `
            <button class="mission-chip ${flags[mission.code] ? 'done' : ''}" data-action="toggle-mission" data-student="${esc(student.id)}" data-lesson="${esc(lesson.id)}" data-code="${esc(mission.code)}" ${state.saving ? 'disabled' : ''} title="${esc(mission.desc)}">
              <span class="chip-code">${esc(mission.code)}</span>${esc(mission.ko)}
            </button>`).join('')}
        </div>
      </div>
      <div class="tier-action"><span class="status-pill ${diamondDone ? 'done' : 'todo'}">${diamondDone}/5 완료</span></div>
    </div>`;

  const extraSection = `
    <div class="extra-section">
      <div class="extra-head">
        <div><h3>단원 의무 · 가정 학습</h3><p>레벨과 별개로 이번 단원에서 함께 챙기는 미션입니다.</p></div>
        <span class="small muted">${extraMissions.filter(mission => flags[mission.code]).length}/${extraMissions.length}</span>
      </div>
      <div class="extra-chips">
        ${extraMissions.map(mission => `
          <button class="mission-chip ${flags[mission.code] ? 'done' : ''}" data-action="toggle-mission" data-student="${esc(student.id)}" data-lesson="${esc(lesson.id)}" data-code="${esc(mission.code)}" ${state.saving ? 'disabled' : ''} title="${esc(mission.desc)}">
            <span class="chip-code">${esc(mission.code)}</span>${esc(mission.ko)}
          </button>`).join('')}
      </div>
    </div>`;

  const recordItems = achievedMissions.length
    ? achievedMissions.slice(0, 6).map(mission => `
        <div class="record-item">
          <span class="record-dot" style="background:${mission.tier ? (tierOf(mission.tier) || {}).color || '#149d95' : '#149d95'}"></span>
          <strong>${esc(mission.ko)}</strong>
          <span>${esc(mission.code)}</span>
        </div>`).join('')
    : `<div class="empty-state"><strong>아직 이번 단원의 기록이 없어요</strong>첫 미션을 통과하고 보고해 보세요.</div>`;

  return `
    <div class="page">
      <div class="container">
        <header class="topbar">
          ${brandMarkup()}
          <div class="topbar-actions">
            ${state.saving ? '<span class="sync-note"><span class="saving-dot"></span>저장 중</span>' : '<span class="sync-note">내 기기에서 바로 보고</span>'}
            <button class="btn btn-ghost btn-sm" data-action="logout">로그아웃</button>
            <div class="student-topbar-user">
              <span>${esc(student.name)}</span>
            </div>
          </div>
        </header>

        <section class="student-hero">
          <div class="student-card identity">
            <div class="student-id-row">
              <div class="avatar lg">${initial(student.name)}</div>
              <div>
                <span class="class-pill">5학년 · ${esc(classById(student.classId).name)} · ${student.no}번</span>
                <h1>${esc(student.name)}</h1>
                <p>오늘도 나의 속도로, 한 단계씩 레벨업해 보세요.</p>
              </div>
            </div>
          </div>
          <div class="student-card">
            <div class="student-hero-progress">
              <div class="ring" style="--pct:${clamp(stats.progress, 0, 100).toFixed(1)}">
                <div class="ring-inner"><strong>${round(stats.progress)}%</strong><span>전체 미션</span></div>
              </div>
              <div>
                <h3>전체 미션 달성률</h3>
                <p>${stats.totalMissions}개 미션 완료<br>최고 도달 ${levelBadge(stats.maxLevel)}</p>
              </div>
            </div>
          </div>
          <div class="student-card next-target">
            <div>
              <span class="eyebrow">Next target</span>
              <div class="target-tier" style="margin-top:12px">
                <div class="target-medal" style="background:${nextTier ? nextTier.color : '#149d95'}">${unit.level >= 5 ? 'OK' : nextTier.level}</div>
                <div>
                  <h3>${unit.level >= 5 ? 'DIAMOND 완성!' : `${nextTier.name}에 도전해 보세요`}</h3>
                  <p>${unit.level >= 5 ? '이번 단원의 최고 단계에 도달했어요. 다른 단원에도 도전해 보세요.' : `${lesson.id} · ${nextTier.ko} ${nextTier.headline}`}</p>
                </div>
              </div>
            </div>
            <div>
              <div class="result-line" style="margin-bottom:6px"><span>이번 단원 진도</span><strong>${round(unit.pct)}%</strong></div>
              ${pbar(unit.pct)}
            </div>
          </div>
        </section>

        <div class="student-layout">
          <div class="student-main">
            <section class="panel panel-pad">
              <div class="section-head">
                <div><h2>단원 선택</h2><p>6개 단원 중 지금 도전할 단원을 골라 주세요.</p></div>
                <span class="small muted">${lesson.weeks}</span>
              </div>
              <div class="unit-strip">
                ${state.seed.lessons.map(item => {
                  const itemStats = stats.byLesson[item.id];
                  const tier = tierOf(itemStats.level);
                  return `
                    <button class="unit-tab ${item.id === lesson.id ? 'active' : ''}" data-action="select-lesson" data-lesson="${esc(item.id)}">
                      <span class="unit-code">L${item.num}<i style="background:${tier ? tier.color : '#d6dceb'}"></i></span>
                      <span class="unit-title">${esc(item.title)}</span>
                      ${pbar(itemStats.pct)}
                      <span class="unit-pct">${round(itemStats.pct)}% · ${levelName(itemStats.level)}</span>
                    </button>`;
                }).join('')}
              </div>
            </section>

            <section class="panel panel-pad">
              <div class="unit-head">
                <div>
                  <span class="eyebrow" style="font-size:10.5px">Lesson ${lesson.num}</span>
                  <h2 style="margin-top:8px">${esc(lesson.title)}</h2>
                  <p>${esc(lesson.focus)}</p>
                </div>
                <div class="unit-meta"><span class="class-pill">${lesson.weeks}</span>${levelBadge(unit.level, true)}</div>
              </div>
              <div class="unit-progress-block" style="margin-top:18px;max-width:320px">
                <div class="row"><span>이번 단원 미션 달성률</span><strong>${unit.count}/${state.seed.missions.length} · ${round(unit.pct)}%</strong></div>
                ${pbar(unit.pct)}
              </div>
              <div class="level-ladder">${tierCards}${diamondCard}</div>
              ${extraSection}
            </section>
          </div>

          <aside class="student-side">
            <section class="panel panel-pad">
              <div class="section-head" style="margin-bottom:14px">
                <div><h2 style="font-size:15px">우리 반 레이스</h2><p>${esc(classById(student.classId).name)} 현재 ${classRank}위 / ${classList.length}개 반</p></div>
                <span class="live-badge"><span class="live-dot"></span>LIVE</span>
              </div>
              <div class="race-mini">
                ${classList.map((item, index) => `
                  <div class="race-mini-row ${item.id === student.classId ? 'me' : ''}">
                    <span class="name">${index + 1}. ${esc(item.name)}</span>
                    ${pbar(item.progress, item.id === student.classId ? 'linear-gradient(90deg,#4f6ef7,#7b8cff)' : '')}
                    <span class="value">${round(item.progress)}%</span>
                  </div>`).join('')}
              </div>
              <div class="level-summary-mini" style="margin-top:15px">우리 반 평균 <strong>${classStats.avgLevel.toFixed(1)}L</strong> · DIAMOND <strong>${classStats.diamond}명</strong></div>
            </section>

            <section class="panel panel-pad">
              <div class="section-head" style="margin-bottom:12px">
                <div><h2 style="font-size:15px">이번 단원 기록</h2><p>내가 통과한 미션</p></div>
                <span class="small muted">${achievedMissions.length}개</span>
              </div>
              <div class="record-list">${recordItems}</div>
            </section>

            <section class="tip-card">
              <span class="eyebrow">Challenge tip</span>
              <h3>순서는 나의 선택</h3>
              <p>미션은 순서대로 도전해도 좋고, 자신 있는 단계부터 시작해도 좋아요. GOLD를 건너뛰고 PLATINUM에 바로 도전할 수 있습니다.</p>
            </section>
          </aside>
        </div>
      </div>
    </div>`;
}

function teacherTopbar() {
  const tabs = [['overview', '종합'], ['individual', '개별'], ['classes', '반별'], ['units', '단원별'], ['codes', '입장 코드']];
  return `
    <div class="teacher-topbar">
      <div class="container-wide inner">
        ${brandMarkup()}
        <div class="teacher-title">
          <div><h1>교사용 종합 보고서</h1><p>학생 보고 · 개별 성취 · 반별 경쟁 · 단원별 현황</p></div>
        </div>
        <div class="topbar-actions">
          <span class="class-pill">교사 모드</span>
          <span class="live-badge"><span class="live-dot"></span><span id="last-sync">${state.lastSync ? formatClock(state.lastSync) : '연결 중'}</span></span>
          <button class="btn btn-ghost btn-sm" data-action="refresh" ${state.refreshing ? 'disabled' : ''}>${state.refreshing ? '새로고침 중' : '새로고침'}</button>
          <button class="btn btn-soft btn-sm" data-action="export-csv">CSV 다운로드</button>
          <button class="btn btn-ghost btn-sm" data-action="logout">로그아웃</button>
        </div>
      </div>
      <div class="container-wide">
        <nav class="dash-tabs" aria-label="보고서 탭">
          ${tabs.map(([key, label]) => `<button class="dash-tab ${state.teacherTab === key ? 'active' : ''}" data-action="teacher-tab" data-tab="${key}">${label}</button>`).join('')}
        </nav>
      </div>
    </div>`;
}

function renderOverview() {
  const data = computed();
  const summaryData = summary();
  const topStudents = [...data.students].sort((a, b) => b.progress - a.progress || b.maxLevel - a.maxLevel).slice(0, 6);
  const recent = Object.values(state.reports).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 6);

  return `
    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">전체 학생 <span class="dot"></span></div>
        <div class="kpi-value">${summaryData.totalStudents}<small>명</small></div>
        <div class="kpi-sub">${state.seed.meta.classCount}개 반 · ${state.seed.meta.lessonCount}개 단원</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">학생 보고</div>
        <div class="kpi-value">${summaryData.reportCount}<small>건</small></div>
        <div class="kpi-sub">참여 학생 <strong>${summaryData.participants}명</strong></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">평균 미션 달성률</div>
        <div class="kpi-value">${summaryData.avgProgress.toFixed(1)}<small>%</small></div>
        <div class="kpi-sub">6개 단원 · 11개 미션 기준</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">평균 도달 레벨</div>
        <div class="kpi-value">${summaryData.avgLevel.toFixed(1)}<small>/ 5.0</small></div>
        <div class="kpi-sub">학생별 단원 평균 레벨</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">DIAMOND 학생</div>
        <div class="kpi-value">${summaryData.diamondStudents}<small>명</small></div>
        <div class="kpi-sub">최고 도달 레벨 기준</div>
      </div>
    </section>

    <div class="overview-grid">
      <div class="overview-col">
        <section class="panel panel-pad">
          <div class="chart-head">
            <div><h3>반별 레벨업 경쟁</h3><p>반별 전체 미션 달성률 평균과 평균 도달 레벨입니다.</p></div>
            <span class="live-badge"><span class="live-dot"></span>실시간</span>
          </div>
          ${raceChartHtml(data.classes)}
        </section>
        <section class="panel panel-pad">
          <div class="chart-head">
            <div><h3>단원별 평균 미션 달성률</h3><p>L7부터 L12까지 단원별 전체 학생 평균입니다.</p></div>
            <span class="chart-legend"><span class="legend-item"><span class="legend-swatch"></span>전체 평균</span></span>
          </div>
          ${unitTrendSvg()}
        </section>
      </div>

      <div class="overview-col">
        <section class="panel panel-pad">
          <div class="chart-head">
            <div><h3>학생 레벨 분포</h3><p>학생별 최고 도달 레벨 기준입니다.</p></div>
            <span class="small muted">${summaryData.totalStudents}명</span>
          </div>
          ${stackedTierHtml(summaryData.tierCounts)}
        </section>

        <section class="panel panel-pad">
          <div class="chart-head">
            <div><h3>성장 리더보드</h3><p>전체 미션 달성률 상위 학생입니다.</p></div>
            <span class="small muted">TOP 6</span>
          </div>
          <div class="leader-list">
            ${topStudents.map((student, index) => `
              <div class="leader-row">
                <div class="leader-rank">${index + 1}</div>
                <div class="leader-name">${esc(student.student.name)}<span>${esc(classById(student.student.classId).name)} · ${levelName(student.maxLevel)}</span></div>
                <div class="leader-track"><i style="width:${clamp(student.progress, 0, 100).toFixed(1)}%"></i></div>
                <div class="leader-value">${round(student.progress)}%</div>
              </div>`).join('')}
          </div>
        </section>

        <section class="panel panel-pad">
          <div class="chart-head">
            <div><h3>최근 학생 보고</h3><p>학생 기기에서 보고된 최신 기록입니다.</p></div>
            <span class="small muted">${summaryData.reportCount}건</span>
          </div>
          ${recent.length ? `
            <div class="feed">
              ${recent.map(report => {
                const student = studentById(report.studentId);
                const lesson = lessonById(report.lessonId);
                const level = levelFromFlags(report.missions || {});
                const count = missionCount(report.missions || {});
                return `
                  <div class="feed-item">
                    <div class="feed-avatar">${initial(student ? student.name : '?')}</div>
                    <div class="feed-body">
                      <strong>${esc(student ? student.name : report.studentName || '학생')}</strong>
                      <p>${esc(student ? classById(student.classId).name : '')} · ${esc(lesson.id)} ${levelName(level)} · ${count}/${state.seed.missions.length} 미션</p>
                    </div>
                    <span class="feed-time">${esc(formatRelative(report.updatedAt))}</span>
                  </div>`;
              }).join('')}
            </div>` : `
            <div class="empty-state"><strong>아직 학생 보고가 없습니다</strong>학생 모드에서 미션을 통과하면 이곳에 실시간으로 표시됩니다.</div>`}
        </section>
      </div>
    </div>`;
}

function filteredStudents() {
  let list = [...computed().students];
  if (state.teacherClassFilter !== 'all') {
    list = list.filter(item => item.student.classId === Number(state.teacherClassFilter));
  }
  const query = state.teacherSearch.trim().toLowerCase();
  if (query) {
    list = list.filter(item => item.student.name.toLowerCase().includes(query) || String(item.student.no) === query);
  }
  if (state.teacherSort === 'name') {
    list.sort((a, b) => a.student.name.localeCompare(b.student.name, 'ko'));
  } else if (state.teacherSort === 'level') {
    list.sort((a, b) => b.maxLevel - a.maxLevel || b.progress - a.progress);
  } else if (state.teacherSort === 'class') {
    list.sort((a, b) => a.student.classId - b.student.classId || a.student.no - b.student.no);
  } else {
    list.sort((a, b) => b.progress - a.progress || a.student.classId - b.student.classId || a.student.no - b.student.no);
  }
  return list;
}

function studentRowsHtml(list) {
  if (!list.length) {
    return `<tr><td colspan="6"><div class="empty-state"><strong>조건에 맞는 학생이 없습니다</strong>검색어나 반 필터를 바꿔 보세요.</div></td></tr>`;
  }
  return list.map(item => {
    const student = item.student;
    return `
      <tr>
        <td>
          <div class="student-cell">
            <div class="avatar">${initial(student.name)}</div>
            <div><strong>${esc(student.name)}</strong><span>${esc(classById(student.classId).name)} · ${student.no}번</span></div>
          </div>
        </td>
        <td><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${levelBadge(item.maxLevel)}${gradePill(item.maxLevel)}</div></td>
        <td><div class="progress-cell">${pbar(item.progress)}<span>${round(item.progress)}%</span></div></td>
        <td><div class="unit-mini-grid">${state.seed.lessons.map(lesson => unitMini(item.byLesson[lesson.id].level, lesson)).join('')}</div></td>
        <td>
          <span class="small muted">${item.lastReport ? esc(formatRelative(item.lastReport.updatedAt)) : '기초 기록'}</span>
          ${item.reportedUnits ? `<div class="tiny muted">${item.reportedUnits}개 단원 보고</div>` : ''}
        </td>
        <td><button class="row-link" data-action="open-student" data-student="${esc(student.id)}">상세</button></td>
      </tr>`;
  }).join('');
}

function individualSummaryHtml(list) {
  const total = computed().students.length;
  return `<span><strong>${list.length}</strong>명 표시 · 전체 ${total}명</span><span>평균 진도 <strong>${list.length ? fmtPct(avg(list.map(item => item.progress)), 1) : '0%'}</strong></span>`;
}

function updateIndividualTable() {
  const body = document.getElementById('student-table-body');
  if (!body) return;
  const list = filteredStudents();
  body.innerHTML = studentRowsHtml(list);
  const summaryEl = document.getElementById('individual-summary');
  if (summaryEl) summaryEl.innerHTML = individualSummaryHtml(list);
}

function renderIndividual() {
  const list = filteredStudents();
  return `
    <section class="panel panel-pad">
      <div class="section-head">
        <div><h2>개별 성취 현황</h2><p>학생별 최고 도달 레벨, 전체 진도, 단원별 도달 상황을 한눈에 확인합니다.</p></div>
        <span class="small muted">클릭하면 상세 미션 기록을 볼 수 있습니다.</span>
      </div>
      <div class="filter-bar">
        <div class="field">
          <label for="filter-class">반</label>
          <select id="filter-class" data-change="teacher-class">
            <option value="all" ${state.teacherClassFilter === 'all' ? 'selected' : ''}>전체</option>
            ${state.seed.classes.map(item => `<option value="${item.id}" ${String(state.teacherClassFilter) === String(item.id) ? 'selected' : ''}>${item.name}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="filter-search">검색</label>
          <input id="filter-search" data-input="teacher-search" type="search" placeholder="이름 또는 번호" value="${esc(state.teacherSearch)}" autocomplete="off">
        </div>
        <div class="field">
          <label for="filter-sort">정렬</label>
          <select id="filter-sort" data-change="teacher-sort">
            <option value="progress" ${state.teacherSort === 'progress' ? 'selected' : ''}>진도 높은 순</option>
            <option value="level" ${state.teacherSort === 'level' ? 'selected' : ''}>레벨 높은 순</option>
            <option value="name" ${state.teacherSort === 'name' ? 'selected' : ''}>이름 순</option>
            <option value="class" ${state.teacherSort === 'class' ? 'selected' : ''}>반·번호 순</option>
          </select>
        </div>
      </div>
      <div class="result-line" id="individual-summary">${individualSummaryHtml(list)}</div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>학생</th><th>최고 레벨 · 성취</th><th>전체 진도</th><th>단원별 도달 (L7–L12)</th><th>최근 보고</th><th></th></tr></thead>
          <tbody id="student-table-body">${studentRowsHtml(list)}</tbody>
        </table>
      </div>
    </section>`;
}

function classHeatmapHtml() {
  const classes = computed().classes;
  return `
    <div class="heatmap-wrap">
      <table class="heatmap">
        <thead><tr><th>반</th>${state.seed.lessons.map(lesson => `<th>L${lesson.num}</th>`).join('')}<th>전체</th></tr></thead>
        <tbody>
          ${classes.map(item => `
            <tr>
              <td>${esc(item.name)}</td>
              ${state.seed.lessons.map(lesson => {
                const value = item.unitProgress[lesson.id];
                return `<td><div class="heat-cell" style="${heatStyle(value)}" title="${esc(item.name)} ${esc(lesson.title)} ${fmtPct(value, 1)}">${round(value)}%</div></td>`;
              }).join('')}
              <td><div class="heat-cell total" title="${esc(item.name)} 전체 ${fmtPct(item.progress, 1)}">${round(item.progress)}%</div></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function classMissionHeatmapHtml(lessonId) {
  return `
    <div class="heatmap-wrap">
      <table class="heatmap" style="min-width:760px">
        <thead><tr><th>반</th>${state.seed.missions.map(mission => `<th>${esc(mission.code)}</th>`).join('')}<th>단원</th></tr></thead>
        <tbody>
          ${computed().classes.map(item => {
            const unitStats = computeUnitStats(lessonId, item.id);
            return `<tr><td>${esc(item.name)}</td>${unitStats.missionRates.map(rate => `<td><div class="heat-cell" style="${heatStyle(rate.rate)}" title="${esc(item.name)} ${esc(rate.ko)} ${fmtPct(rate.rate, 1)}">${round(rate.rate)}%</div></td>`).join('')}<td><div class="heat-cell total">${round(unitStats.progress)}%</div></td></tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderClasses() {
  const data = computed();
  const focusClass = classById(state.classFocus) || state.seed.classes[0];
  const focusUnit = lessonById(state.classUnit || state.seed.lessons[0].id);
  const unitStats = computeUnitStats(focusUnit.id, focusClass.id);
  const focusStudents = studentsOfClass(focusClass.id)
    .map(student => data.perStudent[student.id])
    .sort((a, b) => b.progress - a.progress);

  return `
    <section class="class-card-grid">
      ${data.classes.map(item => {
        const rank = sortedClasses().findIndex(row => row.id === item.id) + 1;
        return `
          <button class="class-card ${item.id === focusClass.id ? 'active' : ''}" data-action="focus-class" data-class="${item.id}">
            <div class="class-card-head"><strong>${esc(item.name)}</strong><span>${item.count}명 · ${rank}위</span></div>
            <div class="progress-line">
              <div class="row"><span>평균 미션 달성률</span><strong>${fmtPct(item.progress, 1)}</strong></div>
              ${pbar(item.progress)}
            </div>
            <div class="class-card-stats">
              <span>평균<strong>${item.avgLevel.toFixed(1)}L</strong></span>
              <span>DIAMOND<strong>${item.diamond}명</strong></span>
              <span>보고<strong>${item.reported}건</strong></span>
            </div>
          </button>`;
      }).join('')}
    </section>

    <div class="two-col" style="margin-bottom:20px">
      <section class="panel panel-pad">
        <div class="chart-head">
          <div><h3>반별 전체 경쟁</h3><p>전체 미션 달성률 기준 순위입니다.</p></div>
          <span class="live-badge"><span class="live-dot"></span>실시간</span>
        </div>
        ${raceChartHtml(data.classes)}
      </section>
      <section class="panel panel-pad">
        <div class="chart-head">
          <div><h3>반 × 단원 히트맵</h3><p>반별 단원 평균 미션 달성률입니다.</p></div>
          <span class="small muted">L7–L12</span>
        </div>
        ${classHeatmapHtml()}
      </section>
    </div>

    <section class="panel panel-pad" style="margin-bottom:20px">
      <div class="section-head">
        <div><h2>${esc(focusClass.name)} 단원 상세</h2><p>${esc(focusUnit.title)} · ${esc(focusUnit.focus)}</p></div>
        <div class="unit-selector" style="margin:0;padding:0">
          ${state.seed.lessons.map(lesson => `
            <button class="unit-choice ${lesson.id === focusUnit.id ? 'active' : ''}" style="min-width:104px;padding:9px 12px" data-action="class-unit" data-unit="${esc(lesson.id)}">
              <span class="code">L${lesson.num}</span><span class="title">${esc(lesson.title)}</span>
            </button>`).join('')}
        </div>
      </div>
      <div class="two-col">
        <div>
          <div class="chart-head" style="margin-bottom:8px">
            <div><h3>미션별 달성률</h3><p>${esc(focusClass.name)} · ${esc(focusUnit.id)} · ${unitStats.count}명</p></div>
            <span class="small muted">${fmtPct(unitStats.progress, 1)}</span>
          </div>
          ${missionBarsHtml(unitStats.missionRates)}
        </div>
        <div>
          <div class="chart-head" style="margin-bottom:14px">
            <div><h3>${esc(focusUnit.id)} 레벨 분포</h3><p>이 단원에서 학생들이 도달한 레벨입니다.</p></div>
          </div>
          ${stackedTierHtml(unitStats.levelCounts)}
          <div class="result-line" style="margin:16px 0 8px"><span>지원이 필요한 학생</span><strong>${unitStats.support.length}명</strong></div>
          ${unitStats.support.length ? `
            <div class="support-list">
              ${unitStats.support.map(row => `<div class="support-row"><div class="avatar">${initial(row.student.name)}</div><strong>${esc(row.student.name)}</strong><span>${levelName(row.level)} · ${row.count}/${state.seed.missions.length}</span></div>`).join('')}
            </div>` : `<div class="empty-state"><strong>지원 대상이 없습니다</strong>모든 학생이 SILVER 이상에 도달했습니다.</div>`}
        </div>
      </div>
    </section>

    <section class="panel panel-pad">
      <div class="section-head">
        <div><h2>${esc(focusClass.name)} 학생별 현황</h2><p>학생별 전체 진도와 최고 도달 레벨입니다.</p></div>
        <span class="small muted">${focusStudents.length}명</span>
      </div>
      <div class="roster-list">
        ${focusStudents.map(item => `<div class="roster-row"><span class="num">${item.student.no}</span><span class="name">${esc(item.student.name)}</span>${pbar(item.progress)}<span class="pct">${round(item.progress)}%</span></div>`).join('')}
      </div>
    </section>`;
}

function renderUnits() {
  const lesson = lessonById(state.unitFocus || 'L7');
  const unitStats = computeUnitStats(lesson.id, null);
  const classUnitRows = computed().classes
    .map(item => ({ ...item, unitProgressValue: item.unitProgress[lesson.id] || 0, stats: computeUnitStats(lesson.id, item.id) }))
    .sort((a, b) => b.unitProgressValue - a.unitProgressValue || a.id - b.id);

  return `
    <div class="unit-selector">
      ${state.seed.lessons.map(item => `
        <button class="unit-choice ${item.id === lesson.id ? 'active' : ''}" data-action="unit-focus" data-unit="${esc(item.id)}">
          <span class="code">LESSON ${item.num}</span><span class="title">${esc(item.title)}</span>
        </button>`).join('')}
    </div>

    <section class="unit-hero">
      <div>
        <span class="eyebrow">Lesson ${lesson.num} · ${esc(lesson.weeks)}</span>
        <h2>${esc(lesson.title)}</h2>
        <p>${esc(lesson.focus)}</p>
      </div>
      <div class="unit-hero-stats">
        <div class="unit-hero-stat"><strong>${fmtPct(unitStats.progress, 1)}</strong><span>평균 달성률</span></div>
        <div class="unit-hero-stat"><strong>${unitStats.avgLevel.toFixed(1)}L</strong><span>평균 레벨</span></div>
        <div class="unit-hero-stat"><strong>${unitStats.diamond}명</strong><span>DIAMOND</span></div>
        <div class="unit-hero-stat"><strong>${unitStats.count}명</strong><span>참여 학생</span></div>
      </div>
    </section>

    <div class="two-col" style="margin-bottom:20px">
      <section class="panel panel-pad">
        <div class="chart-head">
          <div><h3>미션별 달성률</h3><p>${esc(lesson.id)} 전체 학생 기준입니다.</p></div>
          <span class="small muted">${unitStats.count}명</span>
        </div>
        ${missionBarsHtml(unitStats.missionRates)}
      </section>
      <section class="panel panel-pad">
        <div class="chart-head">
          <div><h3>반별 단원 달성률</h3><p>같은 단원에서 반별 경쟁 현황입니다.</p></div>
          <span class="live-badge"><span class="live-dot"></span>LIVE</span>
        </div>
        <div class="race-chart">
          ${classUnitRows.map((item, index) => `
            <div class="race-row">
              <div class="race-rank ${index < 3 ? 'top' : ''}">${index + 1}</div>
              <div class="race-name">${esc(item.name)}<span>${item.count}명 · ${esc(lesson.id)}</span></div>
              <div class="race-track"><div class="race-fill" style="width:${clamp(item.unitProgressValue, 0, 100).toFixed(1)}%;${index === 0 ? 'background:linear-gradient(90deg,#c79a16,#efc94c)' : ''}"></div></div>
              <div class="race-value">${fmtPct(item.unitProgressValue, 1)}</div>
              <div class="race-level">평균 ${item.stats.avgLevel.toFixed(1)}L</div>
            </div>`).join('')}
        </div>
      </section>
    </div>

    <section class="panel panel-pad" style="margin-bottom:20px">
      <div class="chart-head">
        <div><h3>반 × 미션 히트맵</h3><p>${esc(lesson.id)}에서 반별 미션 달성률입니다.</p></div>
        <span class="small muted">11개 미션</span>
      </div>
      ${classMissionHeatmapHtml(lesson.id)}
    </section>

    <div class="two-col">
      <section class="panel panel-pad">
        <div class="chart-head">
          <div><h3>${esc(lesson.id)} 레벨 분포</h3><p>단원별 학생 도달 레벨 분포입니다.</p></div>
        </div>
        ${stackedTierHtml(unitStats.levelCounts)}
        <div class="result-line" style="margin:18px 0 8px"><span>상위 성취 학생</span><strong>${unitStats.top.length}명</strong></div>
        <div class="leader-list">
          ${unitStats.top.map((row, index) => `
            <div class="leader-row">
              <div class="leader-rank">${index + 1}</div>
              <div class="leader-name">${esc(row.student.name)}<span>${esc(classById(row.student.classId).name)} · ${levelName(row.level)}</span></div>
              <div class="leader-track"><i style="width:${clamp(row.pct, 0, 100).toFixed(1)}%"></i></div>
              <div class="leader-value">${row.count}/${state.seed.missions.length}</div>
            </div>`).join('')}
        </div>
      </section>
      <section class="panel panel-pad">
        <div class="chart-head">
          <div><h3>지원이 필요한 학생</h3><p>${esc(lesson.id)}에서 BRONZE 이하에 머문 학생입니다.</p></div>
          <span class="small muted">${unitStats.support.length}명</span>
        </div>
        ${unitStats.support.length ? `
          <div class="support-list">
            ${unitStats.support.map(row => `<div class="support-row"><div class="avatar">${initial(row.student.name)}</div><strong>${esc(row.student.name)}</strong><span>${esc(classById(row.student.classId).name)} · ${levelName(row.level)}</span></div>`).join('')}
          </div>` : `<div class="empty-state"><strong>지원 대상이 없습니다</strong>모든 학생이 SILVER 이상에 도달했습니다.</div>`}
        <div class="result-line" style="margin:20px 0 10px"><span>반별 요약</span><strong>${classUnitRows.length}개 반</strong></div>
        <div class="table-wrap">
          <table class="data-table" style="min-width:0">
            <thead><tr><th>반</th><th>달성률</th><th>평균 레벨</th><th>DIAMOND</th></tr></thead>
            <tbody>
              ${classUnitRows.map(item => `<tr><td><strong>${esc(item.name)}</strong></td><td>${fmtPct(item.stats.progress, 1)}</td><td>${item.stats.avgLevel.toFixed(1)}L</td><td>${item.stats.diamond}명</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
    </div>`;
}

function renderCodes() {
  if (!state.codes) {
    return `<section class="panel panel-pad"><div class="empty-state"><strong>입장 코드를 불러오는 중입니다</strong>잠시만 기다려 주세요.</div></section>`;
  }
  const classes = state.seed.classes.map(cls => ({
    ...cls,
    students: state.codes.students
      .filter(student => student.classId === cls.id)
      .sort((a, b) => a.no - b.no)
  }));

  return `
    <section class="panel panel-pad" style="margin-bottom:20px">
      <div class="section-head">
        <div>
          <h2>입장 코드 관리</h2>
          <p>학생에게는 이름과 함께 개인 코드를 알려 주세요. 코드를 아는 학생만 해당 계정에 입장할 수 있습니다.</p>
        </div>
        <div class="topbar-actions">
          <button class="btn btn-ghost btn-sm" data-action="copy-teacher-code" data-code="${esc(state.codes.teacherCode)}">교사 코드 복사</button>
          <button class="btn btn-soft btn-sm" data-action="export-codes">코드 CSV 다운로드</button>
        </div>
      </div>

      <div class="teacher-code-banner">
        <div>
          <span class="auth-label">교사 입장 코드</span>
          <strong>${esc(state.codes.teacherCode)}</strong>
          <p>서버 실행 시 콘솔에도 표시됩니다. 외부에 공유하지 마세요.</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="copy-teacher-code" data-code="${esc(state.codes.teacherCode)}">복사</button>
      </div>

      <div class="code-warning">
        개인 코드는 학생 본인에게만 알려 주세요. 코드를 재발급하면 이전 코드는 즉시 사용할 수 없습니다.
      </div>

      ${classes.map(cls => `
        <div class="code-section">
          <div class="code-section-head">
            <h3>${esc(cls.name)}</h3>
            <span>${cls.students.length}명</span>
          </div>
          <div class="code-grid">
            ${cls.students.map(student => `
              <div class="code-row">
                <div class="code-student"><span>${student.no}</span><strong>${esc(student.name)}</strong></div>
                <code class="code-value">${esc(student.code)}</code>
                <div class="code-actions">
                  <button class="row-link" data-action="copy-code" data-code="${esc(student.code)}">복사</button>
                  <button class="row-link danger" data-action="regenerate-code" data-student="${esc(student.id)}" data-name="${esc(student.name)}">재발급</button>
                </div>
              </div>`).join('')}
          </div>
        </div>`).join('')}
    </section>`;
}

function renderTeacher() {
  let body = '';
  if (state.teacherTab === 'individual') body = renderIndividual();
  else if (state.teacherTab === 'classes') body = renderClasses();
  else if (state.teacherTab === 'units') body = renderUnits();
  else if (state.teacherTab === 'codes') body = renderCodes();
  else body = renderOverview();
  return `<div class="page">${teacherTopbar()}<main class="container-wide dash-body">${body}</main></div>`;
}

function renderModal() {
  if (!state.detailStudentId) {
    modalRoot.innerHTML = '';
    return;
  }
  const student = studentById(state.detailStudentId);
  if (!student) {
    state.detailStudentId = null;
    modalRoot.innerHTML = '';
    return;
  }
  const stats = computed().perStudent[student.id];
  const grade = gradeOf(stats.maxLevel);
  const coreMissions = state.seed.missions.filter(mission => mission.group !== 'extra');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(student.name)} 상세 성취">
        <div class="modal-head">
          <div class="avatar">${initial(student.name)}</div>
          <div><h2>${esc(student.name)}</h2><p>${esc(classById(student.classId).name)} · ${student.no}번 · ${levelName(stats.maxLevel)} · ${grade.label}</p></div>
          <button class="modal-close" data-action="close-modal" aria-label="닫기">×</button>
        </div>
        <div class="modal-body">
          <div class="detail-kpis">
            <div class="detail-kpi"><span>최고 도달 레벨</span><strong>${levelName(stats.maxLevel)}</strong></div>
            <div class="detail-kpi"><span>전체 미션 달성률</span><strong>${fmtPct(stats.progress, 1)}</strong></div>
            <div class="detail-kpi"><span>평균 단원 레벨</span><strong>${stats.avgLevel.toFixed(1)}L</strong></div>
            <div class="detail-kpi"><span>학생 보고 단원</span><strong>${stats.reportedUnits}/6</strong></div>
          </div>
          <div class="section-head" style="margin-bottom:12px">
            <div><h3>단원별 도달 현황</h3><p>각 단원의 레벨과 핵심 미션 달성 상태입니다.</p></div>
          </div>
          <div class="detail-unit-grid">
            ${state.seed.lessons.map(lesson => {
              const unit = stats.byLesson[lesson.id];
              return `
                <div class="detail-unit">
                  <div class="detail-unit-head"><strong>L${lesson.num} ${esc(lesson.title)}</strong>${levelBadge(unit.level)}</div>
                  ${pbar(unit.pct)}
                  <div class="chips">${coreMissions.map(mission => `<span class="chip ${unit.flags[mission.code] ? 'on' : ''}" title="${esc(mission.ko)}">${esc(mission.code)}</span>`).join('')}</div>
                  <div class="source-note">${unit.reported ? `학생 보고 · ${esc(formatDateTime(unit.reportAt))}` : '기초 평가 기록'} · ${unit.count}/${state.seed.missions.length} 미션</div>
                </div>`;
            }).join('')}
          </div>
          <div class="section-head" style="margin:20px 0 0">
            <div><h3>미션 달성 매트릭스</h3><p>11개 미션 × 6개 단원의 달성 여부입니다.</p></div>
          </div>
          <div class="matrix-wrap">
            <table class="matrix">
              <thead><tr><th>미션</th>${state.seed.lessons.map(lesson => `<th>L${lesson.num}</th>`).join('')}</tr></thead>
              <tbody>
                ${state.seed.missions.map(mission => `
                  <tr>
                    <td class="mission-name">${esc(mission.code)} · ${esc(mission.ko)}</td>
                    ${state.seed.lessons.map(lesson => {
                      const on = stats.byLesson[lesson.id].flags[mission.code];
                      return `<td><div class="cell ${on ? 'on' : ''}" title="${esc(mission.ko)} ${on ? '달성' : '미달성'}">${on ? 'O' : '·'}</div></td>`;
                    }).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

function showToast(title, message = '', type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<strong>${esc(title)}</strong>${message ? esc(message) : ''}`;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

function fingerprintOf(reports) {
  const times = Object.values(reports).map(report => report.updatedAt).sort().join('|');
  return `${Object.keys(reports).length}#${times}`;
}

function classFingerprintOf(standings) {
  return (standings || [])
    .map(item => `${item.id}:${Number(item.progress).toFixed(2)}:${Number(item.avgLevel).toFixed(2)}:${Number(item.reported).toFixed(0)}`)
    .join('|');
}

function setLastSyncLabel() {
  const el = document.getElementById('last-sync');
  if (el && state.lastSync) el.textContent = formatClock(state.lastSync);
}

async function loadStudentState(options = {}) {
  const { initial = false } = options;
  if (!state.auth.token || state.auth.role !== 'student') return false;
  state.loadingState = true;
  try {
    const response = await apiFetch('/api/student/state');
    if (!response.ok) throw new Error('학생 데이터를 불러오지 못했습니다.');
    const payload = await response.json();
    const nextFingerprint = fingerprintOf(payload.reports || {});
    const nextClassFingerprint = classFingerprintOf(payload.classStandings || []);
    const changed = nextFingerprint !== state.reportFingerprint || nextClassFingerprint !== state.classFingerprint;

    state.seed = payload.seed;
    state.reports = payload.reports || {};
    state.classStandings = payload.classStandings || [];
    state.serverTime = payload.serverTime;
    state.lastSync = new Date();
    state.loadError = null;
    state.reportFingerprint = nextFingerprint;
    state.classFingerprint = nextClassFingerprint;
    state.auth.studentId = payload.seed.studentId;
    state.selectedStudentId = payload.seed.studentId;
    invalidate();

    const student = studentById(payload.seed.studentId);
    if (initial) {
      const stats = computed().perStudent[payload.seed.studentId];
      const savedLesson = localStorage.getItem(LS_LESSON);
      const fallback = [...state.seed.lessons].reverse().find(lesson => stats.byLesson[lesson.id].count > 0);
      state.selectedLessonId = savedLesson && stats.byLesson[savedLesson]
        ? savedLesson
        : (fallback ? fallback.id : state.seed.lessons[0].id);
      state.selectedClass = student ? student.classId : state.authClass;
      state.view = 'studentHome';
    } else {
      setLastSyncLabel();
      const active = document.activeElement;
      const typing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
      if (changed && !typing && !state.saving) {
        render(true);
        renderModal();
      }
    }
    return true;
  } catch (error) {
    if (error.message === 'UNAUTHORIZED') return false;
    state.loadError = error.message || '데이터를 불러오지 못했습니다.';
    if (initial) render();
    return false;
  } finally {
    state.loadingState = false;
  }
}

async function loadTeacherState(options = {}) {
  const { initial = false } = options;
  if (!state.auth.token || state.auth.role !== 'teacher') return false;
  state.loadingState = true;
  try {
    const response = await apiFetch('/api/teacher/state');
    if (!response.ok) throw new Error('교사 데이터를 불러오지 못했습니다.');
    const payload = await response.json();
    const nextFingerprint = fingerprintOf(payload.reports || {});
    const changed = nextFingerprint !== state.reportFingerprint;

    state.seed = payload.seed;
    state.reports = payload.reports || {};
    state.codes = payload.codes || null;
    state.serverTime = payload.serverTime;
    state.lastSync = new Date();
    state.loadError = null;
    state.reportFingerprint = nextFingerprint;
    state.classFingerprint = '';
    state.selectedStudentId = null;
    invalidate();

    if (initial) {
      state.view = 'teacher';
    } else {
      setLastSyncLabel();
      const active = document.activeElement;
      const typing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
      if (changed && !typing && !state.saving) {
        render(true);
        renderModal();
      }
    }
    return true;
  } catch (error) {
    if (error.message === 'UNAUTHORIZED') return false;
    state.loadError = error.message || '데이터를 불러오지 못했습니다.';
    if (initial) render();
    return false;
  } finally {
    state.loadingState = false;
  }
}

async function toggleMission(studentId, lessonId, code) {
  if (state.saving || state.auth.role !== 'student' || state.auth.studentId !== studentId) return;
  const student = studentById(studentId);
  const mission = missionOf(code);
  if (!student || !mission) return;
  const current = flagsFor(studentId, lessonId);
  const nextValue = current[code] ? 0 : 1;
  const nextFlags = { ...current, [code]: nextValue };
  const key = reportKey(studentId, lessonId);
  const previous = state.reports[key] || null;
  const optimistic = {
    studentId, lessonId, missions: nextFlags,
    note: previous ? previous.note || '' : '',
    studentName: student.name, classId: student.classId,
    updatedAt: new Date().toISOString(), source: 'student'
  };
  state.reports[key] = optimistic;
  state.saving = true;
  invalidate();
  render(true);

  try {
    const response = await apiFetch('/api/student/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId, missions: nextFlags, note: optimistic.note })
    });
    if (!response.ok) {
      let message = '보고 저장에 실패했습니다.';
      try {
        const errorPayload = await response.json();
        if (errorPayload.error) message = errorPayload.error;
      } catch (error) { /* ignore */ }
      throw new Error(message);
    }
    const payload = await response.json();
    state.reports[key] = payload.report;
    state.lastSync = new Date();
    state.reportFingerprint = fingerprintOf(state.reports);
    invalidate();
    showToast(
      `${student.name} · ${mission.ko}`,
      nextValue ? `${levelName(levelFromFlags(nextFlags))} 단계 통과를 보고했어요.` : '통과 보고를 취소했어요.',
      nextValue ? 'success' : ''
    );
  } catch (error) {
    if (error.message === 'UNAUTHORIZED') {
      state.saving = false;
      return;
    }
    if (previous) state.reports[key] = previous;
    else delete state.reports[key];
    invalidate();
    showToast('저장에 실패했어요', '네트워크 연결을 확인한 뒤 다시 시도해 주세요.', 'error');
  } finally {
    state.saving = false;
    render(true);
    renderModal();
  }
}

function selectStudent(studentId) {
  const student = studentById(studentId);
  if (!student) return;
  const stats = computed().perStudent[studentId];
  const savedLesson = localStorage.getItem(LS_LESSON);
  const fallback = [...state.seed.lessons].reverse().find(lesson => stats.byLesson[lesson.id].count > 0);
  state.selectedStudentId = studentId;
  state.selectedClass = student.classId;
  state.selectedLessonId = savedLesson && stats.byLesson[savedLesson] ? savedLesson : (fallback ? fallback.id : state.seed.lessons[0].id);
  localStorage.setItem(LS_STUDENT, studentId);
  localStorage.setItem(LS_CLASS, String(student.classId));
  localStorage.setItem(LS_LESSON, state.selectedLessonId);
  state.view = 'studentHome';
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch (error) {
    const area = document.createElement('textarea');
    area.value = String(text);
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) { /* ignore */ }
    area.remove();
    return ok;
  }
}

function exportCodesCsv() {
  if (!state.codes) return;
  const rows = [['반', '번호', '이름', '개인 입장 코드']];
  const students = [...state.codes.students]
    .sort((a, b) => a.classId - b.classId || a.no - b.no);
  for (const student of students) {
    rows.push([student.className, student.no, student.name, student.code]);
  }
  const escapeCell = value => {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = rows.map(row => row.map(escapeCell).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `LAON_학생_입장코드_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('코드 CSV 다운로드', '학생별 개인 입장 코드를 저장했습니다.', 'success');
}

function exportCsv() {
  const rows = [['반', '번호', '이름', '단원', '단원명', '도달레벨', '티어', '미션달성수', '진도율(%)', ...state.seed.missions.map(mission => mission.code), '보고시각', '출처']];
  for (const student of state.seed.students) {
    for (const lesson of state.seed.lessons) {
      const flags = flagsFor(student.id, lesson.id);
      const level = levelFromFlags(flags);
      const count = missionCount(flags);
      const report = reportFor(student.id, lesson.id);
      rows.push([
        classById(student.classId).name, student.no, student.name, lesson.id, lesson.title,
        level, levelName(level), count, ((count / state.seed.missions.length) * 100).toFixed(1),
        ...state.seed.missions.map(mission => (flags[mission.code] ? 1 : 0)),
        report ? formatDateTime(report.updatedAt) : '', report ? '학생 보고' : '기초 기록'
      ]);
    }
  }
  const escapeCell = value => {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = rows.map(row => row.map(escapeCell).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `LAON_레벨업_평가기록_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('CSV 다운로드', '학생별·단원별 전체 기록을 저장했습니다.', 'success');
}

function render(preserveScroll = false) {
  const scrollY = window.scrollY;
  if (state.view === 'auth') {
    appEl.innerHTML = renderAuth();
    if (preserveScroll) window.scrollTo({ top: scrollY, behavior: 'auto' });
    modalRoot.innerHTML = '';
    return;
  }
  if (state.loadError) {
    appEl.innerHTML = `
      <div class="error-screen">
        <div>
          <h2>데이터를 불러오지 못했습니다</h2>
          <p>${esc(state.loadError)}<br>서버가 실행 중인지 확인한 뒤 다시 시도해 주세요.</p>
          <button class="btn btn-primary" style="margin-top:18px" data-action="refresh">다시 시도</button>
        </div>
      </div>`;
    return;
  }
  if (!state.seed) {
    appEl.innerHTML = `<div class="error-screen"><div><h2>레벨업 챌린지를 불러오는 중입니다</h2><p>잠시만 기다려 주세요.</p></div></div>`;
    return;
  }
  if (state.view === 'studentHome' && state.auth.role === 'student') appEl.innerHTML = renderStudentHome();
  else if (state.view === 'teacher' && state.auth.role === 'teacher') appEl.innerHTML = renderTeacher();
  else if (state.view === 'studentPick' && state.auth.role === 'student') appEl.innerHTML = renderStudentPick();
  else {
    state.view = 'auth';
    appEl.innerHTML = renderAuth();
  }

  if (preserveScroll) window.scrollTo({ top: scrollY, behavior: 'auto' });
  renderModal();
}

document.addEventListener('click', async event => {
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;

  if (actionEl.dataset.action === 'close-modal') {
    if (!actionEl.classList.contains('modal-close') && event.target.closest('.modal')) return;
    state.detailStudentId = null;
    renderModal();
    return;
  }

  const action = actionEl.dataset.action;

  if (action === 'go-home') {
    state.detailStudentId = null;
    if (state.auth.role === 'teacher') {
      state.view = 'teacher';
      state.teacherTab = 'overview';
    } else if (state.auth.role === 'student') {
      state.view = 'studentHome';
    } else {
      state.view = 'auth';
      state.authStage = 'role';
    }
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  if (action === 'mode-student') {
    if (state.auth.role === 'student') {
      state.view = 'studentHome';
      render();
    } else {
      state.view = 'auth';
      state.authStage = 'student';
      state.authError = '';
      render();
      loadBootstrap().then(() => render());
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  if (action === 'mode-teacher') {
    if (state.auth.role === 'teacher') {
      state.view = 'teacher';
      render();
    } else {
      state.view = 'auth';
      state.authStage = 'teacher';
      state.authError = '';
      render();
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  if (action === 'resume-student') {
    if (state.auth.role === 'student') {
      state.view = 'studentHome';
      render();
      window.scrollTo({ top: 0, behavior: 'auto' });
    } else {
      state.view = 'auth';
      state.authStage = 'student';
      render();
      loadBootstrap().then(() => render());
    }
    return;
  }

  if (action === 'change-student') {
    await logout();
    return;
  }

  if (action === 'auth-role-student') {
    state.view = 'auth';
    state.authStage = 'student';
    state.authError = '';
    state.authCode = '';
    state.authStudentId = null;
    render();
    loadBootstrap().then(() => render());
    return;
  }

  if (action === 'auth-role-teacher') {
    state.view = 'auth';
    state.authStage = 'teacher';
    state.authError = '';
    state.authCode = '';
    state.authStudentId = null;
    render();
    return;
  }

  if (action === 'auth-back') {
    state.authStage = 'role';
    state.authError = '';
    state.authCode = '';
    state.authStudentId = null;
    render();
    return;
  }

  if (action === 'auth-class') {
    state.authClass = Number(actionEl.dataset.class);
    state.authStudentId = null;
    state.authError = '';
    render(true);
    return;
  }

  if (action === 'auth-select-student') {
    state.authStudentId = actionEl.dataset.student;
    state.authError = '';
    render();
    focusAuthCode();
    return;
  }

  if (action === 'auth-login-student') {
    await loginStudent();
    return;
  }

  if (action === 'auth-login-teacher') {
    await loginTeacher();
    return;
  }

  if (action === 'logout') {
    await logout();
    return;
  }

  if (action === 'select-class') {
    state.selectedClass = Number(actionEl.dataset.class);
    localStorage.setItem(LS_CLASS, String(state.selectedClass));
    render(true);
    return;
  }

  if (action === 'select-student') {
    selectStudent(actionEl.dataset.student);
    return;
  }

  if (action === 'select-lesson') {
    state.selectedLessonId = actionEl.dataset.lesson;
    localStorage.setItem(LS_LESSON, state.selectedLessonId);
    render(true);
    return;
  }

  if (action === 'toggle-mission') {
    await toggleMission(actionEl.dataset.student, actionEl.dataset.lesson, actionEl.dataset.code);
    return;
  }

  if (action === 'teacher-tab') {
    state.teacherTab = actionEl.dataset.tab;
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  if (action === 'focus-class') {
    state.classFocus = Number(actionEl.dataset.class);
    render(true);
    return;
  }

  if (action === 'class-unit') {
    state.classUnit = actionEl.dataset.unit;
    render(true);
    return;
  }

  if (action === 'unit-focus') {
    state.unitFocus = actionEl.dataset.unit;
    render(true);
    return;
  }

  if (action === 'open-student') {
    state.detailStudentId = actionEl.dataset.student;
    renderModal();
    return;
  }

  if (action === 'refresh') {
    if (!state.auth.token) {
      state.view = 'auth';
      render();
      return;
    }
    state.refreshing = true;
    render(true);
    const ok = state.auth.role === 'teacher'
      ? await loadTeacherState()
      : await loadStudentState();
    state.refreshing = false;
    if (ok) {
      invalidate();
      render(true);
      showToast('새로고침 완료', '최신 기록을 불러왔습니다.', 'success');
    } else {
      render(true);
      showToast('새로고침 실패', '서버 연결을 확인해 주세요.', 'error');
    }
    return;
  }

  if (action === 'export-csv') {
    if (state.auth.role === 'teacher') exportCsv();
    return;
  }

  if (action === 'export-codes') {
    if (state.auth.role === 'teacher') exportCodesCsv();
    return;
  }

  if (action === 'copy-code' || action === 'copy-teacher-code') {
    const ok = await copyText(actionEl.dataset.code || '');
    showToast(ok ? '복사 완료' : '복사 실패', ok ? '입장 코드를 클립보드에 복사했습니다.' : '직접 선택해 복사해 주세요.', ok ? 'success' : 'error');
    return;
  }

  if (action === 'regenerate-code') {
    if (state.auth.role !== 'teacher') return;
    const studentId = actionEl.dataset.student;
    const name = actionEl.dataset.name || '학생';
    if (!window.confirm(`${name} 학생의 입장 코드를 재발급할까요? 이전 코드는 즉시 사용할 수 없게 됩니다.`)) return;
    try {
      const response = await apiFetch('/api/teacher/codes/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '코드 재발급에 실패했습니다.');
      const target = state.codes && state.codes.students.find(student => student.id === studentId);
      if (target) target.code = payload.code;
      render(true);
      showToast('코드 재발급 완료', `${name} 학생의 새 입장 코드를 확인해 주세요.`, 'success');
    } catch (error) {
      if (error.message === 'UNAUTHORIZED') return;
      showToast('코드 재발급 실패', '서버 연결을 확인해 주세요.', 'error');
    }
  }
});

document.addEventListener('change', event => {
  const target = event.target.closest('[data-change]');
  if (!target) return;
  if (target.dataset.change === 'teacher-class') {
    state.teacherClassFilter = target.value;
    updateIndividualTable();
  } else if (target.dataset.change === 'teacher-sort') {
    state.teacherSort = target.value;
    updateIndividualTable();
  }
});

document.addEventListener('input', event => {
  const target = event.target.closest('[data-input]');
  if (!target) return;
  if (target.dataset.input === 'auth-code') {
    state.authCode = target.value;
    return;
  }
  if (target.dataset.input === 'teacher-search') {
    state.teacherSearch = target.value;
    updateIndividualTable();
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.detailStudentId) {
    state.detailStudentId = null;
    renderModal();
    return;
  }
  if (event.key === 'Enter' && event.target.id === 'auth-code') {
    event.preventDefault();
    loginStudent();
  } else if (event.key === 'Enter' && event.target.id === 'auth-teacher-code') {
    event.preventDefault();
    loginTeacher();
  }
});

async function init() {
  const savedClass = Number(localStorage.getItem(LS_CLASS));
  if (savedClass >= 1 && savedClass <= 6) {
    state.selectedClass = savedClass;
    state.authClass = savedClass;
  }

  const token = sessionStorage.getItem(SS_TOKEN);
  const role = sessionStorage.getItem(SS_ROLE);
  const studentId = sessionStorage.getItem(SS_STUDENT);

  if (token && (role === 'teacher' || role === 'student')) {
    state.auth = {
      role,
      token,
      studentId: role === 'student' ? studentId : null
    };
    state.view = role === 'teacher' ? 'teacher' : 'studentHome';
    const loaded = role === 'teacher'
      ? await loadTeacherState({ initial: true })
      : await loadStudentState({ initial: true });
    if (loaded) {
      render();
    } else if (!state.auth.token) {
      render();
    } else {
      clearAuth('세션을 확인할 수 없습니다. 다시 로그인해 주세요.');
    }
  } else {
    clearAuth('', false);
    state.view = 'auth';
    state.authStage = 'role';
    render();
    loadBootstrap().then(ok => {
      if (ok && state.view === 'auth') render();
    });
  }

  setInterval(async () => {
    if (!state.auth.token || state.loadingState || state.saving || state.authBusy) return;
    if (state.view === 'auth') return;
    if (state.auth.role === 'teacher') await loadTeacherState();
    else if (state.auth.role === 'student') await loadStudentState();
  }, 20000);
}

document.addEventListener('DOMContentLoaded', init);
