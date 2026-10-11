// graders/run_linux.js — Linux runner. Untrusted code (and the compiler that reads it) runs inside bubblewrap:
//   * new user/pid/net/ipc/uts/cgroup namespaces: no network, sees only its own processes
//   * a minimal filesystem: /usr read-only, its own scratch dir at /box, an empty /tmp — no $HOME, no data/, no /etc
//   * all capabilities dropped, killed together with the grader (--die-with-parent)
// and, when the service runs with a delegated cgroup (systemd `Delegate=yes`), one cgroup per run:
//   * memory.max (+ no swap) per run, OOM is reported as "memory limit exceeded"
//   * pids.max per run (no fork bombs), cgroup.kill on timeout kills every process of the run at once
// plus rlimits (CPU seconds, file size, open files, no core dumps) and a wall-clock timeout with an output cap.
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const isLinux = process.platform === 'linux';

export const EXIT_TIMEOUT = 124;

let cgRuns = null;   // delegated cgroup dir that per-run cgroups are created under (null = no cgroup limits)

function bwrapArgs(workdir, writable) {
  const a = [
    '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--proc', '/proc', '--dev', '/dev',
    '--size', String(64 * 1024 * 1024), '--tmpfs', '/tmp',
    writable ? '--bind' : '--ro-bind', workdir, '/box',
    '--chdir', '/box',
    '--hostname', 'box',
    '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'HOME', '/box',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
  ];
  return a;
}

function cgWrite(dir, file, value) { fs.writeFileSync(path.join(dir, file), String(value)); }

/** One-time setup; throws (fail closed) if bubblewrap can't run. Call before accepting submissions. */
export function initLinuxSandbox() {
  if (!isLinux) return;
  try {
    execFileSync('bwrap', [...bwrapArgs('/tmp', false), '/bin/true'], { stdio: 'pipe', timeout: 10000 });
  } catch (e) {
    throw new Error('bubblewrap (bwrap) is missing or cannot create namespaces: ' + (e.stderr?.toString() || e.message));
  }
  try {
    const rel = fs.readFileSync('/proc/self/cgroup', 'utf-8').match(/^0::(.*)$/m)?.[1];
    if (!rel) throw new Error('not on cgroup v2');
    const dir = path.join('/sys/fs/cgroup', rel);
    const ctrls = fs.readFileSync(path.join(dir, 'cgroup.controllers'), 'utf-8');
    if (!/\bmemory\b/.test(ctrls) || !/\bpids\b/.test(ctrls)) throw new Error('memory/pids controllers not delegated');
    // cgroup v2 "no internal processes": move the server into a leaf before enabling controllers for children
    const self = path.join(dir, 'server');
    fs.mkdirSync(self, { recursive: true });
    cgWrite(self, 'cgroup.procs', process.pid);
    cgWrite(dir, 'cgroup.subtree_control', '+memory +pids');
    const runs = path.join(dir, 'runs');
    fs.mkdirSync(runs, { recursive: true });
    cgWrite(runs, 'cgroup.subtree_control', '+memory +pids');
    for (const d of fs.readdirSync(runs)) {   // left behind by a crash
      if (!d.startsWith('run-')) continue;
      try { cgWrite(path.join(runs, d), 'cgroup.kill', 1); } catch {}
      try { fs.rmdirSync(path.join(runs, d)); } catch {}
    }
    cgRuns = runs;
    console.log('[sandbox] bubblewrap + per-run cgroups (memory, pids) at', runs);
  } catch (e) {
    cgRuns = null;
    console.warn('[sandbox] bubblewrap OK, but no delegated cgroup (' + e.message + ') — memory limited by RLIMIT_AS only, '
      + 'process count NOT limited. Run as the systemd service (Delegate=yes) for full limits.');
  }
}

async function removeCgroup(dir) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmdirSync(dir); return; }
    catch (e) {
      if (e.code === 'ENOENT') return;
      try { cgWrite(dir, 'cgroup.kill', 1); } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

/**
 * Run `cmd args` sandboxed with `workdir` mounted at /box (cmd/args must use /box paths for files in it).
 * Resolves { stdout, stderr } on exit code 0. Otherwise rejects with an Error carrying
 * stdout, stderr, code (124 on timeout), signal, killed (= timed out), oom, outputLimit — the same shape as child_process.exec errors.
 */
export function runBoxed(cmd, args, { input = '', workdir, writable = false, timeoutMs, memMB, maxProcs = 16, cpuSec, maxBuffer = 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    let cg = null;
    if (cgRuns) {
      cg = path.join(cgRuns, 'run-' + crypto.randomUUID());
      try {
        fs.mkdirSync(cg);
        cgWrite(cg, 'memory.max', Math.round(memMB) * 1024 * 1024);
        try { cgWrite(cg, 'memory.swap.max', 0); } catch {}
        cgWrite(cg, 'pids.max', maxProcs + 3);   // + bwrap's own monitor/init and the wrapper shell
      } catch (e) {
        removeCgroup(cg);
        return reject(Object.assign(new Error('cgroup setup failed: ' + e.message), { stdout: '', stderr: '' }));
      }
    }

    const limits = [
      `--cpu=${cpuSec ?? Math.ceil(timeoutMs / 1000) + 1}`,
      `--fsize=${64 * 1024 * 1024}`,
      '--nofile=64',
      '--core=0',
      `--stack=${Math.round(memMB) * 1024 * 1024}`,   // deep recursion is normal in contest code; memory.max still caps it
      ...(cg ? [] : [`--as=${Math.round(memMB) * 1024 * 1024}`]),
    ];
    const inner = ['prlimit', ...limits, '--', 'bwrap', ...bwrapArgs(workdir, writable), cmd, ...args];
    // the wrapper shell puts itself into the run's cgroup, then exec's the sandbox (same pid, so everything after inherits it)
    const child = cg
      ? spawn('/bin/sh', ['-c', 'echo $$ > "$0" && exec "$@"', path.join(cg, 'cgroup.procs'), ...inner], { stdio: 'pipe', detached: true })
      : spawn(inner[0], inner.slice(1), { stdio: 'pipe', detached: true });

    let out = [], outLen = 0, err = [], errLen = 0;
    let timedOut = false, outputLimit = false, done = false;
    const kill = () => {
      if (cg) { try { cgWrite(cg, 'cgroup.kill', 1); } catch {} }
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { timedOut = true; kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', d => {
      if (outLen >= maxBuffer) return;
      out.push(d); outLen += d.length;
      if (outLen >= maxBuffer) { outputLimit = true; kill(); }
    });
    child.stderr.on('data', d => { if (errLen < 64 * 1024) { err.push(d); errLen += d.length; } });
    child.stdin.on('error', () => {});   // program exited without reading all of stdin
    child.stdin.end(input ?? '');

    const finish = async (code, sig, spawnErr) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let oom = false;
      if (cg) {
        try { oom = /^oom_kill [1-9]/m.test(fs.readFileSync(path.join(cg, 'memory.events'), 'utf-8')); } catch {}
        await removeCgroup(cg);
      }
      const stdout = Buffer.concat(out).toString('utf-8');
      const stderr = Buffer.concat(err).toString('utf-8');
      if (!spawnErr && code === 0 && !timedOut && !outputLimit) return resolve({ stdout, stderr });
      const why = spawnErr ? spawnErr.message
        : timedOut ? `Time limit exceeded (${timeoutMs} ms)`
        : oom ? `Memory limit exceeded (${memMB} MB)`
        : outputLimit ? `Output limit exceeded (${maxBuffer} bytes)`
        : sig ? `Killed by signal ${sig}` : `Exited with code ${code}`;
      reject(Object.assign(new Error(why), {
        stdout, stderr: (spawnErr || timedOut || oom || outputLimit || sig) ? (stderr ? `${why}\n${stderr}` : why) : (stderr || why), code: timedOut ? EXIT_TIMEOUT : code, signal: sig, killed: timedOut, oom, outputLimit,
      }));
    };
    child.on('error', e => finish(null, null, e));
    child.on('close', (code, sig) => finish(code, sig));
  });
}
