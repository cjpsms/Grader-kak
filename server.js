// server.js
import express from 'express';
import session from 'express-session';
import bodyParser from 'body-parser';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import multer from 'multer';
import sanitize from 'sanitize-filename';
import { v4 as uuid } from 'uuid';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import fssync from 'fs';
import os from 'os';

import { readJSON, writeJSON, updateJSON, ensureFile, NO_WRITE, withLock, renameWithRetry } from './utils/storage.js';
import { gradeCPP } from './graders/grader_cpp.js';
import { gradePY } from './graders/grader_py.js';
import { isWin, initSandbox, SANDBOX_DIR } from './graders/run_win.js';
import { normalizeLimits, parseLimit, TIME_LIMIT, MEM_LIMIT } from './graders/limits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA = path.join(__dirname, 'data');
const UP_PDF = path.join(__dirname, 'uploads', 'pdfs');
await fs.mkdir(UP_PDF, { recursive: true });

const USERS = path.join(DATA, 'users.json');
const PROJECTS = path.join(DATA, 'projects.json');
const PROBLEMS = path.join(DATA, 'problems.json');
const SUBMISSIONS = path.join(DATA, 'submissions.json');
const SESSION_DIR = path.join(DATA, 'sessions');
const SESSION_SECRET_FILE = path.join(DATA, 'session-secret.txt');

await ensureFile(USERS, '[]');
await ensureFile(PROJECTS, '[]');
await ensureFile(PROBLEMS, '[]');
await ensureFile(SUBMISSIONS, '[]');

/* Windows: set up the sandbox that student code runs in. Fail closed — never grade without it. */
try {
  initSandbox();
} catch (e) {
  console.error('FATAL: cannot set up the code sandbox, refusing to start:', e.stderr?.toString() || e.message);
  process.exit(1);
}

/* Last-resort net: a bug in one request must never take the whole grader down. */
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));

/* Session secret: random, generated once and kept in data/ (override with SESSION_SECRET). */
async function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const s = (await fs.readFile(SESSION_SECRET_FILE, 'utf-8')).trim();
    if (s.length >= 32) return s;
  } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  await fs.writeFile(SESSION_SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SESSION_SECRET = await loadSessionSecret();

/* File-backed session store so logins survive a server restart. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
class FileStore extends session.Store {
  constructor(dir) {
    super();
    this.dir = dir;
    fssync.mkdirSync(dir, { recursive: true });
    this.sweep();
    setInterval(() => this.sweep(), 60 * 60 * 1000).unref();
  }
  file(sid) { return path.join(this.dir, String(sid).replace(/[^A-Za-z0-9_-]/g, '_') + '.json'); }
  expired(sess) { return !!(sess?.cookie?.expires && new Date(sess.cookie.expires).getTime() < Date.now()); }
  async sweep() {
    try {
      for (const f of await fs.readdir(this.dir)) {
        const p = path.join(this.dir, f);
        if (f.endsWith('.tmp')) {   // left behind by a crash mid-write
          try { if (Date.now() - (await fs.stat(p)).mtimeMs > 60 * 60 * 1000) await fs.unlink(p); } catch {}
          continue;
        }
        if (!f.endsWith('.json')) continue;
        try { if (this.expired(JSON.parse(await fs.readFile(p, 'utf-8')))) await fs.unlink(p); }
        catch { await fs.unlink(p).catch(() => {}); }   // unreadable/corrupt session file
      }
    } catch {}
  }
  get(sid, cb) {
    fs.readFile(this.file(sid), 'utf-8').then(raw => {
      const sess = JSON.parse(raw);
      if (this.expired(sess)) return this.destroy(sid, () => cb(null, null));
      cb(null, sess);
    }).catch(e => cb(e.code === 'ENOENT' || e instanceof SyntaxError ? null : e, null));
  }
  // express-session saves (or "touches") the session on every request, and a page load fires several API calls at once.
  // Writes to one session file are serialised and use a unique temp name; a shared temp name made the second rename fail (ENOENT).
  set(sid, sess, cb = () => {}) {
    const f = this.file(sid);
    withLock(f, async () => {
      const tmp = `${f}.${uuid()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(sess));
      try { await renameWithRetry(tmp, f); }
      catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
    }).then(() => cb(null), cb);
  }
  touch(sid, sess, cb = () => {}) { this.set(sid, sess, cb); }
  destroy(sid, cb = () => {}) {
    fs.unlink(this.file(sid)).then(() => cb(null), e => cb(e.code === 'ENOENT' ? null : e));
  }
}

const app = express();

/* Express 4 doesn't catch rejected promises from async handlers (Node would kill the process).
   Wrap every handler registered through app.get / app.post so rejections reach the error middleware. */
function wrapHandler(h) {
  if (typeof h !== 'function' || h.length === 4) return h;
  return (req, res, next) => {
    try {
      const r = h(req, res, next);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (e) { next(e); }
  };
}
for (const m of ['get', 'post']) {
  const orig = app[m].bind(app);
  app[m] = (...args) => (m === 'get' && args.length === 1)   // app.get('setting') is a settings lookup
    ? orig(...args)
    : orig(args[0], ...args.slice(1).flat().map(wrapHandler));
}

/* Security + DoS */
app.use(helmet({ contentSecurityPolicy: false }));
const limiter = rateLimit({
  windowMs: 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

/* Body & Session (เพิ่มลิมิตเป็น 5MB) */
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(session({
  name: 'grader.sid',
  secret: SESSION_SECRET,
  store: new FileStore(SESSION_DIR),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS }   // not `secure`: the server speaks plain HTTP on the LAN
}));

/* CSRF: browsers always send Origin on cross-site POSTs; reject any that doesn't match this host. */
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch {}
    if (!ok) return res.status(403).json({ ok: false, error: 'bad_origin' });
  }
  next();
});

/* Static */
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/pdf', express.static(UP_PDF));

/* Multer PDF */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UP_PDF),
  filename: (req, file, cb) => {
    const safe = sanitize(file.originalname).replace(/\s+/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => (/\.pdf$/i.test(file.originalname) ? cb(null, true) : cb(new Error('PDF only')))
});

/* Helpers */
const isStr = v => typeof v === 'string';

// The session only stores *who*; role and existence are re-read on every request, so deleting or
// demoting a user takes effect immediately instead of when their cookie expires.
async function currentUser(req) {
  const su = req.session?.user;
  if (!su) return null;
  const users = await readJSON(USERS, []);
  const u = users.find(x => x.id === su.id);
  return u ? { id: u.id, username: u.username, isAdmin: !!u.isAdmin } : null;
}
async function requireAuth(req, res, next) {
  const u = await currentUser(req);
  if (!u) {
    if (req.session?.user) return req.session.destroy(() => res.status(401).json({ ok: false, error: 'unauthorized' }));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
}
// New session id on every login/registration (prevents session fixation).
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.user = { id: user.id, username: user.username, isAdmin: !!user.isAdmin };
      resolve(req.session.user);
    });
  });
}

/* Queue (จำกัดงานพร้อมกันเพื่อความลื่น) */
const jobQ = [];
let running = 0;
const MAX_CONCURRENCY = Math.max(1, Math.min(2, (os.cpus()?.length) || 1));
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    jobQ.push({ fn, resolve, reject });
    pump();
  });
}
async function pump() {
  if (running >= MAX_CONCURRENCY) return;
  const job = jobQ.shift();
  if (!job) return;
  running++;
  try {
    const val = await job.fn();
    job.resolve(val);
  } catch (e) {
    job.reject(e);
  } finally {
    running--;
    setImmediate(pump);
  }
}

/* Auth */
const MAX_USERNAME = 32;
const MAX_PASSWORD = 72;   // bcrypt ignores everything past 72 bytes
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-1', 10);   // so unknown usernames cost the same as wrong passwords

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,                         // failed attempts per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.locals.authOk === true,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'too_many_attempts' })
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'too_many_attempts' })
});

app.post('/api/register', registerLimiter, async (req, res) => {
  const { username, password, confirm } = req.body || {};
  if (!username || !password || !confirm) return res.json({ ok: false, error: 'missing_fields' });
  if (![username, password, confirm].every(isStr) || !username.trim()) return res.json({ ok: false, error: 'missing_fields' });
  if (username.length > MAX_USERNAME || password.length > MAX_PASSWORD) return res.json({ ok: false, error: 'invalid_fields' });
  if (password !== confirm) return res.json({ ok: false, error: 'password_mismatch' });
  if (!/\d/.test(password)) return res.json({ ok: false, error: 'password_need_digit' });

  const hash = await bcrypt.hash(password, 10);
  let user = null;
  // check-and-insert in one locked step: two simultaneous sign-ups can't both claim a name or both become first admin
  await updateJSON(USERS, users => {
    if (users.find(u => String(u.username).toLowerCase() === username.toLowerCase())) return NO_WRITE;
    user = { id: uuid(), username, passhash: hash, isAdmin: users.length === 0 };
    users.push(user);
  });
  if (!user) return res.json({ ok: false, error: 'username_taken' });

  res.locals.authOk = true;
  res.json({ ok: true, user: await startSession(req, user) });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!isStr(username) || !isStr(password) || username.length > MAX_USERNAME || password.length > MAX_PASSWORD) {
    return res.json({ ok: false, error: 'invalid_login' });
  }
  const users = await readJSON(USERS, []);
  const u = users.find(x => String(x.username).toLowerCase() === username.toLowerCase());
  const ok = await bcrypt.compare(password, u ? u.passhash : DUMMY_HASH);
  if (!u || !ok) return res.json({ ok: false, error: 'invalid_login' });
  res.locals.authOk = true;
  res.json({ ok: true, user: await startSession(req, u) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', async (req, res) => {
  res.json({ ok: true, user: await currentUser(req) });
});

/* Admin: Users */
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const users = await readJSON(USERS, []);
  res.json({ ok: true, users: users.map(({ passhash, ...u }) => u) });
});
app.post('/api/admin/users/grant', requireAuth, requireAdmin, async (req, res) => {
  const { userId, isAdmin } = req.body || {};
  let result = { ok: true };
  await updateJSON(USERS, users => {
    const u = users.find(x => x.id === userId);
    if (!u) { result = { ok: false, error: 'not_found' }; return NO_WRITE; }
    const want = !!isAdmin;
    if (!want && u.isAdmin && users.filter(x => x.isAdmin).length <= 1) {
      result = { ok: false, error: 'last_admin' };   // never leave the system with nobody who can administer it
      return NO_WRITE;
    }
    u.isAdmin = want;
  });
  res.json(result);
});
app.post('/api/admin/users/delete', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.body || {};
  if (userId === req.user.id) return res.json({ ok: false, error: 'cannot_delete_self' });
  let result = { ok: true };
  await updateJSON(USERS, users => {
    const target = users.find(u => u.id === userId);
    if (target?.isAdmin && users.filter(x => x.isAdmin).length <= 1) {
      result = { ok: false, error: 'last_admin' };
      return NO_WRITE;
    }
    return users.filter(u => u.id !== userId);
  });
  res.json(result);
});

/* Projects */
app.get('/api/projects', requireAuth, async (req, res) => {
  const projects = await readJSON(PROJECTS, []);
  res.json({ ok: true, projects });
});
app.post('/api/admin/projects/create', requireAuth, requireAdmin, async (req, res) => {
  const { name, slug, enabled } = req.body || {};
  if (!name || !slug) return res.json({ ok: false, error: 'missing' });
  let p = null;
  await updateJSON(PROJECTS, projects => {
    if (projects.find(x => x.slug === slug)) return NO_WRITE;
    p = { id: uuid(), name, slug, enabled: !!enabled };
    projects.push(p);
  });
  if (!p) return res.json({ ok: false, error: 'slug_taken' });
  res.json({ ok: true, project: p });
});
app.post('/api/admin/projects/toggle', requireAuth, requireAdmin, async (req, res) => {
  const { id, enabled } = req.body || {};
  let found = false;
  await updateJSON(PROJECTS, projects => {
    const p = projects.find(x => x.id === id);
    if (!p) return NO_WRITE;
    found = true;
    p.enabled = !!enabled;
  });
  res.json(found ? { ok: true } : { ok: false, error: 'not_found' });
});

/* Admin: list problems (all, including disabled projects) */
app.get('/api/admin/problems', requireAuth, requireAdmin, async (req, res) => {
  const problems = await readJSON(PROBLEMS, []);
  const projects = await readJSON(PROJECTS, []);
  const mapProj = new Map(projects.map(p => [p.id, p]));
  const withNames = problems.map(pb => ({
    ...pb,
    ...normalizeLimits(pb),
    projectName: mapProj.get(pb.projectId)?.name || '(unknown)',
    projectEnabled: !!mapProj.get(pb.projectId)?.enabled
  }));
  res.json({ ok: true, problems: withNames.sort((a,b)=>b.createdAt-a.createdAt) });
});

async function removePdf(pb) {
  try {
    const base = path.basename(pb.pdfUrl || '');
    const filePath = path.join(UP_PDF, base);
    if (base && fssync.existsSync(filePath)) await fs.unlink(filePath);
  } catch {}
}

/* Admin: delete ONE problem (also remove its PDF and related submissions) */
app.post('/api/admin/problems/delete', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.json({ ok:false, error:'missing_id' });

  let pb = null;
  await updateJSON(PROBLEMS, problems => {
    const idx = problems.findIndex(p => p.id === id);
    if (idx < 0) return NO_WRITE;
    pb = problems[idx];
    problems.splice(idx, 1);
  });
  if (!pb) return res.json({ ok:false, error:'not_found' });

  await removePdf(pb);

  // remove submissions of this problem
  let removedSubs = 0;
  await updateJSON(SUBMISSIONS, subs => {
    const kept = subs.filter(s => s.problemId !== id);
    removedSubs = subs.length - kept.length;
    return kept;
  });

  res.json({ ok:true, removedSubs });
});

/* Admin: delete ONE project (also remove its problems, PDFs, and related submissions) */
app.post('/api/admin/projects/delete', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.json({ ok:false, error:'missing_id' });

  let found = false;
  await updateJSON(PROJECTS, projects => {
    if (!projects.some(x => x.id === id)) return NO_WRITE;
    found = true;
    return projects.filter(x => x.id !== id);
  });
  if (!found) return res.json({ ok:false, error:'not_found' });

  // remove problems under this project + PDFs
  let toRemove = [];
  await updateJSON(PROBLEMS, problems => {
    toRemove = problems.filter(pb => pb.projectId === id);
    return problems.filter(pb => pb.projectId !== id);
  });
  for (const pb of toRemove) await removePdf(pb);

  // remove submissions of those problems
  let removedSubs = 0;
  const pbIds = new Set(toRemove.map(pb => pb.id));
  await updateJSON(SUBMISSIONS, subs => {
    const kept = subs.filter(s => !pbIds.has(s.problemId));
    removedSubs = subs.length - kept.length;
    return kept;
  });

  res.json({ ok:true, removedProblems: toRemove.length, removedSubs });
});

/* Never send test inputs / expected outputs to students (admin routes return the full data) */
const publicProblem = ({ tests, ...rest }) => ({ ...rest, ...normalizeLimits(rest), testCount: (tests || []).length });
const publicSubmission = sub => ({
  ...sub,
  results: (sub.results || []).map(({ idx, pass, runMs, timedOut }) => ({ idx, pass, runMs, timedOut }))
});

/* Problems */
app.get('/api/problems', requireAuth, async (req, res) => {
  const problems = await readJSON(PROBLEMS, []);
  const projects = await readJSON(PROJECTS, []);
  const mapProj = new Map(projects.map(p => [p.id, p]));
  const visible = problems.filter(pb => mapProj.get(pb.projectId)?.enabled);
  res.json({ ok: true, problems: visible.map(publicProblem) });
});
app.get('/api/problems/byProject', requireAuth, async (req, res) => {
  const { projectId } = req.query || {};
  if (!projectId) return res.json({ ok: false, error: 'missing_project' });
  const problems = await readJSON(PROBLEMS, []);
  const projects = await readJSON(PROJECTS, []);
  const proj = projects.find(p => p.id === projectId && p.enabled);
  if (!proj) return res.json({ ok: true, problems: [] });
  const filtered = problems.filter(pb => pb.projectId === projectId);
  res.json({ ok: true, problems: filtered.map(publicProblem) });
});
app.post('/api/admin/problems/create', requireAuth, requireAdmin, upload.single('pdf'), async (req, res) => {
  const { title, projectId, testsText, timeLimitMs, memLimitMB } = req.body || {};
  if (!title || !projectId || !req.file) return res.json({ ok: false, error: 'missing_fields_or_pdf' });

  // blank = default; anything else must be a whole number inside the allowed range
  const limits = {
    timeLimitMs: timeLimitMs === undefined || timeLimitMs === '' ? TIME_LIMIT.def : parseLimit(timeLimitMs, TIME_LIMIT),
    memLimitMB: memLimitMB === undefined || memLimitMB === '' ? MEM_LIMIT.def : parseLimit(memLimitMB, MEM_LIMIT),
  };
  if (limits.timeLimitMs === null) { await removePdf({ pdfUrl: `/pdf/${path.basename(req.file.path)}` }); return res.json({ ok: false, error: 'bad_time_limit' }); }
  if (limits.memLimitMB === null) { await removePdf({ pdfUrl: `/pdf/${path.basename(req.file.path)}` }); return res.json({ ok: false, error: 'bad_mem_limit' }); }

  const tests = [];
  const lines = (testsText || '').split(/\r?\n/);
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    const t = line.trim();
    if (!t) continue;
    const m = t.split(/\s*=>\s*/);
    if (m.length < 2) {
      return res.json({ ok: false, error: `bad_test_line_${lineNo}` });
    }
    // one line can't hold a line break, so "\n" in the form stands for one (and "\\" for a real backslash).
    // Without this, "3\n1 2 3 => ok" was stored with a literal backslash-n and no solution could ever pass.
    const unescape = s => s.replace(/\\(n|\\)/g, (_, c) => (c === 'n' ? '\n' : '\\'));
    tests.push({ input: unescape(m[0]), expected: unescape(m[1]), line: lineNo });
  }

  if (!tests.length) {   // a problem without tests would mark any code as fully passed
    await removePdf({ pdfUrl: `/pdf/${path.basename(req.file.path)}` });
    return res.json({ ok: false, error: 'no_tests' });
  }

  const pdfUrl = `/pdf/${path.basename(req.file.path)}`;
  const pb = { id: uuid(), title, projectId, pdfUrl, tests, ...limits, testsRev: 0, createdAt: Date.now() };
  await updateJSON(PROBLEMS, problems => { problems.push(pb); });
  res.json({ ok: true, problem: pb });
});

/* Admin: edit a problem — title, project, time/memory limits and/or the full list of test cases.
   Only fields that are present in the request are changed. `tests` replaces the whole list. */
const MAX_TESTS = 5000;
const MAX_TEST_FIELD = 100_000;   // same cap as the "run with input" box
function validateTests(tests) {
  if (!Array.isArray(tests) || tests.length === 0) return { error: 'no_tests' };   // a problem with no tests would pass any code
  if (tests.length > MAX_TESTS) return { error: 'too_many_tests' };
  const out = [];
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    if (!t || !isStr(t.input) || !isStr(t.expected)) return { error: `bad_test_${i + 1}` };
    if (t.input.length > MAX_TEST_FIELD || t.expected.length > MAX_TEST_FIELD) return { error: `test_too_large_${i + 1}` };
    out.push({ input: t.input, expected: t.expected, line: i + 1 });
  }
  return { tests: out };
}
app.post('/api/admin/problems/update', requireAuth, requireAdmin, async (req, res) => {
  const { id, title, projectId, timeLimitMs, memLimitMB, tests } = req.body || {};
  if (!isStr(id) || !id) return res.json({ ok: false, error: 'missing_id' });

  const patch = {};
  if (title !== undefined) {
    if (!isStr(title) || !title.trim() || title.length > 200) return res.json({ ok: false, error: 'bad_title' });
    patch.title = title.trim();
  }
  if (projectId !== undefined) {
    const projects = await readJSON(PROJECTS, []);
    if (!isStr(projectId) || !projects.some(p => p.id === projectId)) return res.json({ ok: false, error: 'bad_project' });
    patch.projectId = projectId;
  }
  if (timeLimitMs !== undefined) {
    const n = parseLimit(timeLimitMs, TIME_LIMIT);
    if (n === null) return res.json({ ok: false, error: 'bad_time_limit' });
    patch.timeLimitMs = n;
  }
  if (memLimitMB !== undefined) {
    const n = parseLimit(memLimitMB, MEM_LIMIT);
    if (n === null) return res.json({ ok: false, error: 'bad_mem_limit' });
    patch.memLimitMB = n;
  }
  if (tests !== undefined) {
    const v = validateTests(tests);
    if (v.error) return res.json({ ok: false, error: v.error });
    patch.tests = v.tests;
  }

  let updated = null;
  await updateJSON(PROBLEMS, problems => {
    const pb = problems.find(p => p.id === id);
    if (!pb) return NO_WRITE;
    // Submissions remember which revision of the tests graded them; bumping it marks older results as "graded against the old tests"
    // so the pages stop mixing them into "best score / solved" (their stored total no longer matches the problem).
    const sameTests = patch.tests === undefined || (
      pb.tests.length === patch.tests.length &&
      pb.tests.every((t, i) => t.input === patch.tests[i].input && t.expected === patch.tests[i].expected));
    if (!sameTests) pb.testsRev = (pb.testsRev || 0) + 1;
    Object.assign(pb, patch, { updatedAt: Date.now() });
    updated = pb;
  });
  if (!updated) return res.json({ ok: false, error: 'not_found' });
  res.json({ ok: true, problem: { ...updated, ...normalizeLimits(updated) } });
});

/* Admin: replace a problem's PDF */
app.post('/api/admin/problems/pdf', requireAuth, requireAdmin, upload.single('pdf'), async (req, res) => {
  const { id } = req.body || {};
  if (!req.file) return res.json({ ok: false, error: 'missing_pdf' });
  const newUrl = `/pdf/${path.basename(req.file.path)}`;
  let oldPb = null;
  await updateJSON(PROBLEMS, problems => {
    const pb = problems.find(p => p.id === id);
    if (!pb) return NO_WRITE;
    oldPb = { pdfUrl: pb.pdfUrl };
    pb.pdfUrl = newUrl;
    pb.updatedAt = Date.now();
  });
  if (!oldPb) { await removePdf({ pdfUrl: newUrl }); return res.json({ ok: false, error: 'not_found' }); }
  await removePdf(oldPb);
  res.json({ ok: true, pdfUrl: newUrl });
});

/* Shared helper: run `code` in a fresh scratch dir, clean it up afterwards no matter what. */
async function runInScratch(fn) {
  // Windows: the sandbox root (Low-integrity, Everyone-modify for children only); elsewhere RAM-backed tmp if available
  const runBase = isWin ? SANDBOX_DIR : (fssync.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir());
  const runDir = path.join(runBase, `grader-${uuid()}`);
  await fs.mkdir(runDir, { recursive: true });
  try {
    return await fn(runDir);
  } finally {
    fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}
// The graders run the forbidden-API scan themselves and report it as a compile failure.
function gradeOne(language, code, tests, runDir, limits) {
  if (language === 'cpp') return gradeCPP(code || '', tests, runDir, limits);
  if (language === 'py') return gradePY(code || '', tests, runDir, limits);
  throw new Error('lang_not_supported');
}
// Budget for one request: compile (<= 20 s) + every test at its time limit (+ process start-up slack). Capped at 5 min.
function overallBudgetMs(nTests, limits) {
  return Math.min(5 * 60 * 1000, 20_000 + nTests * (normalizeLimits(limits).timeLimitMs + 700));
}
// Queue a job; its time budget starts when it actually starts running (waiting in the queue must not eat the budget).
// On timeout the signal is aborted so the grader stops launching further tests instead of grinding on for nobody.
function runJob(runFn, budgetMs) {
  return enqueue(async () => {
    const ac = new AbortController();
    let timer;
    const timedOut = new Promise((_, rej) => {
      timer = setTimeout(() => { ac.abort(); rej(new Error('overall_timeout')); }, budgetMs);
    });
    try {
      return await Promise.race([runFn(ac.signal), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  });
}

// One grading job per user at a time (a 1000-test problem takes ~45 s; stacking submissions would starve everyone else),
// and refuse new work when the queue is already deep.
const MAX_QUEUE = 40;
const busyUsers = new Set();
function oneJobPerUser(req, res, next) {
  const uid = req.user.id;
  if (busyUsers.has(uid)) return res.json({ ok: false, error: 'busy' });
  if (jobQ.length >= MAX_QUEUE) return res.json({ ok: false, error: 'queue_full' });
  busyUsers.add(uid);
  res.on('close', () => busyUsers.delete(uid));
  next();
}

/* Run with custom input — lets a student try their code before submitting for real.
   Does NOT touch the problem's hidden testcases and is never recorded as a submission. */
app.post('/api/run', requireAuth, oneJobPerUser, async (req, res) => {
  const { language, code, input, problemId } = req.body || {};
  if (!language || typeof code !== 'string') return res.json({ ok: false, error: 'missing' });
  if (!['cpp', 'py'].includes(language)) return res.json({ ok: false, error: 'lang_not_supported' });

  // if the page says which problem this is for, the trial run uses that problem's limits (so "works here" == "works when graded")
  let limits = {};
  if (isStr(problemId) && problemId) {
    const pb = (await readJSON(PROBLEMS, [])).find(p => p.id === problemId);
    if (pb) limits = normalizeLimits(pb);
  }
  limits = { ...limits, clipChars: 100_000 };   // one test, shown to the student: keep far more of the output than a stored submission does

  const stdin = String(input ?? '').slice(0, 100_000);
  let result;
  try {
    result = await runJob(signal =>
      runInScratch(runDir => gradeOne(language, code, [{ input: stdin, expected: null }], runDir, { ...limits, signal })),
      overallBudgetMs(1, limits));
  } catch (e) {
    return res.json({ ok: false, error: 'runner_error', detail: String(e.message || e).slice(0, 300) });
  }

  const r0 = result.results[0] || {};
  res.json({
    ok: true,
    compileOk: result.compileOk,
    compileLog: result.compileOk ? '' : (result.compileLog || ''),
    compileMs: result.compileMs ?? null,
    output: r0.got ?? '',
    error: r0.error || '',
    runMs: r0.runMs || 0,
    timedOut: !!r0.timedOut
  });
});

/* Submit */
app.post('/api/submit', requireAuth, oneJobPerUser, async (req, res) => {
  const { problemId, language, code } = req.body || {};
  if (!isStr(problemId) || !isStr(language) || !problemId || !language) return res.json({ ok: false, error: 'missing' });
  if (code != null && !isStr(code)) return res.json({ ok: false, error: 'missing' });

  const problems = await readJSON(PROBLEMS, []);
  const pb = problems.find(p => p.id === problemId);
  if (!pb) return res.json({ ok: false, error: 'problem_not_found' });
  if (!pb.tests?.length) return res.json({ ok: false, error: 'problem_has_no_tests' });
  if (!req.user.isAdmin) {   // students only see problems of enabled projects; don't let them grade against hidden ones by id
    const proj = (await readJSON(PROJECTS, [])).find(p => p.id === pb.projectId);
    if (!proj?.enabled) return res.json({ ok: false, error: 'problem_not_found' });
  }

  const limits = normalizeLimits(pb);
  const testsRev = pb.testsRev || 0;   // the revision of the tests this submission is graded against
  let result;
  try {
    result = await runJob(signal =>
      runInScratch(runDir => gradeOne(language, code, pb.tests, runDir, { ...limits, signal })),
      overallBudgetMs(pb.tests.length, limits));
  } catch (e) {
    return res.json({ ok:false, error:'runner_error', detail: String(e.message||e).slice(0,300) });
  }

  const total = pb.tests.length;
  const pass = result.results.filter(r => r.pass).length;
  let status = 'yellow';
  if (!result.compileOk) status = 'gray';
  else if (pass === 0) status = 'red';
  else if (pass === total) status = 'green';

  const sub = {
    id: uuid(),
    userId: req.user.id,
    username: req.user.username,
    problemId,
    language,
    code: (code || '').slice(0, 200_000),
    compileLog: result.compileLog || '',
    compileMs: result.compileMs ?? null,
    results: result.results,
    pass, total, status, testsRev,
    createdAt: Date.now()
  };
  // appended under the file lock: simultaneous submissions can no longer overwrite each other
  await updateJSON(SUBMISSIONS, submissions => { submissions.push(sub); });

  res.json({ ok: true, submission: publicSubmission(sub) });
});

/* Submissions (mine/admin) */
app.get('/api/my/submissions', requireAuth, async (req, res) => {
  const submissions = await readJSON(SUBMISSIONS, []);
  const mine = submissions.filter(s => s.userId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ ok: true, submissions: mine.map(publicSubmission) });
});
app.get('/api/admin/submissions', requireAuth, requireAdmin, async (req, res) => {
  const submissions = await readJSON(SUBMISSIONS, []);
  res.json({ ok: true, submissions: submissions.sort((a, b) => b.createdAt - a.createdAt) });
});

/* Web page */
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* Errors: bad JSON / oversized body / bad upload are the client's fault; anything else is logged and hidden. */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = err.status || err.statusCode || 500;
  if (err.name === 'MulterError' || err.message === 'PDF only') status = 400;
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  const error = err.message === 'PDF only' ? 'pdf_only' : status >= 500 ? 'server_error' : 'bad_request';
  res.status(status).json({ ok: false, error });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // listen on all interfaces for LAN access
app.listen(PORT, HOST, () => console.log(`Grader running on http://${HOST}:${PORT}`));
