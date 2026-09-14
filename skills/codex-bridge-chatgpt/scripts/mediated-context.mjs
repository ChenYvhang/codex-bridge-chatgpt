import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { containsLikelySecret } from './validate-context.mjs';
import { buildResponseContextManifest } from './context-manifest.mjs';
import { estimateTokens } from './token-budget.mjs';

const OPERATIONS = new Set(['read_file', 'search', 'git_diff', 'latest_receipt']);
const BASE_DENIES = [
  /(?:^|\/)(?:\.git|\.codex|node_modules)(?:\/|$)/i,
  /(?:^|\/)\.env(?:\.|$)/i, /(?:^|\/)(?:credentials|secrets|service-account[^/]*)\.json$/i,
  /(?:^|\/)(?:credentials|secrets)$/i,
  /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.|$)/i,
  /(?:^|\/)\.(?:ssh|aws|gnupg)(?:\/|$)/i,
  /(?:^|\/)(?:\.npmrc|\.netrc|_netrc|\.git-credentials)$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
];
const NOISE_DIRS = new Set(['.git', '.codex', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache', '.venv', 'target']);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function normalizeRelative(value) { return value.split(sep).join('/'); }
function sameOrInside(root, candidate) {
  const fold = (value) => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
  const base = fold(root);
  const item = fold(candidate);
  return item === base || item.startsWith(`${base}${sep}`);
}
function allowedKeys(value, keys) { return Object.keys(value).every((key) => keys.includes(key)); }
function globRegex(pattern) {
  const marker = pattern.replace(/\\/g, '/').replace(/\*\*/g, '\u0000').replace(/\*/g, '\u0001');
  const escaped = marker.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\u0000/g, '.*').replace(/\u0001/g, '[^/]*');
  return new RegExp(`^${escaped}(?:/.*)?$`, 'i');
}

export function validateContextQuery(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['request must be an object'];
  if (!allowedKeys(value, ['schema_version', 'bridge_id', 'conversation_scope_id', 'round', 'request_id', 'requests'])) errors.push('request has unknown top-level fields');
  if (value.schema_version !== 1) errors.push('schema_version must be 1');
  if (typeof value.bridge_id !== 'string' || !value.bridge_id) errors.push('bridge_id must be non-empty');
  if (!/^[a-f0-9]{64}$/.test(value.conversation_scope_id ?? '')) errors.push('conversation_scope_id must be a lowercase SHA-256 value');
  if (!Number.isInteger(value.round) || value.round < 1) errors.push('round must be a positive integer');
  if (typeof value.request_id !== 'string' || !value.request_id.trim()) errors.push('request_id must be non-empty');
  if (!Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > 8) errors.push('requests must contain 1-8 operations');
  const ids = new Set();
  for (const [index, request] of (value.requests ?? []).entries()) {
    const prefix = `requests[${index}]`;
    if (!request || typeof request !== 'object' || Array.isArray(request)) { errors.push(`${prefix} must be an object`); continue; }
    if (typeof request.id !== 'string' || !request.id.trim()) errors.push(`${prefix}.id must be non-empty`);
    else if (ids.has(request.id)) errors.push(`${prefix}.id is duplicated`);
    else ids.add(request.id);
    if (!OPERATIONS.has(request.kind)) errors.push(`${prefix}.kind is invalid`);
    const keys = {
      read_file: ['id', 'kind', 'path', 'start_line', 'end_line'],
      search: ['id', 'kind', 'query', 'path', 'limit'],
      git_diff: ['id', 'kind', 'mode', 'path', 'max_bytes'],
      latest_receipt: ['id', 'kind'],
    }[request.kind] ?? [];
    if (!allowedKeys(request, keys)) errors.push(`${prefix} has unknown fields`);
    if (request.kind === 'read_file' && typeof request.path !== 'string') errors.push(`${prefix}.path is required`);
    if (request.kind === 'read_file' && request.start_line !== undefined && (!Number.isInteger(request.start_line) || request.start_line < 1)) errors.push(`${prefix}.start_line is invalid`);
    if (request.kind === 'read_file' && request.end_line !== undefined && (!Number.isInteger(request.end_line) || request.end_line < 1)) errors.push(`${prefix}.end_line is invalid`);
    if (request.kind === 'search' && (typeof request.query !== 'string' || request.query.trim().length < 2)) errors.push(`${prefix}.query must contain at least two characters`);
    if (request.kind === 'search' && request.path !== undefined && typeof request.path !== 'string') errors.push(`${prefix}.path is invalid`);
    if (request.kind === 'search' && request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50)) errors.push(`${prefix}.limit is invalid`);
    if (request.kind === 'git_diff' && request.mode !== undefined && !['unstaged', 'staged', 'head'].includes(request.mode)) errors.push(`${prefix}.mode is invalid`);
    if (request.kind === 'git_diff' && request.path !== undefined && typeof request.path !== 'string') errors.push(`${prefix}.path is invalid`);
    if (request.kind === 'git_diff' && request.max_bytes !== undefined && (!Number.isInteger(request.max_bytes) || request.max_bytes < 1024 || request.max_bytes > 131072)) errors.push(`${prefix}.max_bytes is invalid`);
  }
  return errors;
}

export class SecureContextReader {
  constructor(root, customPatterns = []) {
    this.root = root;
    this.customPatterns = customPatterns.map(globRegex);
  }

  static async open(root) {
    const canonical = await realpath(resolve(root));
    let patterns = [];
    try { patterns = (await readFile(join(canonical, '.codexbridgeignore'), 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')); }
    catch (error) { if (error?.code !== 'ENOENT') throw new Error('IGNORE_FILE_UNAVAILABLE'); }
    return new SecureContextReader(canonical, patterns);
  }

  denied(rel) { return BASE_DENIES.some((pattern) => pattern.test(rel)) || this.customPatterns.some((pattern) => pattern.test(rel)); }

  async path(requested = '.') {
    if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0') || isAbsolute(requested)) throw new Error('INVALID_PATH');
    const lexical = resolve(this.root, requested);
    if (!sameOrInside(this.root, lexical)) throw new Error('PATH_OUTSIDE_WORKSPACE');
    if (this.denied(normalizeRelative(relative(this.root, lexical)) || '.')) throw new Error('ACCESS_DENIED');
    const candidate = await realpath(lexical);
    if (!sameOrInside(this.root, candidate)) throw new Error('PATH_OUTSIDE_WORKSPACE');
    const rel = normalizeRelative(relative(this.root, candidate)) || '.';
    if (this.denied(rel)) throw new Error('ACCESS_DENIED');
    return { absolute: candidate, relative: rel };
  }

  async readText(requested, { startLine = 1, endLine = null } = {}) {
    const target = await this.path(requested);
    const info = await stat(target.absolute);
    if (!info.isFile()) throw new Error('NOT_A_FILE');
    if (info.size > 1024 * 1024) throw new Error('FILE_TOO_LARGE');
    const raw = await readFile(target.absolute);
    if (raw.subarray(0, 8192).includes(0)) throw new Error('BINARY_FILE');
    const lines = raw.toString('utf8').split(/\r?\n/);
    const start = Math.max(1, Math.floor(Number(startLine) || 1));
    const requestedEnd = endLine === null || endLine === undefined ? start + 399 : Math.floor(Number(endLine));
    const end = Math.max(start, Math.min(requestedEnd, start + 399, lines.length));
    const content = lines.slice(start - 1, end).join('\n');
    return { path: target.relative, start_line: start, end_line: end, total_lines: lines.length, has_more: end < lines.length, content };
  }

  async search(query, { path: requested = '.', limit = 30 } = {}) {
    const target = await this.path(requested);
    const cap = Math.max(1, Math.min(50, Math.floor(Number(limit) || 30)));
    const matches = [];
    const needle = query.toLocaleLowerCase();
    const visit = async (absolute, rel) => {
      if (matches.length >= cap) return;
      const info = await lstat(absolute).catch(() => null);
      if (!info) return;
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) {
        for (const entry of await readdir(absolute, { withFileTypes: true })) {
          if (NOISE_DIRS.has(entry.name)) continue;
          const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`;
          if (this.denied(childRel)) continue;
          await visit(join(absolute, entry.name), childRel);
          if (matches.length >= cap) break;
        }
      } else if (info.isFile() && info.size <= 1024 * 1024) {
        const raw = await readFile(absolute);
        if (raw.subarray(0, 8192).includes(0)) return;
        for (const [index, line] of raw.toString('utf8').split(/\r?\n/).entries()) {
          if (line.toLocaleLowerCase().includes(needle)) matches.push({ path: rel, line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= cap) break;
        }
      }
    };
    await visit(target.absolute, target.relative);
    return { query, path: target.relative, matches, truncated: matches.length >= cap };
  }

  async gitDiff({ mode = 'unstaged', path = null, maxBytes = 65536 } = {}) {
    let rel = null;
    if (path) rel = (await this.path(path)).relative;
    const base = ['diff', '--no-renames'];
    if (mode === 'staged') base.push('--cached');
    else if (mode === 'head') base.push('HEAD');
    const namesRun = spawnSync('git', [...base, '--name-only', '-z', '--', ...(rel ? [rel] : [])], { cwd: this.root, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
    if (namesRun.status !== 0) throw new Error('GIT_DIFF_FAILED');
    const safePaths = (namesRun.stdout ?? '').split('\0').filter(Boolean).map((name) => name.replace(/\\/g, '/')).filter((name) => !this.denied(name));
    const args = [...base, '--', ...safePaths];
    const cap = Math.max(1024, Math.min(131072, Math.floor(Number(maxBytes) || 65536)));
    const run = safePaths.length === 0 ? { status: 0, stdout: '' } : spawnSync('git', args, { cwd: this.root, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    if (run.status !== 0) throw new Error('GIT_DIFF_FAILED');
    const raw = run.stdout ?? '';
    const content = Buffer.from(raw).subarray(0, cap).toString('utf8');
    return { mode, path: rel, truncated: Buffer.byteLength(raw, 'utf8') > cap, content };
  }
}

export async function executeContextQuery({ query, reader, latestReceipt = null, maxTokens = 2000 }) {
  const errors = validateContextQuery(query);
  if (errors.length) throw new Error(errors.join('; '));
  const items = [];
  for (const request of query.requests) {
    try {
      let data;
      if (request.kind === 'read_file') data = await reader.readText(request.path, { startLine: request.start_line, endLine: request.end_line });
      else if (request.kind === 'search') data = await reader.search(request.query, { path: request.path, limit: request.limit });
      else if (request.kind === 'git_diff') data = await reader.gitDiff({ mode: request.mode, path: request.path, maxBytes: request.max_bytes });
      else data = latestReceipt;
      if (containsLikelySecret(data)) items.push({ id: request.id, kind: request.kind, status: 'denied', error: 'SENSITIVE_CONTENT' });
      else items.push({ id: request.id, kind: request.kind, status: 'ok', sha256: sha256(JSON.stringify(data)), data });
    } catch (error) {
      const known = new Set(['INVALID_PATH', 'PATH_OUTSIDE_WORKSPACE', 'ACCESS_DENIED', 'NOT_A_FILE', 'FILE_TOO_LARGE', 'BINARY_FILE', 'GIT_DIFF_FAILED']);
      const code = known.has(error?.message) ? error.message
        : error?.code === 'ENOENT' ? 'NOT_FOUND'
          : ['EACCES', 'EPERM'].includes(error?.code) ? 'ACCESS_DENIED' : 'CONTEXT_READ_FAILED';
      items.push({ id: request.id, kind: request.kind, status: 'denied', error: code });
    }
  }
  const response = { schema_version: 1, bridge_id: query.bridge_id, conversation_scope_id: query.conversation_scope_id, round: query.round, request_id: query.request_id, request_sha256: sha256(JSON.stringify(query)), items, context_manifest: buildResponseContextManifest(items) };
  response.response_sha256 = sha256(JSON.stringify(response));
  const ceiling = Math.min(2500, Math.floor(Number(maxTokens)));
  const tokens = estimateTokens(response);
  if (!Number.isFinite(ceiling) || ceiling < 1) throw new Error('max tokens must be positive');
  if (tokens > ceiling) throw new Error(`context response exceeds its approximate-token budget: ${tokens} > ${ceiling}`);
  return { response, approximate_tokens: tokens, max_tokens: ceiling };
}
