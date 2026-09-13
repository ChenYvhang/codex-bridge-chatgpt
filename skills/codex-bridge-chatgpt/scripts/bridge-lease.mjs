import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function leasePaths(directory) {
  const root = resolve(directory);
  const lock = join(root, '.write-lease');
  return { root, lock, owner: join(lock, 'owner.json'), heartbeat: join(lock, 'heartbeat') };
}

async function readOwner(paths) {
  try {
    return JSON.parse(await readFile(paths.owner, 'utf8'));
  } catch {
    return null;
  }
}

async function lockAge(paths, owner) {
  try {
    return Date.now() - (await stat(paths.heartbeat)).mtimeMs;
  } catch { /* fall back to immutable ownership metadata */ }
  const timestamp = Date.parse(owner?.heartbeat_at ?? owner?.acquired_at ?? '');
  if (Number.isFinite(timestamp)) return Date.now() - timestamp;
  try {
    return Date.now() - (await stat(paths.lock)).mtimeMs;
  } catch {
    return 0;
  }
}

async function reclaimIfStale(paths, staleMs) {
  const owner = await readOwner(paths);
  const age = await lockAge(paths, owner);
  if (age <= staleMs || processAlive(owner?.pid)) return false;
  const quarantine = `${paths.lock}.stale-${randomUUID()}`;
  try {
    await rename(paths.lock, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function writeOwner(paths, owner, flag = undefined) {
  await writeFile(paths.owner, `${JSON.stringify(owner, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, ...(flag ? { flag } : {}),
  });
}

export async function acquireBridgeLease({ directory, operation, timeoutMs = 5000, staleMs = 30000, retryMs = 50 }) {
  if (!operation?.trim()) throw new Error('bridge lease requires an operation name');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new Error('lease timeout must be between 0 and 60000 ms');
  if (!Number.isInteger(staleMs) || staleMs < 1000 || staleMs > 300000) throw new Error('lease stale interval must be between 1000 and 300000 ms');
  const paths = leasePaths(directory);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const acquiredAt = new Date().toISOString();
    const owner = {
      schema_version: 1,
      lease_id: randomUUID(),
      pid: process.pid,
      process_started_at: PROCESS_STARTED_AT,
      operation,
      acquired_at: acquiredAt,
      heartbeat_at: acquiredAt,
    };
    try {
      await mkdir(paths.lock, { recursive: false, mode: 0o700 });
      await writeOwner(paths, owner, 'wx');
      await writeFile(paths.heartbeat, '', { flag: 'wx', mode: 0o600 });
      let released = false;
      const heartbeat = setInterval(async () => {
        if (released) return;
        const current = await readOwner(paths);
        if (current?.lease_id !== owner.lease_id) return;
        const touched = new Date();
        try { await utimes(paths.heartbeat, touched, touched); } catch { /* acquisition remains fail closed */ }
      }, Math.max(500, Math.floor(staleMs / 3)));
      heartbeat.unref?.();

      return {
        owner,
        async release() {
          if (released) return true;
          released = true;
          clearInterval(heartbeat);
          const current = await readOwner(paths);
          if (current?.lease_id !== owner.lease_id) return false;
          const quarantine = `${paths.lock}.released-${owner.lease_id}`;
          try {
            await rename(paths.lock, quarantine);
          } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
          }
          await rm(quarantine, { recursive: true, force: true });
          return true;
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        try { await rm(paths.lock, { recursive: true, force: true }); } catch { /* retain original error */ }
        throw error;
      }
      if (await reclaimIfStale(paths, staleMs)) continue;
      if (Date.now() >= deadline) {
        const current = await readOwner(paths);
        throw new Error(`BRIDGE_BUSY: ${current?.operation ?? 'unknown operation'} holds the write lease`);
      }
      await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }
}

export async function withBridgeLease(options, callback) {
  const lease = await acquireBridgeLease(options);
  try {
    return await callback(lease.owner);
  } finally {
    await lease.release();
  }
}

export async function inspectBridgeLease(directory) {
  const paths = leasePaths(directory);
  const owner = await readOwner(paths);
  if (!owner) return { active: false };
  let heartbeatAt = owner.heartbeat_at ?? null;
  try { heartbeatAt = (await stat(paths.heartbeat)).mtime.toISOString(); } catch { /* immutable fallback */ }
  return {
    active: true,
    operation: owner.operation ?? null,
    owner_alive: processAlive(owner.pid),
    acquired_at: owner.acquired_at ?? null,
    heartbeat_at: heartbeatAt,
  };
}
