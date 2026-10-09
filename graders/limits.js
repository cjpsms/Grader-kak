// graders/limits.js — per-problem time / memory limits (shared by the server and both graders)
export const TIME_LIMIT = { min: 100, max: 10000, def: 2000 };   // ms, per test case
export const MEM_LIMIT = { min: 16, max: 1024, def: 256 };       // MB, per process

function clampInt(v, spec) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, n));
}

/** Always returns usable numbers; missing/garbage values (e.g. problems created before limits existed) fall back to defaults. */
export function normalizeLimits(src = {}) {
  return {
    timeLimitMs: clampInt(src?.timeLimitMs ?? TIME_LIMIT.def, TIME_LIMIT),
    memLimitMB: clampInt(src?.memLimitMB ?? MEM_LIMIT.def, MEM_LIMIT),
  };
}

// A run's stdout is capped (RUN_OUTPUT_BYTES) and, when stored in a submission's per-test results, clipped to CLIP_CHARS.
// Pass/fail is decided on the full (capped) output *before* clipping. Without this, a program that prints in an endless loop
// leaves up to RUN_OUTPUT_BYTES in memory per test and a 1000-test problem takes the whole server down (heap out of memory).
export const RUN_OUTPUT_BYTES = 1024 * 1024;
export const CLIP_CHARS = 2000;
// String.prototype.slice() returns a "sliced string" that keeps its whole parent alive in V8, so slicing a 1 MB output down to
// 2000 chars would still retain 1 MB per test. Copying through a Buffer makes a genuinely small, independent string.
export function detach(s) { return Buffer.from(String(s), 'utf8').toString('utf8'); }
/** First n chars of s as an independent (non-retaining) string. */
export function cut(s, n) { s = String(s ?? ''); return s.length > n ? detach(s.slice(0, n)) : detach(s); }
export function clip(s, n = CLIP_CHARS) {
  s = String(s ?? '');
  return s.length > n ? detach(s.slice(0, n)) + `… (+${s.length - n} chars)` : detach(s);
}

/** Strict parse for admin input: returns an integer in range, or null if it is not a number in range. */
export function parseLimit(value, spec) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) return null;
  return n;
}
