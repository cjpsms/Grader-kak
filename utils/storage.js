// utils/storage.js
import fs from 'fs/promises';
import path from 'path';

const locks = new Map();

export async function ensureFile(filePath, defaultContent = '[]') {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, defaultContent);
  }
}

// One FIFO queue per file. A failing job never blocks the jobs queued behind it.
export function withLock(filePath, fn) {
  const prev = locks.get(filePath) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  locks.set(filePath, tail);
  tail.then(() => { if (locks.get(filePath) === tail) locks.delete(filePath); });
  return run;
}

async function rawRead(filePath, fallback) {
  await ensureFile(filePath, JSON.stringify(fallback, null, 2));
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw || JSON.stringify(fallback));
}

// Atomic replace; retries because Windows can briefly hold the target (antivirus / indexer).
export async function renameWithRetry(tmp, dest) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, dest);
      return;
    } catch (e) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise(r => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}
async function rawWrite(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;   // unique per write
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  try {
    await renameWithRetry(tmp, filePath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

// Plain read for read-only endpoints. Writes are atomic renames, so this never sees a half-written file.
export async function readJSON(filePath, fallback = []) {
  try {
    return await rawRead(filePath, fallback);
  } catch {
    return fallback;
  }
}

export async function writeJSON(filePath, data) {
  return withLock(filePath, () => rawWrite(filePath, data));
}

export const NO_WRITE = Symbol('NO_WRITE');

// Read-modify-write under one lock, so concurrent requests can't overwrite each other's changes.
// `fn(data)` may mutate `data` in place (written back), return a replacement value, or return NO_WRITE to skip the write.
// Unlike readJSON, a corrupt file throws here instead of silently resetting the data to the fallback.
export function updateJSON(filePath, fn, fallback = []) {
  return withLock(filePath, async () => {
    const data = await rawRead(filePath, fallback);
    const out = await fn(data);
    if (out === NO_WRITE) return;
    await rawWrite(filePath, out === undefined ? data : out);
  });
}
