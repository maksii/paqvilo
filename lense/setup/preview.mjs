// Quick setup support for /_setup/: find the exports in a project folder, list the running local previews of this
// configuration, and start, stop or restart them through the paqvilo CLI. Only local Mirage previews are started or
// stopped; Lense (live portals) is never launched from here. Nothing in this module runs pack code.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectSourceDialect } from '../../mirage/lib/source-dialect.mjs';

const SKIP = new Set(['node_modules', 'dist', 'coverage', 'bin', 'obj']);
const posix = file => file.split(path.sep).join('/');
const relative = (from, file, prefix = '') => {
  const result = path.relative(from, file);
  return !result ? '.' : result.startsWith('..') || path.isAbsolute(result) ? file : `${prefix}${posix(result)}`;
};
const firstMatch = async (file, pattern) => {
  try { return (await fs.readFile(file, 'utf8')).slice(0, 8192).match(pattern)?.[1]?.trim().replace(/^["']|["']$/g, '') || null; } catch { return null; }
};

/** What a folder holds: a portal export ({ type: 'website', label, name }), an unpacked Solution ({ type: 'solution', name }) or null. */
export async function folderKind(folder, entries = null) {
  try { entries ??= await fs.readdir(folder, { withFileTypes: true }); } catch { return null; }
  const names = new Set(entries.map(entry => entry.name));
  if (['website.yml', 'website.yaml', 'powerpagecomponents', '.powerpages-site'].some(name => names.has(name))) {
    const layout = detectSourceDialect(folder);
    if (layout.imported) {
      const website = names.has('website.yml') ? 'website.yml' : names.has('website.yaml') ? 'website.yaml' : null;
      return { type: 'website', label: layout.label, name: website ? await firstMatch(path.join(folder, website), /^(?:adx_name|mspp_name|name):\s*(.+)$/m) : null };
    }
  }
  // A Solution names the apps it carries by folder: AppModules (model-driven) and CanvasApps.
  if (names.has('Other') && fsSync.existsSync(path.join(folder, 'Other', 'Solution.xml'))) return { type: 'solution', name: await firstMatch(path.join(folder, 'Other', 'Solution.xml'), /<UniqueName>([^<]+)<\/UniqueName>/),
    apps: { modelDriven: names.has('AppModules'), canvas: names.has('CanvasApps') } };
  return null;
}

/**
 * Portal exports, unpacked Solutions and data pack modules (`pack.mjs`) below `root`, nearest first. Dot folders,
 * node_modules and build output are skipped; a found export is not searched inside.
 * ponytail: bounded breadth-first walk (depth 4, 4000 folders); a project with exports deeper than that types the path.
 */
export async function scanExports(root, { maxDepth = 4, maxFolders = 4000 } = {}) {
  const found = { portals: [], solutions: [], packs: [] };
  let queue = [[path.resolve(root), 0]], visited = 0;
  while (queue.length && visited < maxFolders) {
    const next = [];
    for (const [folder, depth] of queue) {
      if (++visited > maxFolders) break;
      let entries;
      try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { continue; }
      const kind = await folderKind(folder, entries);
      if (kind?.type === 'website') { found.portals.push({ dir: folder, kind: kind.label, name: kind.name }); continue; }
      if (kind?.type === 'solution') { found.solutions.push({ dir: folder, name: kind.name, apps: kind.apps }); continue; }
      const names = new Set(entries.map(entry => entry.name));
      if (names.has('pack.mjs')) found.packs.push({ file: path.join(folder, 'pack.mjs') });
      if (depth < maxDepth) for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) next.push([path.join(folder, entry.name), depth + 1]);
    }
    queue = next;
  }
  return found;
}

/** The scan with each path as the configuration writes it: sources and Solutions from the source root, packs from the configuration folder. */
export async function exportCandidates({ directory, sourceRoot = directory }) {
  const found = await scanExports(directory);
  const shown = dir => relative(directory, dir, './');
  return {
    portals: found.portals.map(item => ({ ...item, path: shown(item.dir), value: relative(sourceRoot, item.dir) })),
    solutions: found.solutions.map(item => ({ ...item, path: shown(item.dir), value: relative(sourceRoot, item.dir) })),
    packs: found.packs.map(item => ({ ...item, path: shown(item.file), value: relative(directory, item.file, './') })),
  };
}

/**
 * One folder of the setup folder picker: its subfolders (dot folders and build output hidden, at most 500), each with what
 * it holds, and the folder written as the configuration writes it (`value`, from the source root). Read-only.
 */
export async function listFolders({ directory, sourceRoot = directory, folder }) {
  const current = path.resolve(directory, folder || '.');
  let entries;
  try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (error) { throw Object.assign(new Error(`This folder cannot be opened (${error.code ?? error.message}).`), { status: 400 }); }
  const names = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)).map(entry => entry.name).sort((a, b) => a.localeCompare(b)).slice(0, 500);
  const folders = await Promise.all(names.map(async name => ({ name, path: path.join(current, name), kind: await folderKind(path.join(current, name)) })));
  const parent = path.dirname(current);
  return { path: current, shown: relative(directory, current, './'), value: relative(sourceRoot, current), parent: parent === current ? null : parent, kind: await folderKind(current, entries), folders };
}

/** `preferred` when it is free on loopback, else a free port the system chooses. */
export async function freePort(preferred = 8787) {
  const { createServer } = await import('node:net');
  const attempt = port => new Promise(resolve => {
    const server = createServer().once('error', () => resolve(null)).listen(port, '127.0.0.1', () => { const { port: bound } = server.address(); server.close(() => resolve(bound)); });
  });
  return (await attempt(preferred)) ?? attempt(0);
}

const samePath = (a, b) => Boolean(a && b) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
/** Running local previews of this configuration, each matched to its site by source folder, else by state folder name. */
export async function previewSessions({ kind, file, sites = [] }) {
  const { mirageStatus, miragePaths } = await import('../commands/mirage.mjs');
  const sessions = await mirageStatus(miragePaths(null, kind === 'project' ? { project: file } : { config: file }));
  return sessions.filter(session => session.processAlive && session.url).map(session => {
    const site = sites.find(item => samePath(item.sourceDir, session.sourceDir))
      ?? sites.find(item => session.stateFile && path.basename(path.dirname(session.stateFile)) === item.id);
    return { site: site?.id ?? null, url: session.url, adminUrl: session.adminUrl ?? null, ready: session.ready === true, owned: session.owned === true, pid: session.pid,
      links: session.runtime?.links ?? null, kind: session.runtime?.runtime?.kind ?? session.runtime?.kind ?? null };
  });
}

const ACTIONS = new Set(['start', 'stop', 'restart']);
const operationFile = file => path.join(path.dirname(file), '.paqvilo', 'setup', 'preview-operation.json');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
/** The last start, stop or restart: { action, site, state: running | done | failed, step, message, at }. */
export async function previewOperation(file) {
  try {
    const value = JSON.parse(await fs.readFile(operationFile(file), 'utf8'));
    // A runner that died without a final record failed; a failure older than the configuration file no longer describes it.
    if (value.state === 'running' && !alive(value.pid)) return { ...value, state: 'failed', message: value.message ?? 'The preview operation stopped unexpectedly.' };
    if (value.state === 'failed' && Date.parse(value.at) < (await fs.stat(file).then(stat => stat.mtimeMs, () => 0))) return null;
    return value;
  } catch { return null; }
}
/**
 * Starts, stops or restarts the local preview of `site` in a detached runner, so a restart outlives the preview that
 * serves this page. One operation at a time.
 */
export async function runPreviewOperation({ kind, file, site = null, action }) {
  if (!ACTIONS.has(action)) throw Object.assign(new Error('Choose start, stop or restart.'), { status: 400 });
  const current = await previewOperation(file);
  if (current?.state === 'running') throw Object.assign(new Error('Another preview operation is still running; wait for it to finish.'), { status: 409 });
  const target = operationFile(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const runner = fileURLToPath(new URL('./preview-runner.mjs', import.meta.url));
  const child = spawn(process.execPath, [runner, target, action, kind === 'project' ? '--project' : '--config', file, site ?? ''], { cwd: path.dirname(file), detached: true, stdio: 'ignore', windowsHide: true });
  const record = { action, site, state: 'running', step: action === 'restart' ? 'stop' : action, pid: child.pid, at: new Date().toISOString() };
  await fs.writeFile(target, JSON.stringify(record));
  child.unref();
  return record;
}
