// public/app.js
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- elements ---------- */
const nav = $('#nav');
const navTabs = $('#navTabs');
const navUser = $('#navUser');
const who = $('#who');
const avatar = $('#avatar');
const navAdmin = $('#navAdmin');
const logoutBtn = $('#logoutBtn');
const themeBtn = $('#themeBtn');

const loginSection = $('#loginSection');
const registerSection = $('#registerSection');
const projectsPage = $('#projectsPage');
const problemPage = $('#problemPage');
const subsPage = $('#subsPage');
const adminPage = $('#adminPage');

const loginForm = $('#loginForm');
const loginMsg = $('#loginMsg');
const loginBtn = $('#loginBtn');
const gotoRegister = $('#gotoRegister');
const regForm = $('#regForm');
const regMsg = $('#regMsg');
const regBtn = $('#regBtn');
const backToLogin = $('#backToLogin');

const projSelect = $('#projSelect');
const projTitle = $('#projTitle');
const projStats = $('#projStats');
const problemsWrap = $('#problemsWrap');

const backToProjects = $('#backToProjects');
const pbHeader = $('#pbHeader');
const pbChip = $('#pbChip');
const pdfFrame = $('#pdfFrame');
const pdfOpenNew = $('#pdfOpenNew');
const langSel = $('#langSel');
const codeFile = $('#codeFile');
const useFile = $('#useFile');
const editorMount = $('#editorMount');
const draftNote = $('#draftNote');
const submitBtn = $('#submitBtn');
const submitMsg = $('#submitMsg');
const resultBox = $('#resultBox');
const runBtn = $('#runBtn');
const runInput = $('#runInput');
const runMsg = $('#runMsg');
const runResultBox = $('#runResultBox');

const subsWrap = $('#subsWrap');
const subsStats = $('#subsStats');
const subsFilter = $('#subsFilterSel');

const projName = $('#projName');
const projSlug = $('#projSlug');
const projEnabled = $('#projEnabled');
const createProj = $('#createProj');
const projList = $('#projList');
const pbList = $('#pbList');
const pbTitle = $('#pbTitle');
const pbProject = $('#pbProject');
const pbTests = $('#pbTests');
const pbPdf = $('#pbPdf');
const createPb = $('#createPb');
const userList = $('#userList');
const allSubs = $('#allSubs');
const subsCount = $('#subsCount');
const subsSearch = $('#subsSearch');
const moreSubs = $('#moreSubs');
const adminTabs = $('#adminTabs');

/* ---------- state ---------- */
let editor = null;
let editorLang = 'cpp';
let currentProblem = null;
let me = null;
let mySubs = [];
let problemTitles = new Map();
let subsFilterValue = 'all';
let lastSavedCode = null;
let adminSubs = [];
let adminShown = 40;
const adminProblemTitles = new Map();
const adminProblemRevs = new Map();

const TEMPLATES = {
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n  \n  return 0;\n}\n',
  py: '# เขียนโค้ด Python ที่นี่\n'
};
const STATUS = {
  green: { label: 'ผ่านครบ', cls: 'green' },
  yellow: { label: 'ผ่านบางส่วน', cls: 'yellow' },
  red: { label: 'ไม่ผ่าน', cls: 'red' },
  gray: { label: 'คอมไพล์ไม่ผ่าน', cls: 'gray' }
};

/* ---------- helpers ---------- */
// The server rate-limits to 5 requests/second per client; back off and retry on 429.
async function api(path, opt = {}, tries = 4) {
  try {
    const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opt });
    if (r.status === 429) {
      const j = await r.json().catch(() => null);                      // the global limiter answers with plain text, the login limiter with JSON
      if (j?.error === 'too_many_attempts') return j;                  // a lockout, not a burst: retrying only makes it worse
      if (tries > 1) { await sleep(1100); return api(path, opt, tries - 1); }
      return j || { ok: false, error: 'rate_limited' };
    }
    const j = await r.json();
    if (r.status === 401 && me && path !== '/api/me') {                // session expired / account removed while the page was open
      me = null;
      toast('หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่', 'bad');
      showNav(false);
      showOnly('#loginSection');
    }
    return j;
  } catch (e) {
    return { ok: false, error: 'network' };
  }
}
// readable text for the errors the grading endpoints can return
const GRADE_ERR = {
  busy: 'มีงานของคุณกำลังตรวจอยู่ รอให้เสร็จก่อนแล้วลองใหม่',
  queue_full: 'ตอนนี้มีคนส่งงานจำนวนมาก ลองใหม่อีกครั้งในอีกสักครู่',
  problem_not_found: 'ไม่พบโจทย์นี้ (อาจถูกปิดหรือลบไปแล้ว)',
  problem_has_no_tests: 'โจทย์นี้ยังไม่มีเทสต์เคส',
  rate_limited: 'ส่งคำขอถี่เกินไป ลองใหม่อีกครั้ง',
  network: 'เครือข่ายล้มเหลว ลองใหม่อีกครั้ง'
};
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3500);
}
const chip = (st, text) => `<span class="chip ${STATUS[st]?.cls || 'gray'}">${esc(text ?? STATUS[st]?.label ?? st)}</span>`;
const fmtDate = ts => new Date(ts).toLocaleString('th-TH');
function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'เมื่อสักครู่';
  const m = Math.round(s / 60); if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60); if (h < 24) return `${h} ชั่วโมงที่แล้ว`;
  const d = Math.round(h / 24); if (d < 30) return `${d} วันที่แล้ว`;
  return new Date(ts).toLocaleDateString('th-TH');
}
const emptyState = text => `<div class="empty">${esc(text)}</div>`;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };

window.addEventListener('error', e => {
  console.error(e?.error || e);
  toast('ข้อผิดพลาด: ' + (e?.error?.message || e.message || 'ไม่ทราบสาเหตุ'), 'bad');
});

/* ---------- theme ---------- */
const ICON_SUN = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_MOON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function applyTheme(t, persist) {
  document.documentElement.setAttribute('data-theme', t);
  themeBtn.innerHTML = t === 'dark' ? ICON_SUN : ICON_MOON;
  if (persist) lsSet('grader:theme', t);
  if (editor && window.setEditorTheme && editor.__themeComp) window.setEditorTheme(editor, t === 'dark');
}
themeBtn.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
});
applyTheme(document.documentElement.getAttribute('data-theme') || 'light', false);

/* ---------- navigation ---------- */
const SECTIONS = [loginSection, registerSection, projectsPage, problemPage, subsPage, adminPage];
const PAGE_TAB = { '#projectsPage': 'projects', '#problemPage': 'projects', '#subsPage': 'subs', '#adminPage': 'admin' };
function showOnly(sel) {
  SECTIONS.forEach(x => x.classList.add('hidden'));
  if (sel) $(sel).classList.remove('hidden');
  $$('#navTabs .tab').forEach(t => t.classList.toggle('active', (t.dataset.goto || 'admin') === PAGE_TAB[sel]));
  window.scrollTo(0, 0);
}
function showNav(on) {
  [navTabs, navUser].forEach(el => { el.classList.toggle('hidden', !on); el.classList.toggle('flex', on); });
}

async function init() {
  const r = await api('/api/me');
  me = r.user || null;
  if (!me) { showNav(false); showOnly('#loginSection'); return; }
  who.textContent = me.username + (me.isAdmin ? ' · admin' : '');
  avatar.textContent = (me.username || '?').slice(0, 1);
  navAdmin.classList.toggle('hidden', !me.isAdmin);
  showNav(true);
  await loadProjects();
  showOnly('#projectsPage');
}
init();

/* ---------- login / register ---------- */
gotoRegister.addEventListener('click', () => showOnly('#registerSection'));
backToLogin.addEventListener('click', () => showOnly('#loginSection'));

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  loginMsg.textContent = '';
  loginBtn.disabled = true;
  const fd = new FormData(loginForm);
  const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) });
  loginBtn.disabled = false;
  if (!r.ok) {
    loginMsg.textContent = r.error === 'network' ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'
      : r.error === 'too_many_attempts' ? 'ลองผิดหลายครั้งเกินไป รอสักครู่ (ประมาณ 15 นาที) แล้วลองใหม่'
      : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
    return;
  }
  loginForm.reset();
  init();
});
regForm.addEventListener('submit', async e => {
  e.preventDefault();
  regMsg.textContent = '';
  regBtn.disabled = true;
  const fd = new FormData(regForm);
  const r = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password'), confirm: fd.get('confirm') }) });
  regBtn.disabled = false;
  if (!r.ok) {
    regMsg.textContent = ({
      password_need_digit: 'รหัสผ่านต้องมีตัวเลขอย่างน้อย 1 ตัว',
      password_mismatch: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน',
      username_taken: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว',
      missing_fields: 'กรอกข้อมูลให้ครบ',
      invalid_fields: 'ชื่อผู้ใช้ยาวได้ไม่เกิน 32 ตัวอักษร และรหัสผ่านไม่เกิน 72 ตัวอักษร',
      too_many_attempts: 'สมัครบ่อยเกินไป ลองใหม่ภายหลัง',
      network: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'
    })[r.error] || 'สมัครไม่สำเร็จ';
    return;
  }
  regForm.reset();
  init();
});
logoutBtn.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});

$$('#navTabs [data-goto]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const to = btn.getAttribute('data-goto');
    if (to === 'projects') { showOnly('#projectsPage'); await loadProjects(); }
    if (to === 'subs') { showOnly('#subsPage'); await loadMySubs(); }
  });
});
navAdmin.addEventListener('click', async () => { showOnly('#adminPage'); await renderAdmin(); });

/* ---------- my submissions summary ---------- */
async function refreshMySubs() {
  const r = await api('/api/my/submissions');
  if (r.ok) mySubs = r.submissions;
}
// problem id -> { title, testsRev, testCount } for every problem the page has loaded
const problemInfo = new Map();
const rememberProblems = list => list.forEach(p => problemInfo.set(p.id, { title: p.title, testsRev: p.testsRev || 0, testCount: p.testCount ?? (p.tests || []).length }));
// A submission counts only if it was graded against the problem's *current* tests. After an admin edits the test cases, older
// results (and their stored "x/total") describe a different test set, so they are kept in the history but not mixed into the score.
// Unknown problems (closed project, deleted) can't be compared, so their submissions count as they are.
function isCurrent(s) {
  const info = problemInfo.get(s.problemId);
  return !info || (s.testsRev || 0) === info.testsRev;
}
function summarize() {
  const m = new Map();
  for (const s of mySubs) { // newest first
    let e = m.get(s.problemId);
    if (!e) {
      e = { attempts: 0, stale: 0, best: 0, total: problemInfo.get(s.problemId)?.testCount ?? s.total, green: false, last: null };
      m.set(s.problemId, e);
    }
    if (!isCurrent(s)) { e.stale++; continue; }
    e.attempts++;
    e.best = Math.max(e.best, s.pass);
    e.total = problemInfo.get(s.problemId)?.testCount ?? (s.total || e.total);
    if (s.status === 'green') e.green = true;
    if (!e.last) e.last = s;
  }
  return m;
}
function entryStatus(e) {
  if (!e || !e.attempts) return null;
  if (e.green) return 'green';
  if (e.best > 0) return 'yellow';
  return e.last?.status === 'gray' ? 'gray' : 'red';
}

/* ---------- projects ---------- */
async function loadProjects() {
  const r = await api('/api/projects');
  const opened = r.ok ? r.projects.filter(p => p.enabled) : [];
  const prev = projSelect.value;
  projSelect.innerHTML = opened.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.slug)})</option>`).join('');
  if (prev && opened.some(p => p.id === prev)) projSelect.value = prev;
  await loadProblemsBySelectedProject();
}
projSelect.addEventListener('change', loadProblemsBySelectedProject);

async function loadProblemsBySelectedProject() {
  const pid = projSelect.value;
  if (!pid) {
    projStats.textContent = '';
    problemsWrap.innerHTML = emptyState('ยังไม่มีโปรเจกต์ที่เปิดใช้งาน');
    return;
  }
  problemsWrap.innerHTML = emptyState('กำลังโหลด...');
  const r = await api(`/api/problems/byProject?projectId=${encodeURIComponent(pid)}`);
  await refreshMySubs();
  if (!r.ok) { problemsWrap.innerHTML = emptyState('โหลดโจทย์ไม่สำเร็จ ลองใหม่อีกครั้ง'); return; }

  r.problems.forEach(pb => problemTitles.set(pb.id, pb.title));
  rememberProblems(r.problems);   // before summarize(): it compares each submission's test revision with the problem's current one
  const sum = summarize();
  const solved = r.problems.filter(pb => sum.get(pb.id)?.green).length;
  const attempts = r.problems.reduce((a, pb) => a + (sum.get(pb.id)?.attempts || 0), 0);
  projTitle.textContent = projSelect.selectedOptions[0]?.textContent.replace(/\s*\(.*\)$/, '') || 'โจทย์';
  projStats.textContent = `${r.problems.length} ข้อ · ผ่านครบ ${solved} ข้อ · ส่งแล้ว ${attempts} ครั้ง`;

  if (!r.problems.length) { problemsWrap.innerHTML = emptyState('โปรเจกต์นี้ยังไม่มีโจทย์'); return; }
  const table = document.createElement('table');
  table.className = 'tbl';
  table.innerHTML = '<thead><tr><th>#</th><th>ชื่อโจทย์</th><th>สถานะ</th><th>คะแนนดีที่สุด</th><th></th></tr></thead><tbody></tbody>';
  const tbody = table.querySelector('tbody');
  r.problems.forEach((pb, i) => {
    const e = sum.get(pb.id);
    const st = entryStatus(e);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="num">${i + 1}</td>
      <td><button class="font-semibold text-left" data-act="open">${esc(pb.title)}</button>
          <div class="muted text-xs">${pb.testCount ?? (pb.tests || []).length} เทสต์เคส · เวลา ${esc(pb.timeLimitMs ?? 2000)} ms · หน่วยความจำ ${esc(pb.memLimitMB ?? 256)} MB</div></td>
      <td>${st ? chip(st) : e?.stale ? '<span class="muted text-sm" title="แอดมินแก้เทสต์เคสหลังจากที่คุณส่งไว้">เทสต์เปลี่ยน ส่งใหม่</span>' : '<span class="muted text-sm">ยังไม่ส่ง</span>'}</td>
      <td class="text-sm">${e?.attempts ? `${e.best}/${e.total} <span class="muted">(ส่ง ${e.attempts} ครั้ง)</span>` : `<span class="muted">-/${esc(pb.testCount ?? '')}</span>`}</td>
      <td class="text-right whitespace-nowrap">
        <a class="link text-sm mr-3" href="${esc(pb.pdfUrl)}" target="_blank" rel="noopener">PDF</a>
        <button class="btn btn-primary btn-sm" data-act="open2">ทำโจทย์</button>
      </td>`;
    tr.querySelector('[data-act="open"]').addEventListener('click', () => openProblem(pb));
    tr.querySelector('[data-act="open2"]').addEventListener('click', () => openProblem(pb));
    tbody.appendChild(tr);
  });
  problemsWrap.innerHTML = '';
  problemsWrap.appendChild(table);
}

/* ---------- problem page / editor ---------- */
const draftKey = id => `grader:draft:${id}`;
function loadDraft(id) { try { return JSON.parse(lsGet(draftKey(id)) || 'null'); } catch (e) { return null; } }
function getCode() { return editor ? editor.state.doc.toString() : ''; }
function setCode(text) { if (editor) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }); }
function saveDraft() {
  if (!currentProblem || !editor || problemPage.classList.contains('hidden')) return;
  const code = getCode();
  if (code === lastSavedCode) return;
  lsSet(draftKey(currentProblem.id), JSON.stringify({ lang: editorLang, code, at: Date.now() }));
  lastSavedCode = code;
  draftNote.textContent = 'บันทึกแบบร่างแล้ว';
}
setInterval(saveDraft, 2500);
window.addEventListener('beforeunload', saveDraft);

function makeFallbackEditor(mount, doc) {
  mount.innerHTML = '';
  mount.classList.add('editor-wrap');
  const ta = document.createElement('textarea');
  ta.className = 'fallback'; ta.value = doc; ta.spellcheck = false;
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
  });
  mount.appendChild(ta);
  return {
    state: { doc: { toString: () => ta.value, get length() { return ta.value.length; } } },
    dispatch(spec) { if (spec && spec.changes) ta.value = spec.changes.insert; }
  };
}

function renderPbChip() {
  const e = currentProblem ? summarize().get(currentProblem.id) : null;
  const st = entryStatus(e);
  const tc = currentProblem?.testCount;
  pbChip.innerHTML = st ? chip(st) + `<span class="muted text-sm ml-2">ดีที่สุด ${e.best}/${e.total}</span>`
    : `<span class="chip gray">ยังไม่ส่ง</span>${tc != null ? `<span class="muted text-sm ml-2">${tc} เทสต์</span>` : ''}${e?.stale ? '<span class="muted text-sm ml-2">· เทสต์เคสถูกแก้ไข ผลที่ส่งไว้ก่อนหน้าไม่นับ</span>' : ''}`;
}

async function openProblem(pb) {
  saveDraft();
  currentProblem = pb;
  pbHeader.textContent = pb.title;
  pdfFrame.src = pb.pdfUrl;
  pdfOpenNew.href = pb.pdfUrl;
  submitMsg.textContent = '';
  resultBox.innerHTML = '';
  draftNote.textContent = '';
  runMsg.textContent = '';
  runResultBox.innerHTML = '';
  runInput.value = '';
  renderPbChip();
  showOnly('#problemPage');

  const draft = loadDraft(pb.id);
  editorLang = (draft && TEMPLATES[draft.lang]) ? draft.lang : editorLang;
  langSel.value = editorLang;
  const initial = draft && typeof draft.code === 'string' ? draft.code : TEMPLATES[editorLang];
  if (draft) draftNote.textContent = 'กู้คืนแบบร่างล่าสุด';

  await Promise.race([window.cmReady, sleep(8000)]);
  try {
    editor = window.buildEditor ? window.buildEditor(editorMount, editorLang, initial) : makeFallbackEditor(editorMount, initial);
  } catch (e) {
    console.warn('editor init failed, using textarea', e);
    editor = makeFallbackEditor(editorMount, initial);
  }
  lastSavedCode = initial;
}
backToProjects.addEventListener('click', async () => {
  saveDraft();
  showOnly('#projectsPage');
  await loadProblemsBySelectedProject();
});

langSel.addEventListener('change', () => {
  const prev = editorLang;
  editorLang = langSel.value;
  if (!editor) return;
  const cur = getCode();
  if (cur.trim() === '' || cur === TEMPLATES[prev]) setCode(TEMPLATES[editorLang]);
  if (window.switchLanguage && editor.__langComp) window.switchLanguage(editor, editorLang);
  saveDraft();
});

useFile.addEventListener('click', () => codeFile.click());
codeFile.addEventListener('change', async () => {
  const f = codeFile.files?.[0];
  if (!f || !editor) return;
  setCode(await f.text());
  if (/\.py$/i.test(f.name) && editorLang !== 'py') { langSel.value = 'py'; langSel.dispatchEvent(new Event('change')); }
  if (/\.(cpp|cc|c)$/i.test(f.name) && editorLang !== 'cpp') { langSel.value = 'cpp'; langSel.dispatchEvent(new Event('change')); }
  codeFile.value = '';
  toast(`นำเข้า ${f.name} แล้ว`, 'ok');
});

// Ctrl/Cmd + Enter submits (capture phase so the editor doesn't swallow it)
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !problemPage.classList.contains('hidden')) {
    e.preventDefault(); e.stopPropagation();
    if (!submitBtn.disabled) submitBtn.click();
  }
}, true);

const cleanLog = log => String(log || '')
  .replace(/(?:[A-Za-z]:)?[^\s:'"()]*[\\/]main\.(cpp|py)/g, 'main.$1')
  .slice(0, 4000);

function renderResult(sub) {
  const st = sub.status;
  const pct = sub.total ? Math.round(sub.pass / sub.total * 100) : 0;
  const sumRun = (sub.results || []).reduce((a, b) => a + (b.runMs || 0), 0);
  const cases = (sub.results || []).map(t =>
    `<span class="case ${t.pass ? 'pass' : ''}" title="เทสต์ #${t.idx}: ${t.pass ? 'ผ่าน' : 'ไม่ผ่าน'}">${t.idx}</span>`).join('');
  const log = st === 'gray' && sub.compileLog
    ? `<details class="mt-3" open><summary class="text-sm font-semibold">ข้อความจากคอมไพเลอร์</summary><pre class="log">${esc(cleanLog(sub.compileLog))}</pre></details>` : '';
  resultBox.innerHTML = `
    <div class="result ${st}">
      <div><span class="verdict">${esc(STATUS[st]?.label || st)}</span> · ผ่าน ${sub.pass}/${sub.total} เทสต์ (${pct}%)</div>
      ${cases ? `<div class="cases mt-2">${cases}</div>` : ''}
      <div class="muted text-sm mt-2">${sub.compileMs != null ? `compile ${sub.compileMs}ms · ` : ''}run รวม ${sumRun}ms · ${esc(sub.language.toUpperCase())}</div>
      ${log}
    </div>`;
}

runBtn.addEventListener('click', async () => {
  if (!editor) return;
  saveDraft();
  runBtn.disabled = true;
  const label = runBtn.innerHTML;
  runBtn.innerHTML = '<span class="spin"></span> กำลังรัน...';
  runMsg.textContent = '';
  runResultBox.innerHTML = '';

  const res = await api('/api/run', {
    method: 'POST',
    body: JSON.stringify({ language: editorLang, code: getCode(), input: runInput.value, problemId: currentProblem?.id })
  });
  runBtn.disabled = false;
  runBtn.innerHTML = label;

  if (!res || !res.ok) {
    runMsg.textContent = GRADE_ERR[res?.error]
      || (res?.error === 'runner_error' ? ('รันไม่สำเร็จ: ' + (res.detail || '')) : 'รันไม่สำเร็จ');
    return;
  }
  if (!res.compileOk) {
    runResultBox.innerHTML = `<div class="result gray"><div class="verdict">คอมไพล์ไม่ผ่าน</div>
      <pre class="log">${esc(cleanLog(res.compileLog))}</pre></div>`;
    return;
  }
  runResultBox.innerHTML = `
    <div class="result ${res.timedOut || res.error ? 'red' : 'green'}">
      <div class="muted text-xs mb-1">output${res.timedOut ? ' (timeout)' : ''} · run ${res.runMs}ms</div>
      <pre class="log">${esc(res.output) || '<span class="muted">(ไม่มี output)</span>'}</pre>
      ${res.error ? `<div class="muted text-xs mt-2 mb-1">error</div><pre class="log">${esc(res.error)}</pre>` : ''}
    </div>`;
});

submitBtn.addEventListener('click', async () => {
  if (!currentProblem || !editor) return;
  saveDraft();
  submitBtn.disabled = true;
  const label = submitBtn.innerHTML;
  submitBtn.innerHTML = '<span class="spin"></span> กำลังตรวจ...';
  submitMsg.textContent = '';
  resultBox.innerHTML = '';

  const res = await api('/api/submit', {
    method: 'POST',
    body: JSON.stringify({ problemId: currentProblem.id, language: editorLang, code: getCode() })
  });
  submitBtn.disabled = false;
  submitBtn.innerHTML = label;

  if (!res || !res.ok) {
    const msg = ['ส่งไม่สำเร็จ', res?.error ? `error: ${res.error}` : '', res?.detail ? `detail: ${res.detail}` : ''].filter(Boolean).join(' • ');
    submitMsg.textContent = GRADE_ERR[res?.error] || msg;
    toast('ส่งไม่สำเร็จ', 'bad');
    return;
  }
  mySubs.unshift(res.submission);
  // the server graded against the tests as they are *now*; if an admin edited them since this page loaded, catch up so the score counts
  problemInfo.set(currentProblem.id, { title: currentProblem.title, testsRev: res.submission.testsRev || 0, testCount: res.submission.total });
  currentProblem.testCount = res.submission.total;
  renderResult(res.submission);
  renderPbChip();
  if (res.submission.status === 'green') toast('ผ่านครบทุกเทสต์', 'ok');
});

/* ---------- my submissions page ---------- */
subsFilter.addEventListener('change', () => {
  subsFilterValue = subsFilter.value;
  renderMySubs();
});

async function loadMySubs() {
  subsWrap.innerHTML = emptyState('กำลังโหลด...');
  const [, pr] = await Promise.all([refreshMySubs(), api('/api/problems')]);
  if (pr && pr.ok) { pr.problems.forEach(p => problemTitles.set(p.id, p.title)); rememberProblems(pr.problems); }
  renderMySubs();
}
function renderMySubs() {
  const total = mySubs.length;
  const solved = new Set(mySubs.filter(s => s.status === 'green' && isCurrent(s)).map(s => s.problemId)).size;
  const greens = mySubs.filter(s => s.status === 'green' && isCurrent(s)).length;
  subsStats.textContent = total
    ? `ส่งทั้งหมด ${total} ครั้ง · ผ่านครบ ${solved} ข้อ (${greens} ครั้ง) · ล่าสุด ${timeAgo(mySubs[0].createdAt)}`
    : '';

  const list = mySubs.filter(s => subsFilterValue === 'all' ? true : subsFilterValue === 'green' ? s.status === 'green' : s.status !== 'green');
  if (!list.length) { subsWrap.innerHTML = emptyState(total ? 'ไม่มีรายการที่ตรงกับตัวกรอง' : 'ยังไม่เคยส่งคำตอบ'); return; }

  subsWrap.innerHTML = '';
  list.forEach(s => {
    const el = document.createElement('div');
    el.className = 'row';
    el.style.cssText = 'display:block;padding:.7rem .9rem';
    const cases = (Array.isArray(s.results) ? s.results : []).map(t =>
      `<span class="case sm ${t.pass ? 'pass' : ''}" title="เทสต์ #${t.idx}: ${t.pass ? 'ผ่าน' : 'ไม่ผ่าน'}"></span>`).join('');
    const sumRun = (s.results || []).reduce((a, b) => a + (b.runMs || 0), 0);
    el.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-semibold">${esc(problemTitles.get(s.problemId) || 'โจทย์ที่ถูกลบ')}</span>
        ${chip(s.status)}
        <span class="chip accent">${esc(s.language.toUpperCase())}</span>
        <span class="chip">${s.pass}/${s.total}</span>
        ${isCurrent(s) ? '' : '<span class="chip gray" title="ตัดด้วยเทสต์เคสชุดเดิม แอดมินแก้เทสต์เคสภายหลัง จึงไม่นับในคะแนน">เทสต์ชุดเดิม</span>'}
        <span class="flex-1"></span>
        <span class="muted text-xs" title="${esc(fmtDate(s.createdAt))}">${esc(timeAgo(s.createdAt))}</span>
      </div>
      ${cases ? `<div class="cases mt-2">${cases}</div>` : ''}
      <div class="muted text-xs mt-1">compile ${s.compileMs != null ? s.compileMs + 'ms' : '-'} · run รวม ${sumRun}ms${s.status === 'gray' ? ' · compile error' : ''}</div>
      <details class="mt-1">
        <summary class="link text-sm">ดูโค้ดที่ส่ง</summary>
        <pre class="log mono"></pre>
      </details>`;
    el.querySelector('pre').textContent = s.code || '';
    subsWrap.appendChild(el);
  });
}

/* ---------- admin ---------- */
adminTabs.addEventListener('click', e => {
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  $$('#adminTabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('#adminPage [data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.t));
});

function adminSubHtml(sub) {
  const tests = (sub.results || []).map(r => `
    <div class="mt-2 pt-2" style="border-top:1px solid var(--border)">
      <span class="case ${r.pass ? 'pass' : ''}" style="display:inline-grid">${r.idx}</span>
      <span class="muted text-xs ml-1">run ${r.runMs ?? 0}ms${r.timedOut ? ' · timeout' : ''}</span>
      <div class="mono text-xs mt-1" style="word-break:break-all">input: ${esc(r.input)}<br>expected: ${esc(r.expected)}<br>got: ${esc(r.got || '')}${r.error ? `<br>error: ${esc(r.error)}` : ''}</div>
    </div>`).join('');
  return `
    <div class="box p-3">
      <div class="flex flex-wrap items-center gap-2">
        ${chip(sub.status)}
        <b>${esc(sub.username)}</b>
        <span class="muted">${esc(adminProblemTitles.get(sub.problemId) || '')}</span>
        <span class="chip accent">${esc(sub.language.toUpperCase())}</span>
        <span class="chip">${sub.pass}/${sub.total}</span>
        ${adminProblemRevs.has(sub.problemId) && (sub.testsRev || 0) !== adminProblemRevs.get(sub.problemId) ? '<span class="chip gray" title="ตัดด้วยเทสต์เคสชุดเดิม ก่อนที่จะมีการแก้ไข">เทสต์ชุดเดิม</span>' : ''}
        <span class="flex-1"></span>
        <span class="muted text-xs">${esc(fmtDate(sub.createdAt))}</span>
      </div>
      <details class="mt-2">
        <summary class="link text-sm">ดู log / โค้ด</summary>
        ${sub.compileLog ? `<pre class="log">${esc(sub.compileLog)}</pre>` : ''}
        ${tests}
        <details class="mt-2"><summary class="link text-sm">ดูโค้ดที่ส่ง</summary><pre class="log mono">${esc(sub.code || '')}</pre></details>
      </details>
    </div>`;
}
function renderAdminSubs() {
  const q = subsSearch.value.trim().toLowerCase();
  const list = adminSubs.filter(s => !q || (s.username || '').toLowerCase().includes(q));
  subsCount.textContent = `(${list.length} รายการ)`;
  allSubs.innerHTML = list.length ? list.slice(0, adminShown).map(adminSubHtml).join('') : '<div class="empty">ไม่พบรายการ</div>';
  moreSubs.classList.toggle('hidden', list.length <= adminShown);
}
subsSearch.addEventListener('input', () => { adminShown = 40; renderAdminSubs(); });
moreSubs.addEventListener('click', () => { adminShown += 40; renderAdminSubs(); });

async function renderAdmin() {
  const r = await api('/api/projects');
  const pr = await api('/api/admin/problems');
  const u = await api('/api/admin/users');
  const s = await api('/api/admin/submissions');

  // projects
  projList.innerHTML = '';
  pbProject.innerHTML = '';
  if (r.ok) {
    r.projects.forEach(p => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="min-w-0">${esc(p.name)} <span class="muted">(${esc(p.slug)})</span></div>
        <div class="flex items-center gap-3">
          <label class="muted text-xs flex items-center gap-1.5">เปิด <input type="checkbox" ${p.enabled ? 'checked' : ''}></label>
          <button class="btn btn-sm btn-danger delP">ลบ</button>
        </div>`;
      row.querySelector('input').addEventListener('change', async ev => {
        await api('/api/admin/projects/toggle', { method: 'POST', body: JSON.stringify({ id: p.id, enabled: ev.target.checked }) });
        toast(ev.target.checked ? 'เปิดโปรเจกต์แล้ว' : 'ปิดโปรเจกต์แล้ว', 'ok');
      });
      row.querySelector('.delP').addEventListener('click', async () => {
        if (!confirm('ยืนยันลบโปรเจกต์นี้? โจทย์และซับมิทใต้โปรเจกต์นี้จะถูกลบด้วย')) return;
        await api('/api/admin/projects/delete', { method: 'POST', body: JSON.stringify({ id: p.id }) });
        toast('ลบโปรเจกต์แล้ว');
        renderAdmin();
      });
      projList.appendChild(row);
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = `${p.name} (${p.slug})`;
      pbProject.appendChild(opt);
    });
    if (!r.projects.length) projList.innerHTML = '<div class="empty">ยังไม่มีโปรเจกต์</div>';
  }

  // problems
  pbList.innerHTML = '';
  adminProblemTitles.clear();
  adminProblemRevs.clear();
  if (pr.ok) {
    pr.problems.forEach(pb => { adminProblemTitles.set(pb.id, pb.title); adminProblemRevs.set(pb.id, pb.testsRev || 0); });
    if (!pr.problems.length) pbList.innerHTML = '<div class="empty">ยังไม่มีโจทย์</div>';
    pr.problems.forEach(pb => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="min-w-0">
          <b>${esc(pb.title)}</b>
          <span class="muted">· ${esc(pb.projectName)}${pb.projectEnabled ? '' : ' (ปิดอยู่)'}</span>
          <a class="link ml-2 text-xs" href="${esc(pb.pdfUrl)}" target="_blank" rel="noopener">PDF</a>
          <div class="muted text-xs">${(pb.tests || []).length} เทสต์เคส · เวลา ${esc(pb.timeLimitMs)} ms · หน่วยความจำ ${esc(pb.memLimitMB)} MB</div>
        </div>
        <div class="flex items-center gap-2">
          <button class="btn btn-sm editPb">แก้ไข</button>
          <button class="btn btn-sm btn-danger delPb">ลบ</button>
        </div>`;
      row.querySelector('.delPb').addEventListener('click', async () => {
        if (!confirm('ยืนยันลบโจทย์นี้? ซับมิทที่เกี่ยวข้องจะถูกลบด้วย')) return;
        await api('/api/admin/problems/delete', { method: 'POST', body: JSON.stringify({ id: pb.id }) });
        toast('ลบโจทย์แล้ว');
        renderAdmin();
      });
      row.querySelector('.editPb').addEventListener('click', () => toggleProblemEditor(pb, row, r.ok ? r.projects : []));
      pbList.appendChild(row);
    });
  }

  // users
  userList.innerHTML = '';
  if (u.ok) {
    u.users.forEach(us => {
      const mine = me && us.id === me.id;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="flex items-center gap-3 min-w-0">
          <div class="min-w-0"><b>${esc(us.username)}</b> ${mine ? '<span class="muted text-xs">(คุณ)</span>' : ''}
            <span class="muted text-xs">${esc(us.id.slice(0, 8))}</span></div>
          ${us.isAdmin ? '<span class="chip accent">admin</span>' : ''}
        </div>
        <div class="flex items-center gap-2">
          <button class="btn btn-sm toggle" ${mine ? 'disabled title="ไม่สามารถเปลี่ยนสิทธิ์ตัวเองได้"' : ''}>${us.isAdmin ? 'ถอน admin' : 'ให้ admin'}</button>
          <button class="btn btn-sm btn-danger del" ${mine ? 'disabled title="ไม่สามารถลบตัวเองได้"' : ''}>ลบ</button>
        </div>`;
      row.querySelector('.toggle').addEventListener('click', async () => {
        const g = await api('/api/admin/users/grant', { method: 'POST', body: JSON.stringify({ userId: us.id, isAdmin: !us.isAdmin }) });
        if (!g.ok) { toast(g.error === 'last_admin' ? 'ต้องมี admin อย่างน้อย 1 คน' : 'เปลี่ยนสิทธิ์ไม่สำเร็จ', 'bad'); return; }
        toast(us.isAdmin ? 'ถอนสิทธิ์ admin แล้ว' : 'ให้สิทธิ์ admin แล้ว', 'ok');
        renderAdmin();
      });
      row.querySelector('.del').addEventListener('click', async () => {
        if (!confirm(`ยืนยันลบผู้ใช้ ${us.username}?`)) return;
        const d = await api('/api/admin/users/delete', { method: 'POST', body: JSON.stringify({ userId: us.id }) });
        if (!d.ok) { toast(d.error === 'last_admin' ? 'ลบ admin คนสุดท้ายไม่ได้' : d.error === 'cannot_delete_self' ? 'ลบตัวเองไม่ได้' : 'ลบผู้ใช้ไม่สำเร็จ', 'bad'); return; }
        toast('ลบผู้ใช้แล้ว');
        renderAdmin();
      });
      userList.appendChild(row);
    });
  }

  // all submissions
  adminSubs = s.ok ? s.submissions : [];
  adminShown = 40;
  renderAdminSubs();
}

/* ---------- problem editor (test cases, time / memory limits, title, project, PDF) ---------- */
// Editable text format — handles multi-line inputs, unlike the one-line `input => expected` used when creating:
//   @@ input
//   4 4
//   1 2 5
//   @@ expected
//   1
// (a blank line between cases is optional; trailing blank lines inside a section are dropped)
const testsToText = tests => (tests || []).map(t => `@@ input\n${t.input}\n@@ expected\n${t.expected}`).join('\n\n');
function textToTests(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const tests = [];
  let input = null, expected = null, section = null, buf = [];
  const joinBuf = () => { while (buf.length && buf[buf.length - 1].trim() === '') buf.pop(); const s = buf.join('\n'); buf = []; return s; };
  const closeSection = () => { if (section === 'input') input = joinBuf(); else if (section === 'expected') expected = joinBuf(); };
  const closeCase = () => {
    closeSection();
    if (input === null && expected === null) return null;
    if (input === null || expected === null) return `เคสที่ ${tests.length + 1} ต้องมีทั้ง "@@ input" และ "@@ expected"`;
    tests.push({ input, expected });
    input = expected = section = null;
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimEnd();
    if (t === '@@ input') {
      if (section) { const e = closeCase(); if (e) return { error: e }; }
      section = 'input';
    } else if (t === '@@ expected') {
      if (section !== 'input') return { error: `บรรทัด ${i + 1}: "@@ expected" ต้องอยู่หลัง "@@ input"` };
      closeSection(); section = 'expected';
    } else if (section) {
      buf.push(lines[i]);
    } else if (t.trim() !== '') {
      return { error: `บรรทัด ${i + 1}: แต่ละเคสต้องขึ้นต้นด้วย "@@ input"` };
    }
  }
  const e = closeCase();
  return e ? { error: e } : { tests };
}
const ADMIN_ERR = {
  bad_time_limit: 'เวลาต้องเป็นจำนวนเต็ม 100–10000 ms',
  bad_mem_limit: 'หน่วยความจำต้องเป็นจำนวนเต็ม 16–1024 MB',
  no_tests: 'ต้องมีอย่างน้อย 1 เทสต์เคส',
  too_many_tests: 'เทสต์เคสเกิน 5000 เคส',
  bad_title: 'ชื่อโจทย์ไม่ถูกต้อง (1–200 ตัวอักษร)',
  bad_project: 'ไม่พบโปรเจกต์ที่เลือก',
  not_found: 'ไม่พบโจทย์ (อาจถูกลบไปแล้ว)',
  pdf_only: 'ต้องเป็นไฟล์ PDF',
  missing_pdf: 'ยังไม่ได้เลือกไฟล์ PDF',
};
function adminErrText(code) {
  let m;
  if ((m = /^test_too_large_(\d+)$/.exec(code))) return `เคสที่ ${m[1]} ใหญ่เกิน 100,000 ตัวอักษร`;
  if ((m = /^bad_test_(\d+)$/.exec(code))) return `เคสที่ ${m[1]} ไม่ถูกต้อง`;
  if ((m = /^bad_test_line_(\d+)$/.exec(code))) return `บรรทัดที่ ${m[1]} ไม่มีเครื่องหมาย => คั่นระหว่าง input กับ expected`;
  return ADMIN_ERR[code] || code || 'ผิดพลาด';
}

function toggleProblemEditor(pb, row, projects) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('pb-editor')) { next.remove(); return; }
  pbList.querySelectorAll('.pb-editor').forEach(el => el.remove());   // one editor open at a time

  const panel = document.createElement('div');
  panel.className = 'pb-editor box p-4 space-y-3 my-2';
  panel.innerHTML = `
    <div class="grid sm:grid-cols-2 gap-3">
      <div class="field"><label>ชื่อโจทย์</label><input class="input e-title" maxlength="200" value="${esc(pb.title)}"></div>
      <div class="field"><label>โปรเจกต์</label><select class="select e-proj">${projects.map(p =>
        `<option value="${esc(p.id)}" ${p.id === pb.projectId ? 'selected' : ''}>${esc(p.name)} (${esc(p.slug)})</option>`).join('')}</select></div>
      <div class="field"><label>เวลาต่อเทสต์ (มิลลิวินาที) 100–10000</label><input class="input e-time" type="number" min="100" max="10000" step="100" value="${esc(pb.timeLimitMs)}"></div>
      <div class="field"><label>หน่วยความจำ (MB) 16–1024</label><input class="input e-mem" type="number" min="16" max="1024" step="16" value="${esc(pb.memLimitMB)}"></div>
    </div>
    <div class="field">
      <label>Testcases — <span class="e-count"></span> · รูปแบบ <code>@@ input</code> … <code>@@ expected</code> (input หลายบรรทัดได้)</label>
      <details class="text-sm mb-2">
        <summary class="link">วิธีเขียนเทสเคส (ละเอียด)</summary>
        <div class="mt-2 space-y-2">
          <p>แต่ละเคสมี 2 ส่วน: บรรทัด <code>@@ input</code> ตามด้วยข้อมูลที่ป้อนเข้าโปรแกรม (กี่บรรทัดก็ได้) แล้วบรรทัด <code>@@ expected</code> ตามด้วย output ที่ถูกต้อง (กี่บรรทัดก็ได้) จะเว้นบรรทัดว่างคั่นระหว่างเคสหรือไม่ก็ได้</p>
          <pre class="log mono" style="white-space:pre-wrap">@@ input
3
10
20
30
@@ expected
60

@@ input
1 2
@@ expected
3</pre>
          <p><b>พิมพ์ขึ้นบรรทัดใหม่จริงได้เลย</b> โหมดนี้ไม่มีการแปลง <code>\n</code> หรือตัวอักษรพิเศษใดๆ และใส่ <code>=&gt;</code> ในข้อความได้</p>
          <p><b>input หรือ expected ว่างเปล่าได้:</b> เว้นบรรทัดไว้ใต้หัวข้อนั้นเลย บรรทัดว่างท้ายแต่ละส่วนจะถูกตัดทิ้ง</p>
          <p><b>การเทียบคำตอบ:</b> CRLF เท่ากับ LF, ตัดช่องว่าง/บรรทัดว่างหัวท้ายของ output ทั้งก้อนก่อนเทียบ แต่ช่องว่างระหว่างคำและท้ายแต่ละบรรทัดต้องตรงเป๊ะ</p>
          <p><b>ข้อจำกัด:</b> 1–5000 เคส, แต่ละ input/expected ไม่เกิน 100,000 ตัวอักษร, ต้องมีอย่างน้อย 1 เคส</p>
          <p class="muted">เมื่อแก้ชุดเทสต์ ผลที่นักเรียนส่งไปก่อนหน้าจะไม่นับในคะแนน (ขึ้นป้าย "เทสต์ชุดเดิม") การแก้แค่เวลา/หน่วยความจำ/ชื่อ ไม่กระทบ</p>
        </div>
      </details>
      <textarea class="textarea mono e-tests" rows="14" spellcheck="false"></textarea>
    </div>
    <div class="muted text-xs">การแก้ไขมีผลกับการส่งครั้งถัดไป — ผลของซับมิทที่ส่งไปแล้วจะไม่ถูกตัดใหม่</div>
    <div class="flex flex-wrap items-center gap-2">
      <button class="btn btn-primary btn-sm e-save">บันทึก</button>
      <button class="btn btn-sm e-cancel">ปิด</button>
      <span class="text-sm e-msg" role="status"></span>
    </div>
    <div class="field border-t pt-3" style="border-color:var(--border)">
      <label>เปลี่ยนไฟล์ PDF</label>
      <div class="flex flex-wrap items-center gap-2">
        <input class="e-pdf text-sm" type="file" accept="application/pdf">
        <button class="btn btn-sm e-pdfsave">อัปโหลด PDF ใหม่</button>
      </div>
    </div>`;
  row.after(panel);

  const q = s => panel.querySelector(s);
  const ta = q('.e-tests'), msg = q('.e-msg'), saveBtn = q('.e-save');
  ta.value = testsToText(pb.tests);
  const updateCount = () => { const p = textToTests(ta.value); q('.e-count').textContent = p.error ? 'รูปแบบยังไม่ถูกต้อง' : `${p.tests.length} เคส`; };
  ta.addEventListener('input', updateCount);
  updateCount();
  q('.e-cancel').addEventListener('click', () => panel.remove());

  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    const parsed = textToTests(ta.value);
    if (parsed.error) { msg.textContent = parsed.error; msg.style.color = 'var(--bad)'; return; }
    saveBtn.disabled = true; msg.textContent = 'กำลังบันทึก...'; msg.style.color = '';
    const r = await api('/api/admin/problems/update', { method: 'POST', body: JSON.stringify({
      id: pb.id, title: q('.e-title').value.trim(), projectId: q('.e-proj').value,
      timeLimitMs: Number(q('.e-time').value), memLimitMB: Number(q('.e-mem').value), tests: parsed.tests
    }) });
    saveBtn.disabled = false;
    if (r.ok) { toast('บันทึกโจทย์แล้ว', 'ok'); renderAdmin(); }
    else { msg.textContent = adminErrText(r.error); msg.style.color = 'var(--bad)'; }
  });

  q('.e-pdfsave').addEventListener('click', async ev => {
    const f = q('.e-pdf').files[0];
    if (!f) { msg.textContent = adminErrText('missing_pdf'); msg.style.color = 'var(--bad)'; return; }
    ev.target.disabled = true;
    const fd = new FormData(); fd.append('id', pb.id); fd.append('pdf', f);
    let r;
    try { r = await (await fetch('/api/admin/problems/pdf', { method: 'POST', body: fd, credentials: 'same-origin' })).json(); }
    catch (e) { r = { ok: false, error: 'network' }; }
    ev.target.disabled = false;
    if (r.ok) { toast('เปลี่ยน PDF แล้ว', 'ok'); renderAdmin(); }
    else { msg.textContent = adminErrText(r.error); msg.style.color = 'var(--bad)'; }
  });
}

createProj.addEventListener('click', async () => {
  const name = projName.value.trim(), slug = projSlug.value.trim();
  if (!name || !slug) { toast('กรอกชื่อและ slug ให้ครบ', 'bad'); return; }
  const r = await api('/api/admin/projects/create', { method: 'POST', body: JSON.stringify({ name, slug, enabled: projEnabled.checked }) });
  if (r.ok) { projName.value = ''; projSlug.value = ''; projEnabled.checked = false; toast('สร้างโปรเจกต์แล้ว', 'ok'); renderAdmin(); }
  else toast(r.error === 'slug_taken' ? 'slug นี้ถูกใช้แล้ว' : 'สร้างโปรเจกต์ไม่สำเร็จ', 'bad');
});
createPb.addEventListener('click', async () => {
  if (createPb.disabled) return; // guard against double-click creating duplicate problems
  if (!pbTitle.value.trim() || !pbProject.value || !pbPdf.files[0]) { toast('กรอกชื่อโจทย์ เลือกโปรเจกต์ และแนบ PDF ให้ครบ', 'bad'); return; }
  createPb.disabled = true;
  const fd = new FormData();
  fd.append('title', pbTitle.value.trim());
  fd.append('projectId', pbProject.value);
  fd.append('testsText', pbTests.value);
  fd.append('timeLimitMs', $('#pbTime').value);
  fd.append('memLimitMB', $('#pbMem').value);
  fd.append('pdf', pbPdf.files[0]);
  let r;
  try { r = await (await fetch('/api/admin/problems/create', { method: 'POST', body: fd, credentials: 'same-origin' })).json(); }
  catch (e) { r = { ok: false, error: 'network' }; }
  createPb.disabled = false;
  if (r.ok) { pbTitle.value = ''; pbTests.value = ''; pbPdf.value = ''; toast('สร้างโจทย์สำเร็จ', 'ok'); renderAdmin(); }
  else toast('สร้างโจทย์ไม่สำเร็จ: ' + adminErrText(r.error), 'bad');
});
