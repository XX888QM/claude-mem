#!/usr/bin/env node
// Local development activation only. Default is a read-only plan. All changed
// bytes are backed up before the first write; rollback refuses later edits.
// Restore needs the same --memory-data-dir/--claude-config-dir/--codex-dir overrides.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, settingsTarget } from './resolve-data-dir.cjs';

const args = process.argv.slice(2);
const option = key => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => existsSync(file) ? readFileSync(file) : null;
const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const fail = message => { throw new Error(message); };
function safeTarget(file, boundary = path.dirname(file)) {
  for (let current = file; ; current = path.dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) fail(`Refusing symlink target: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === boundary || current === path.dirname(current)) break;
  }
}
function checkCurrent(file, hashes, boundary, message) {
  safeTarget(file, boundary);
  const current = read(file);
  if (!hashes.includes(current ? hash(current) : null)) fail(`${message}: ${file}`);
}
function atomicWrite(file, bytes, mode = 0o600, hashes, boundary = path.dirname(file), message = 'File changed during activation') {
  safeTarget(file, boundary);
  mkdirSync(path.dirname(file), { recursive: true });
  // A private, exclusively-created random directory keeps temporary bytes private.
  const temporaryDirectory = mkdtempSync(path.join(path.dirname(file), '.cmem-activation-'));
  const temporary = path.join(temporaryDirectory, 'payload');
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, mode);
    if (hashes) checkCurrent(file, hashes, boundary, message);
    else safeTarget(file, boundary);
    renameSync(temporary, file);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const home = homedir();
const claudeConfig = path.resolve(option('--claude-config-dir') || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
const codexHome = path.resolve(option('--codex-dir') || process.env.CODEX_HOME || path.join(home, '.codex'));
const explicitDataDir = option('--memory-data-dir');
if (explicitDataDir) process.env.CLAUDE_MEM_DATA_DIR = explicitDataDir;
const settingsFile = path.resolve(resolveDataDir(), 'settings.json');
const artifacts = ['scripts/worker-service.cjs', 'scripts/mcp-server.cjs', 'hooks/hooks.json', 'hooks/codex-hooks.json', 'skills/mem-search/SKILL.md'];
const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const installedTargets = version => [
  { root: path.join(claudeConfig, 'plugins/marketplaces/thedotmack/plugin'), instructions: path.join(claudeConfig, 'CLAUDE.md'), boundary: claudeConfig },
  { root: path.join(claudeConfig, `plugins/cache/thedotmack/claude-mem/${version}`), instructions: path.join(claudeConfig, 'CLAUDE.md'), boundary: claudeConfig },
  { root: path.join(codexHome, `plugins/cache/claude-mem-local/claude-mem/${version}`), instructions: path.join(codexHome, 'AGENTS.md'), boundary: codexHome },
];
const supportedFiles = version => new Map([
  ...installedTargets(version).flatMap(({ root, instructions, boundary }) => [
    ...artifacts.map(artifact => [path.join(root, artifact), boundary]), [instructions, boundary],
  ]),
  [settingsFile, path.dirname(settingsFile)],
]);
const restore = option('--restore');
if (restore) {
  const directory = path.resolve(restore);
  const manifestFile = path.join(directory, 'manifest.json');
  safeTarget(manifestFile, path.dirname(directory));
  const manifestBytes = readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (manifest.kind !== 'claude-mem-progressive-local-activation-v1' || typeof manifest.version !== 'string'
    || !releaseVersion.test(manifest.version) || !Array.isArray(manifest.files)) fail('Unrecognized backup manifest');
  const supported = supportedFiles(manifest.version), seen = new Set();
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  // Check EVERY affected file before restoring any of them.
  const files = manifest.files.map((entry, index) => {
    if (!entry || typeof entry.target !== 'string' || path.resolve(entry.target) !== entry.target
      || !supported.has(entry.target) || seen.has(entry.target) || !digest(entry.appliedHash)
      || !(entry.originalHash === null || digest(entry.originalHash))
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
      || entry.backup !== (entry.originalHash === null ? null : `${String(index).padStart(2, '0')}.bin`)) fail('Unsupported backup manifest entry; restore requires the same --memory-data-dir, --claude-config-dir and --codex-dir overrides used for activation');
    seen.add(entry.target);
    const boundary = supported.get(entry.target);
    checkCurrent(entry.target, [entry.appliedHash, entry.originalHash], boundary, 'Later edit detected; restore refused');
    let bytes = null;
    if (entry.backup !== null) {
      const backup = path.join(directory, entry.backup);
      safeTarget(backup, directory);
      bytes = readFileSync(backup);
      if (hash(bytes) !== entry.originalHash) fail(`Backup checksum mismatch: ${entry.target}`);
    }
    return { ...entry, boundary, bytes };
  });
  for (const entry of files) {
    const hashes = [entry.appliedHash, entry.originalHash];
    if (entry.bytes) atomicWrite(entry.target, entry.bytes, entry.mode, hashes, entry.boundary, 'Later edit detected; restore refused');
    else {
      checkCurrent(entry.target, hashes, entry.boundary, 'Later edit detected; restore refused');
      if (existsSync(entry.target)) rmSync(entry.target);
    }
  }
  // Leave the dedicated note directory and any user notes in place.
  atomicWrite(manifestFile, Buffer.from(JSON.stringify({ ...manifest, restoredAt: new Date().toISOString() }, null, 2)), 0o600, [hash(manifestBytes)]);
  console.log(`Restored ${manifest.files.length} files. Restart the local worker when idle.`);
  process.exit(0);
}

const workspaceArg = option('--workspace');
const project = option('--project');
if (!workspaceArg || !project?.trim()) fail('Provide --workspace <absolute checkout> and --project <project key>; use --apply to activate.');
const workspace = path.resolve(workspaceArg);
if (!statSync(workspace).isDirectory()) fail('Workspace must be an existing directory');
if (!args.includes('--no-restart')) fail('Include --no-restart; the caller controls when the local worker may restart.');
const source = option('--source-plugin') ? path.resolve(option('--source-plugin')) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugin');
const version = json(path.join(source, '.claude-plugin/plugin.json')).version;
if (!releaseVersion.test(version)) fail('Source plugin must have a release version');
const targets = installedTargets(version).filter(target => existsSync(target.root));
if (targets.length === 0) fail('No supported installed claude-mem plugin found for this version');
const supported = supportedFiles(version);
const changes = [];
const addChange = (target, bytes) => {
  safeTarget(target, supported.get(target));
  const original = read(target);
  if (original && original.equals(bytes)) return;
  changes.push({ target, bytes, original, mode: original ? statSync(target).mode & 0o777 : 0o600 });
};
for (const { root } of targets) {
  if (!statSync(root).isDirectory()) fail(`Plugin target must be a directory: ${root}`);
  const manifest = json(path.join(root, '.claude-plugin/plugin.json'));
  if (manifest.name !== 'claude-mem' || manifest.version !== version) fail(`Plugin/version mismatch: ${root}`);
  for (const artifact of artifacts) {
    const bytes = readFileSync(path.join(source, artifact));
    if (artifact.endsWith('worker-service.cjs') && (!bytes.includes(Buffer.from('claude-mem-retrieved-data')) || !bytes.includes(Buffer.from('sourceFingerprint')))) fail('Build the progressive worker with the native-memory bridge before activation');
    if (artifact.endsWith('mcp-server.cjs') && (!bytes.includes(Buffer.from('mem_search')) || !bytes.includes(Buffer.from('save_memory')))) fail('Build MCP mem_search/save_memory tools before activation');
    addChange(path.join(root, artifact), bytes);
  }
}

const start = '<!-- claude-mem-memory-instructions:start -->';
const end = '<!-- claude-mem-memory-instructions:end -->';
const instructionSource = readFileSync(path.resolve(source, '../src/shared/memory-instructions.ts'), 'utf8');
const instructions = instructionSource.match(/MEMORY_PLUGIN_INSTRUCTIONS = `([\s\S]*?)`;/)?.[1];
if (!instructions) fail('Could not read the versioned memory instruction text');
const block = `${start}\n${instructions}\n${end}`;
for (const file of new Set(targets.map(target => target.instructions))) {
  const original = read(file)?.toString('utf8') || '';
  const begin = original.indexOf(start), finish = original.indexOf(end);
  if ((begin < 0) !== (finish < 0) || (begin >= 0 && finish < begin)) fail(`Incomplete instruction block: ${file}`);
  const next = begin >= 0 ? original.slice(0, begin) + block + original.slice(finish + end.length) : `${original}${original.endsWith('\n') || !original ? '' : '\n'}\n${block}\n`;
  addChange(file, Buffer.from(next));
}

// The explicit CLI override wins; otherwise use the worker's tested directory
// resolver, including flat/nested settings redirects and home-relative paths.
const settings = existsSync(settingsFile) ? json(settingsFile) : {};
const container = settingsTarget(settings);
const memoryRoot = path.join(workspace, '.claude/memory');
const configured = container.CLAUDE_MEM_MEMORY_WATCH_ROOTS;
const roots = configured ? JSON.parse(configured) : [];
if (!Array.isArray(roots)) fail('Existing memory watch roots are not an array');
if (roots.some(root => root.path === memoryRoot && root.project !== project.trim())) fail('Dedicated folder is already assigned to another project');
if (!roots.some(root => root.path === memoryRoot && root.project === project.trim())) roots.push({ path: memoryRoot, project: project.trim() });
if (roots.length > 8) fail('The native-memory bridge supports at most 8 roots');
container.CLAUDE_MEM_MEMORY_WATCH_ROOTS = JSON.stringify(roots);
container.CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED = 'true';
container.CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED = 'true';
addChange(settingsFile, Buffer.from(JSON.stringify(settings, null, 2) + '\n'));

console.log(`Local progressive memory ${args.includes('--apply') ? 'activation' : 'dry run'}\nVersion: ${version}\nProject: ${project.trim()}\nNote folder: ${memoryRoot}\nWorker restart: caller-controlled\nFiles to change (${changes.length}):\n${changes.map(change => `- ${change.target}`).join('\n') || '- none'}`);
if (!args.includes('--apply')) process.exit(0);
if (changes.length === 0) { console.log('Already active; no files changed.'); process.exit(0); }

const backupRoot = path.join(workspace, '.agent-jobs/progressive-mem-search');
safeTarget(backupRoot, workspace);
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const directory = mkdtempSync(path.join(backupRoot, `activation-${new Date().toISOString().replace(/[:.]/g, '-')}-`));
const files = changes.map((change, index) => {
  const backup = change.original ? `${String(index).padStart(2, '0')}.bin` : null;
  if (backup) writeFileSync(path.join(directory, backup), change.original, { mode: 0o600, flag: 'wx' });
  return { target: change.target, backup, mode: change.mode, originalHash: change.original ? hash(change.original) : null, appliedHash: hash(change.bytes) };
});
const manifest = { kind: 'claude-mem-progressive-local-activation-v1', version, createdAt: new Date().toISOString(), memoryRoot, project: project.trim(), files };
atomicWrite(path.join(directory, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
mkdirSync(memoryRoot, { recursive: true });
for (const change of changes) {
  // Recheck immediately before the mutation; another agent may have edited it.
  atomicWrite(change.target, change.bytes, change.mode, [change.original ? hash(change.original) : null], supported.get(change.target), `File changed during activation; restore using ${directory}`);
}
console.log(`Activated local progressive memory. Backup: ${directory}. No worker restart performed.`);
