// graders/grader_cpp.js
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { cppForbiddenDefines, scanCppCode, describeHits, runtimeShellPrefix, maybeSandbox } from '../security/policy.js';

import { isWin, runSandboxed, resolveExe } from './run_win.js';
import { normalizeLimits, clip, cut, CLIP_CHARS, RUN_OUTPUT_BYTES } from './limits.js';

const pexec = promisify(exec);

export async function gradeCPP(sourceCode, tests, workdir, limits = {}) {
  const { timeLimitMs, memLimitMB } = normalizeLimits(limits);
  const clipN = Number.isFinite(limits?.clipChars) ? limits.clipChars : CLIP_CHARS;   // how much of each test's input/expected/output is kept

  // reject forbidden APIs before the compiler ever sees the code
  const scan = scanCppCode(sourceCode || '');
  if (!scan.ok) {
    return {
      compileOk: false,
      compileMs: 0,
      compileLog: `Forbidden APIs in C++:\n${describeHits(scan.hits)}`,
      results: []
    };
  }

  const src = path.join(workdir, 'main.cpp');
  const bin = path.join(workdir, 'a.out');
  await fs.writeFile(src, sourceCode, 'utf-8');

  const compileFlags = [
    '-O2','-pipe','-std=c++17','-s',
    ...cppForbiddenDefines
  ];

  const t0 = Date.now();
  try {
    if (isWin) {
      // the compiler reads untrusted source (#include, .incbin, ...), so it runs sandboxed too
      await runSandboxed(resolveExe('g++'), [...compileFlags, '-o', bin, src],
        { cwd: workdir, timeoutMs: 20000, memMB: 2048, maxProcs: 8, maxBuffer: 5 * 1024 * 1024 });
    } else {
      await pexec(`g++ ${compileFlags.join(' ')} -o "${bin}" "${src}"`, {
        timeout: 20000, cwd: workdir, maxBuffer: 5 * 1024 * 1024
      });
    }
  } catch (e) {
    return {
      compileOk: false,
      compileMs: Date.now() - t0,
      compileLog: cut(e.stderr || e.stdout || e.message || '', 8000),
      results: []
    };
  }
  const compileMs = Date.now() - t0;

  const results = [];
  for (let i = 0; i < tests.length; i++) {
    if (limits?.signal?.aborted) break;   // the request ran out of time: stop launching more tests
    const { input, expected } = tests[i];
    try {
      const inFile = path.join(workdir, `in_${i}.txt`);
      await fs.writeFile(inFile, input ?? '', 'utf-8');

      const r0 = Date.now();
      let stdout;
      if (isWin) {
        ({ stdout } = await runSandboxed(bin, [], { input, cwd: workdir, timeoutMs: timeLimitMs, memMB: memLimitMB, maxProcs: 1, maxBuffer: RUN_OUTPUT_BYTES }));
      } else {
        const shell = runtimeShellPrefix(memLimitMB, timeLimitMs)
          + maybeSandbox(`timeout ${(timeLimitMs / 1000).toFixed(3)}s "${bin}" < "${inFile}"`);
        ({ stdout } = await pexec(`bash -lc '${shell}'`, {
          timeout: timeLimitMs + 3000, cwd: workdir, maxBuffer: RUN_OUTPUT_BYTES
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
  return { compileOk: true, compileMs, compileLog: '', results };
}
