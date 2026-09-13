#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function normalized(path) { return path.split(sep).join('/'); }
function assertReleasePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`release policy contains an unsafe path: ${path}`);
  }
}

const crcTable = Array.from({ length: 256 }, (_, number) => {
  let value = number;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function collectDirectory(root, directory, excluded, output) {
  const absolute = join(root, directory);
  for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (excluded.has(entry.name)) continue;
    const path = join(absolute, entry.name);
    const rel = normalized(relative(root, path));
    if (entry.isSymbolicLink()) throw new Error(`release input contains a symbolic link: ${rel}`);
    if (entry.isDirectory()) await collectDirectory(root, rel, excluded, output);
    else if (entry.isFile()) output.push(rel);
  }
}

async function releaseFiles(root, policy) {
  for (const path of [...policy.root_files, ...policy.directories]) assertReleasePath(path);
  const files = [...policy.root_files];
  const excluded = new Set(policy.excluded_segments);
  for (const directory of policy.directories) {
    if (!(await lstat(join(root, directory))).isDirectory()) throw new Error(`release input is not a directory: ${directory}`);
    await collectDirectory(root, directory, excluded, files);
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

function gitValue(root, args, fallback) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return run.status === 0 ? run.stdout.trim() : fallback;
}

function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const localBuffer = Buffer.concat(locals);
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(localBuffer.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuffer, centralBuffer, end]);
}

export async function buildRelease({ root = repoRoot, requireClean = false } = {}) {
  const policy = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  if (policy.version !== version) throw new Error(`release policy version ${policy.version} does not match VERSION ${version}`);
  const sourceCommit = gitValue(root, ['rev-parse', 'HEAD'], process.env.SOURCE_COMMIT ?? 'UNKNOWN');
  const porcelain = gitValue(root, ['status', '--porcelain=v1', '--untracked-files=all'], 'UNKNOWN');
  const sourceState = porcelain === '' ? 'clean' : porcelain === 'UNKNOWN' ? 'unknown' : 'working-tree';
  if (requireClean && sourceState !== 'clean') throw new Error(`release requires a clean source tree; found ${sourceState}`);

  const paths = await releaseFiles(root, policy);
  const prefix = `${policy.name}-${version}/`;
  const entries = [];
  const inventory = [];
  for (const path of paths) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error(`release input is not a regular file: ${path}`);
    const data = await readFile(join(root, path));
    entries.push({ path: `${prefix}${path}`, data });
    inventory.push({ path, bytes: data.length, sha256: sha256(data) });
  }
  const buildManifest = {
    schema_version: 1,
    name: policy.name,
    version,
    source_commit: sourceCommit,
    source_state: sourceState,
    state_schema_version: policy.state_schema_version,
    context_schema_version: policy.context_schema_version,
    node: policy.node,
    archive_format: policy.archive_format,
    timestamp_policy: policy.timestamp_policy,
    runtime_dependencies: [],
    files: inventory,
  };
  const manifestData = Buffer.from(`${JSON.stringify(buildManifest, null, 2)}\n`, 'utf8');
  entries.push({ path: `${prefix}${policy.generated_manifest}`, data: manifestData });
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const archive = zipStored(entries);
  return {
    archive,
    archiveName: `${policy.name}-${version}.zip`,
    archiveSha256: sha256(archive),
    buildManifest,
  };
}

export async function writeRelease({ outputDirectory = join(repoRoot, 'dist', 'release'), requireClean = false, checkReproducible = false } = {}) {
  const first = await buildRelease({ requireClean });
  if (checkReproducible) {
    const second = await buildRelease({ requireClean });
    if (!first.archive.equals(second.archive)) throw new Error('release archive is not reproducible across repeated builds');
  }
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const archivePath = join(output, first.archiveName);
  await writeFile(archivePath, first.archive);
  await writeFile(join(output, 'SHA256SUMS'), `${first.archiveSha256}  ${first.archiveName}\n`, 'utf8');
  await writeFile(join(output, 'BUILD-MANIFEST.json'), `${JSON.stringify(first.buildManifest, null, 2)}\n`, 'utf8');
  return { archive_path: archivePath, archive_sha256: first.archiveSha256, reproducible: checkReproducible, source_commit: first.buildManifest.source_commit, source_state: first.buildManifest.source_state, file_count: first.buildManifest.files.length + 1 };
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    const outputIndex = argv.indexOf('--output');
    const result = await writeRelease({
      outputDirectory: outputIndex >= 0 ? argv[outputIndex + 1] : undefined,
      requireClean: argv.includes('--require-clean'),
      checkReproducible: argv.includes('--check-reproducible'),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
