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

// Deployment profile files of a website export: deployment-profiles/<name>.deployment.yml (pac pages download).
const PROFILE_FILE = /^(.+)\.deployment\.ya?ml$/i;
async function profilesOf(folder) {
  try { return (await fs.readdir(path.join(folder, 'deployment-profiles'))).map(name => [name, PROFILE_FILE.exec(name)?.[1]]).filter(([, name]) => name).map(([file, name]) => ({ name, file: `deployment-profiles/${file}` })); } catch { return []; }
}

/**
 * What a folder holds, or null: a website export ({ type: 'website', label, name, profiles }), an unpacked Solution
 * ({ type: 'solution', name, apps }), a canvas app source ({ type: 'canvas', name }: Src/*.pa.yaml or Src/*.fx.yaml), a code
 * app ({ type: 'codeApp', name }: power.config.json), deployment profiles ({ type: 'profiles', files }) or a sample data
 * module folder ({ type: 'pack' }: pack.mjs).
 */
export async function folderKind(folder, entries = null) {
  try { entries ??= await fs.readdir(folder, { withFileTypes: true }); } catch { return null; }
  const names = new Set(entries.map(entry => entry.name));
  if (['website.yml', 'website.yaml', 'powerpagecomponents', '.powerpages-site'].some(name => names.has(name))) {
    const layout = detectSourceDialect(folder);
    if (layout.imported) {
      const website = names.has('website.yml') ? 'website.yml' : names.has('website.yaml') ? 'website.yaml' : null;
      return { type: 'website', label: layout.label, name: website ? await firstMatch(path.join(folder, website), /^(?:adx_name|mspp_name|name):\s*(.+)$/m) : null, profiles: await profilesOf(folder) };
    }
  }
  // A Solution names the apps it carries by folder: AppModules (model-driven) and CanvasApps.
  if (names.has('Other') && fsSync.existsSync(path.join(folder, 'Other', 'Solution.xml'))) return { type: 'solution', name: await firstMatch(path.join(folder, 'Other', 'Solution.xml'), /<UniqueName>([^<]+)<\/UniqueName>/),
    apps: { modelDriven: names.has('AppModules'), canvas: names.has('CanvasApps') },
    // Canvas apps packed in the Solution, by name (CanvasApps/<name>.meta.xml), so a folder copy of one is recognised.
    canvasApps: names.has('CanvasApps') ? (await fs.readdir(path.join(folder, 'CanvasApps')).catch(() => [])).filter(name => name.endsWith('.meta.xml')).map(name => name.slice(0, -9)) : [] };
  if (names.has('Src')) {
    const source = await fs.readdir(path.join(folder, 'Src')).catch(() => []);
    if (source.some(name => /\.(?:pa|fx)\.yaml$/i.test(name))) return { type: 'canvas', name: path.basename(folder) };
  }
  if (names.has('power.config.json')) return { type: 'codeApp', name: path.basename(folder) };
  const profiles = entries.filter(entry => entry.isFile() && PROFILE_FILE.test(entry.name)).map(entry => ({ name: PROFILE_FILE.exec(entry.name)[1], file: entry.name }));
  if (profiles.length) return { type: 'profiles', files: profiles };
  if (names.has('pack.mjs')) return { type: 'pack' };
  return null;
}

/**
 * Portal exports, unpacked Solutions and data pack modules (`pack.mjs`) below `root`, nearest first. Dot folders,
 * node_modules and build output are skipped; a found export is not searched inside.
 * ponytail: bounded breadth-first walk (depth 4, 4000 folders); a project with exports deeper than that types the path.
 */
export async function scanExports(root, { maxDepth = 4, maxFolders = 4000 } = {}) {
  const found = { portals: [], solutions: [], packs: [], canvas: [], codeApps: [] };
  let queue = [[path.resolve(root), 0]], visited = 0;
  while (queue.length && visited < maxFolders) {
    const next = [];
    for (const [folder, depth] of queue) {
      if (++visited > maxFolders) break;
      let entries;
      try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { continue; }
      const kind = await folderKind(folder, entries);
      if (kind?.type === 'website') { found.portals.push({ dir: folder, kind: kind.label, name: kind.name, profiles: kind.profiles }); continue; }
      if (kind?.type === 'solution') { found.solutions.push({ dir: folder, name: kind.name, apps: kind.apps, canvasApps: kind.canvasApps }); continue; }
      if (kind?.type === 'canvas') { found.canvas.push({ dir: folder, name: kind.name }); continue; }
      if (kind?.type === 'codeApp') { found.codeApps.push({ dir: folder, name: kind.name }); continue; }
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
    // Canvas app folders and code apps resolve from the configuration folder, as the runtime reads them.
    // A canvas folder whose app a found Solution already packs (fxw_fieldapp beside fxw_fieldapp_1a2b3) names that Solution.
    canvas: found.canvas.map(item => ({ ...item, path: shown(item.dir), value: relative(directory, item.dir, './'),
      inSolution: found.solutions.find(solution => (solution.canvasApps ?? []).some(app => app === item.name || app.startsWith(`${item.name}_`)))?.name ?? null })),
    codeApps: found.codeApps.map(item => ({ ...item, path: shown(item.dir), value: relative(directory, item.dir, './') })),
  };
}

// Files the picker offers: website changes files (.deployment.yml), and deployment settings files (pac solution
// create-settings): .json files that name EnvironmentVariables or ConnectionReferences in their first 64 KiB.
const FILE_TYPES = { profile: { name: /\.deployment\.ya?ml$/i }, settings: { name: /\.json$/i, content: /"(?:EnvironmentVariables|ConnectionReferences)"\s*:/ } };
const holds = async (file, pattern) => { const handle = await fs.open(file).catch(() => null); if (!handle) return false;
  try { const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0); return pattern.test(buffer.subarray(0, bytesRead).toString('utf8')); } finally { await handle.close(); } };
/**
 * One folder of the setup folder picker: its subfolders (dot folders and build output hidden, at most 500), each with what
 * it holds, and the folder written as the configuration writes it (`value`, from the source root). Read-only.
 */
export async function listFolders({ directory, sourceRoot = directory, folder, files = null }) {
  const current = path.resolve(directory, folder || '.');
  let entries;
  try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (error) { throw Object.assign(new Error(`This folder cannot be opened (${error.code ?? error.message}).`), { status: 400 }); }
  const names = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)).map(entry => entry.name).sort((a, b) => a.localeCompare(b)).slice(0, 500);
  const folders = await Promise.all(names.map(async name => ({ name, path: path.join(current, name), kind: await folderKind(path.join(current, name)) })));
  const parent = path.dirname(current);
  // Files of one type (deployment profile and deployment settings files), each written as the configuration writes it.
  const type = FILE_TYPES[files], named = type ? entries.filter(entry => entry.isFile() && type.name.test(entry.name)).map(entry => entry.name).sort((a, b) => a.localeCompare(b)).slice(0, 500) : [];
  const listed = (await Promise.all(named.map(async name => (!type.content || await holds(path.join(current, name), type.content) ? name : null)))).filter(Boolean)
    .map(name => ({ name, path: path.join(current, name), value: relative(directory, path.join(current, name), './') }));
  return { path: current, shown: relative(directory, current, './'), value: relative(sourceRoot, current), config: relative(directory, current, './'), parent: parent === current ? null : parent, kind: await folderKind(current, entries), folders, files: listed };
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
    const saved = await fs.stat(file).then(stat => stat.mtimeMs, () => 0);
    if (value.state === 'failed' && Date.parse(value.at) < saved) return null;
    // Settings saved after a preview started here apply only once it restarts.
    return { ...value, settingsChanged: value.state === 'done' && value.action !== 'stop' && Date.parse(value.at) < saved };
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
