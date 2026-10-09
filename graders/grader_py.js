// graders/grader_py.js
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { scanPythonCode, describeHits, runtimeShellPrefix, maybeSandbox } from '../security/policy.js';

import { isWin, runSandboxed, resolveExe } from './run_win.js';
import { normalizeLimits, clip, cut, CLIP_CHARS, RUN_OUTPUT_BYTES } from './limits.js';

const pexec = promisify(exec);

export async function gradePY(sourceCode, tests, workdir, limits = {}) {
  const { timeLimitMs, memLimitMB } = normalizeLimits(limits);
  const clipN = Number.isFinite(limits?.clipChars) ? limits.clipChars : CLIP_CHARS;   // how much of each test's input/expected/output is kept

  // สแกนคำสั่งต้องห้าม
  const scan = scanPythonCode(sourceCode || '');
  if (!scan.ok) {
    return {
      compileOk: false,
      compileLog: `Forbidden APIs in Python:\n${describeHits(scan.hits)}`,
      compileMs: 0,
      results: []
    };
  }

  const src = path.join(workdir, 'main.py');
  await fs.writeFile(src, sourceCode, 'utf-8');

  const results = [];
  for (let i = 0; i < tests.length; i++) {
    if (limits?.signal?.aborted) break;   // the request ran out of time: stop launching more tests
    const { input, expected } = tests[i];
    try {
      const inFile = path.join(path.dirname(src), `in_${i}.txt`);
      await fs.writeFile(inFile, input ?? '', 'utf-8');

      // -I: isolated mode (ไม่อ่าน user site), -B: ไม่เขียน .pyc, -S: ไม่โหลด site
      const cmd = `python3 -I -B -S "${src}" < "${inFile}"`;
      const shell = runtimeShellPrefix(memLimitMB, timeLimitMs)
        + maybeSandbox(`timeout ${(timeLimitMs / 1000).toFixed(3)}s ${cmd}`);

      const r0 = Date.now();
      let stdout;
      if (isWin) {
        ({ stdout } = await runSandboxed(resolveExe('python'), ['-I', '-B', '-S', src],
          { input, cwd: path.dirname(src), timeoutMs: timeLimitMs, memMB: memLimitMB, maxProcs: 1, maxBuffer: RUN_OUTPUT_BYTES }));
      } else {
        ({ stdout } = await pexec(`bash -lc '${shell}'`, {
          timeout: timeLimitMs + 3000, maxBuffer: RUN_OUTPUT_BYTES
        }));
      }
      const runMs = Date.now() - r0;

      const out = (stdout ?? '').replace(/\r\n/g, '\n').trim();
      const exp = (expected ?? '').replace(/\r\n/g, '\n').trim();
      results.push({ idx: i + 1, input: clip(input, clipN), expected: clip(expected, clipN), got: clip(out, clipN), pass: out === exp, runMs, exitCode: 0, signal: null, timedOut: false });
    } catch (e) {
      results.push({
        idx: i + 1, input: clip(input, clipN), expected: clip(expected, clipN),
        got: clip((e.stdout || '').toString().trim(), clipN),
        pass: false,
        error: cut(e.stderr || e.message || '', 1000),
        runMs: 0,
        exitCode: e.code ?? null,
        signal: e.signal ?? null,
        timedOut: !!e.killed || e.code === 124
      });
    }
  }
  return { compileOk: true, compileLog: '', results, compileMs: null };
}
