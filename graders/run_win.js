// graders/run_win.js — Windows runner. bash/ulimit/firejail don't exist here, so untrusted code (and the
// compiler that reads it) is launched through graders/sandbox_runner.exe, which gives the child:
//   * a restricted, Low-integrity token (cannot read the owner's profile — data/, cookies, ... — or write outside its scratch dir)
//   * a Job Object: per-process memory cap, process-count cap (no spawning shells / fork bombs), kill-on-close
//   * a wall-clock timeout
// Not covered: network access (Windows has no unprivileged per-process network block).
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const isWin = process.platform === 'win32';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, 'sandbox_runner.exe');
// Scratch root for per-run directories. Its ACL is set up by initSandbox(): children inherit "Everyone: modify" and a Low label,
// while the root itself stays unreadable to the sandboxed process (it can't list other runs).
export const SANDBOX_DIR = path.join(__dirname, '..', '.sandbox');

export const EXIT_TIMEOUT = 124;
export const EXIT_RUNNER_ERROR = 125;

/** One-time setup; throws (fail closed) if the sandbox can't be made safe. Call before accepting submissions. */
export function initSandbox() {
  if (!isWin) return;
  if (!fs.existsSync(RUNNER)) {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'build_runner.ps1')], { stdio: 'pipe' });
    if (!fs.existsSync(RUNNER)) throw new Error('sandbox_runner.exe is missing and could not be built (needs the .NET Framework csc.exe)');
  }
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  const icacls = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'icacls.exe');
  execFileSync(icacls, [SANDBOX_DIR, '/grant', '*S-1-1-0:(OI)(CI)(IO)M'], { stdio: 'pipe' });
  execFileSync(icacls, [SANDBOX_DIR, '/setintegritylevel', '(OI)(CI)L'], { stdio: 'pipe' });
  // runs that were still in flight when the server died leave their scratch dirs behind; nothing else uses them
  for (const d of fs.readdirSync(SANDBOX_DIR)) {
    if (d.startsWith('grader-')) fs.rmSync(path.join(SANDBOX_DIR, d), { recursive: true, force: true });
  }
}

const exeCache = new Map();
/** Full path of an executable on PATH (the sandbox launcher needs an absolute path). Skips 0-byte Store alias stubs. */
export function resolveExe(name) {
  if (exeCache.has(name)) return exeCache.get(name);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, /\.exe$/i.test(name) ? name : name + '.exe');
    try { if (fs.statSync(p).size > 0) { exeCache.set(name, p); return p; } } catch {}
  }
  throw new Error(`${name} not found on PATH`);
}

function describeExit(code) {
  if (code === EXIT_TIMEOUT) return 'Time limit exceeded';
  const hex = code < 0 || code > 255 ? ' (0x' + (code >>> 0).toString(16).toUpperCase() + ')' : '';
  return `Process exited with code ${code}${hex}`;
}

/**
 * Run `file args...` inside the sandbox with `input` on stdin.
 * Resolves {stdout, stderr}; rejects with an Error carrying stdout/stderr/code/killed (killed = time limit hit).
 */
export function runSandboxed(file, args, { input, cwd, timeoutMs = 2000, memMB = 512, maxProcs = 1, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir,
      TEMP: cwd, TMP: cwd, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    };
    const p = execFile(RUNNER, [String(timeoutMs), String(memMB), String(maxProcs), cwd, file, ...args],
      { cwd, env, timeout: timeoutMs + 3000, maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr });
        err.stdout = stdout; err.stderr = stderr;
        if (typeof err.code === 'number') {
          err.killed = err.killed || err.code === EXIT_TIMEOUT;
          if (err.code === EXIT_RUNNER_ERROR) err.message = 'sandbox error: ' + (stderr || '').trim().slice(0, 300);
          else err.message = describeExit(err.code);
        }
        reject(err);
      });
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}
