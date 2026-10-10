// Copy an explicitly requested, invented project and run the normal Mirage browser lifecycle.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STARTER = path.join(ROOT, 'examples/project');
const MARKER = '.paqvilo/demo.json';

async function prepareEditorFiles(target) {
  const folder = path.join(target, '.vscode');
  await fs.mkdir(folder, { recursive: true });
  const info = await fs.lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Demo editor folder must be a regular directory: ${folder}`);
  for (const file of ['.vscode/tasks.json', '.vscode/launch.json', 'paqvilo-demo.code-workspace']) {
    try { await fs.copyFile(path.join(STARTER, file), path.join(target, file), constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

export async function prepareDemo(directory) {
  const target = path.resolve(directory);
  let existing = null;
  try { existing = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Demo folder must be a regular directory: ${target}`);
    let marker;
    try { marker = JSON.parse(await fs.readFile(path.join(target, MARKER), 'utf8')); } catch { /* not an owned demo */ }
    if (marker?.kind === 'paqvilo-example' && marker.version === 2) {
      for (const name of ['paqvilo.config.yml', 'portal/website.yml', 'pack/pack.mjs']) await fs.access(path.join(target, name));
      await prepareEditorFiles(target);
      return { directory: target, created: false };
    }
    // Never replace the user's project, including an incomplete earlier copy.
    if ((await fs.readdir(target)).length) throw new Error(`Folder is not a Paqvilo demo: ${target}. Choose a new folder with --dir <path>. No files were changed.`);
  } else await fs.mkdir(target, { recursive: true });

  for (const name of ['portal', 'solution', 'code-solution', 'metadata', 'pack', 'test', 'components', 'deployment', '.vscode', 'paqvilo-demo.code-workspace', 'paqvilo.config.yml', 'README.md']) {
    await fs.cp(path.join(STARTER, name), path.join(target, name), {
      recursive: true, errorOnExist: true, force: false,
      // A development checkout can contain build outputs absent from the npm archive.
      filter: (source) => !path.relative(STARTER, source).split(path.sep).some((part) => ['node_modules', '.paqvilo', '.pp-local', 'bin', 'obj', 'out', 'coverage'].includes(part)) && !source.endsWith('.log'),
    });
  }
  await fs.copyFile(path.join(STARTER, 'gitignore.template'), path.join(target, '.gitignore'));
  const { version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(target, 'package.json'), JSON.stringify({
    name: 'paqvilo-example', private: true, type: 'module',
    scripts: {
      dev: 'paqvilo mirage dev --config ./paqvilo.config.yml --site example --port 0',
      'dev:debug': 'paqvilo mirage dev --config ./paqvilo.config.yml --site example --port 0 --debug-port 9222',
      lense: 'paqvilo lense dev --config ./paqvilo.config.yml --site example',
      test: 'node --test test/*.test.mjs',
    },
    devDependencies: { paqvilo: version },
  }, null, 2) + '\n', { flag: 'wx' });
  await fs.mkdir(path.join(target, '.paqvilo'), { recursive: true });
  await fs.writeFile(path.join(target, MARKER), JSON.stringify({ kind: 'paqvilo-example', version: 2 }) + '\n', { flag: 'wx' });
  return { directory: target, created: true };
}

async function runDemo() {
  const { values, positionals } = parseArgs({ options: {
    dir: { type: 'string', default: './paqvilo-example' }, browser: { type: 'string' },
    headless: { type: 'boolean' }, 'debug-port': { type: 'string' }, scaffold: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (positionals.length) throw new Error('demo accepts options only; use --dir <path> to choose its folder');
  if (values.help) {
    console.log(`Usage: paqvilo mirage demo [--dir ./paqvilo-example] [--browser msedge|chrome|chromium]

Copies a populated, editable sample project and opens it in the development browser.
Uses a free loopback port. Re-running keeps source edits and restores the sample dataset.
Close the browser or press Ctrl+C to stop. --headless and --debug-port are also supported.
Use --scaffold to prepare the project and VS Code workspace without starting a browser.`);
    return;
  }
  if (values.browser && !['msedge', 'chrome', 'chromium'].includes(values.browser)) throw new Error('--browser must be msedge, chrome or chromium');
  if (values['debug-port'] && !/^\d+$/.test(values['debug-port'])) throw new Error('--debug-port must be an integer');
  const demo = await prepareDemo(values.dir);
  if (values.scaffold) {
    console.log(`Mirage demo ${demo.created ? 'created' : 'reused'}: ${demo.directory}\nOpen ${path.join(demo.directory, 'paqvilo-demo.code-workspace')} in VS Code.\nSelect "Demo: Mirage and browser debugger" in Run and Debug, then press F5.\nNo runtime was started. Source edits stay in the demo folder.`);
    return;
  }
  console.log(`\nMirage demo ${demo.created ? 'created' : 'reused'}: ${demo.directory}
Loading 12 accounts, 24 contacts, field metadata and two notes with an attachment.
Opening the development browser. Keep this terminal running.

1. Click Sign in and choose Alex Example 01.
2. Open Web API, then Arcwell Services. Edit a field and add a related contact.
3. Compare the native list, its views and the Contacts modal.
4. Press Alt+Shift+P for Inspect and Tweaks; use /_sim/ for data and personas.
5. Edit portal/web-files/demo.css and save to see the local change.

6. Compare 14 PCF editors, Liquid components and Extended operations.
   Try a short account or contact name to check plugin validation.

Each demo start restores the sample dataset. Source edits stay in the demo folder.
Open paqvilo-demo.code-workspace in VS Code for prepared tasks and browser debugging.
Close the browser or press Ctrl+C to stop.\n`);
  const args = [path.join(ROOT, 'bin/paqvilo.mjs'), 'mirage', 'dev', '--config', path.join(demo.directory, 'paqvilo.config.yml'), '--site', 'example', '--portals', 'selected', '--port', '0', '--preset', 'example-demo'];
  if (values.browser) args.push('--browser', values.browser);
  if (values.headless) args.push('--headless');
  if (values['debug-port']) args.push('--debug-port', values['debug-port']);
  const child = spawn(process.execPath, args, { cwd: demo.directory, stdio: 'inherit', windowsHide: true });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1)); });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDemo().catch((error) => { console.error(`Mirage demo: ${error.message}`); process.exitCode = 1; });
}
