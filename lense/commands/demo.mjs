// Copy an explicitly requested, invented project and run the normal Mirage browser lifecycle.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { constants, cpSync } from 'node:fs';
import { assertScaffoldPath, prepareScaffoldDirectory } from '../scaffold.mjs';
import { forwardTerminationSignals } from '../signal-forwarding.mjs';
import { parseOptions } from '../cli-options.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STARTER = path.join(ROOT, 'examples/project');
const MARKER = '.paqvilo/demo.json';
const TEXT_FILES = /\.(?:mjs|js|ts|json|ya?ml|xml|html|css|md|txt|csv)$/i;
const MORE_TEXT_FILES = /\.(?:svg|resx|cs|csproj|config|ps1|cmd|sh|template)$/i;

// A fresh Git checkout must serve the same bytes as the copied scaffold.
// Normalize text at the boundary instead of inheriting the toolkit checkout's autocrlf.
// Files are normalized 32 at a time: one at a time took about 16 s for the demo on a loaded Windows machine.
async function normalizeText(directory) {
  const files = [];
  const walk = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && (TEXT_FILES.test(entry.name) || MORE_TEXT_FILES.test(entry.name))) files.push(file);
    }
  };
  await walk(directory);
  const normalize = async (file) => {
    const bytes = await fs.readFile(file);
    if (!bytes.includes(0) && bytes.includes(13))
      await fs.writeFile(file, bytes.toString('utf8').replace(/\r\n?/g, '\n'));
  };
  for (let index = 0; index < files.length; index += 32)
    await Promise.all(files.slice(index, index + 32).map(normalize));
}

async function prepareEditorFiles(target) {
  const folder = path.join(target, '.vscode');
  await assertScaffoldPath(folder, { directory: true });
  await fs.mkdir(folder, { recursive: true });
  const info = await fs.lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Demo editor folder must be a regular directory: ${folder}`);
  for (const file of ['.vscode/tasks.json', '.vscode/launch.json', 'paqvilo-demo.code-workspace', 'AGENTS.md']) {
    await assertScaffoldPath(path.join(target, file));
    try {
      await fs.copyFile(path.join(STARTER, file), path.join(target, file), constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

// A virus scanner or indexer can hold a handle in the staging folder for a moment; Windows reports that as a failed rename.
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 200;
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function renameIntoPlace(staging, target, { rename, wait }) {
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      await rename(staging, target);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has(error.code)) throw error;
      if (attempt === RENAME_ATTEMPTS)
        throw new Error(
          `Cannot move the demo from ${staging} to ${target} after ${RENAME_ATTEMPTS} attempts (${error.code}). Close programs that may use the staging folder and run the demo again.`,
          { cause: error },
        );
      await wait(RENAME_BACKOFF_MS * attempt);
    }
  }
}

export async function prepareDemo(directory, { copy = cpSync, rename = fs.rename, wait = sleep } = {}) {
  const target = await assertScaffoldPath(directory, { directory: true });
  let existing = null;
  try {
    existing = await fs.lstat(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    const reused = await reuseExistingDemo(target, existing);
    if (reused) return reused;
  }
  // The copy goes into a sibling staging folder, so an interrupted copy never leaves a partial target behind.
  const staging = await prepareScaffoldDirectory(`${target}.partial-${process.pid}`);
  try {
    await copyStarter(staging, copy);
    // An empty target from the user is replaced; reuseExistingDemo returned null, so it holds nothing.
    if (existing) await fs.rmdir(target);
    await renameIntoPlace(staging, target, { rename, wait });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { directory: target, created: true };
}

async function copyStarter(target, copy) {
  for (const name of [
    'portal',
    'solution',
    'code-solution',
    'code-app',
    'metadata',
    'pack',
    'test',
    'components',
    'deployment',
    'baseline',
    '.vscode',
    'paqvilo-demo.code-workspace',
    'paqvilo.config.yml',
    'README.md',
    'AGENTS.md',
  ]) {
    // Synchronous on purpose: on Windows async fs.cp took 20-30 s for the ~2,000-file sample, cpSync under 2 s.
    copy(path.join(STARTER, name), path.join(target, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
      // A development checkout can contain build outputs absent from the npm archive.
      filter: (source) =>
        !path
          .relative(STARTER, source)
          .split(path.sep)
          .some((part) => ['node_modules', '.paqvilo', 'bin', 'obj', 'out', 'coverage'].includes(part)) &&
        !source.endsWith('.log'),
    });
  }
  await fs.copyFile(path.join(STARTER, 'gitignore.template'), path.join(target, '.gitignore'));
  await fs.copyFile(path.join(STARTER, 'gitattributes.template'), path.join(target, '.gitattributes'));
  await fs.copyFile(path.join(STARTER, 'editor-workspace.mjs'), path.join(target, 'editor-workspace.mjs'));
  await normalizeText(target);
  const { version, dependencies } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const example = JSON.parse(await fs.readFile(path.join(STARTER, 'package.json'), 'utf8'));
  await fs.writeFile(
    path.join(target, 'package.json'),
    JSON.stringify(
      {
        name: 'paqvilo-example',
        private: true,
        type: 'module',
        scripts: {
          configure: 'paqvilo setup --config ./paqvilo.config.yml --open',
          dev: 'paqvilo mirage dev --config ./paqvilo.config.yml --site example --port 0',
          'dev:debug': 'paqvilo mirage dev --config ./paqvilo.config.yml --site example --port 0 --debug-port 9222',
          lense: 'paqvilo lense dev --config ./paqvilo.config.yml --site example',
          'code-app:mirage': example.scripts['code-app:mirage'],
          'code-app:dev': example.scripts['code-app:dev'],
          test: 'node --test test/*.test.mjs',
        },
        devDependencies: {
          paqvilo: version,
          yaml: dependencies.yaml,
          'playwright-core': dependencies['playwright-core'],
          '@microsoft/power-apps': example.devDependencies['@microsoft/power-apps'],
        },
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  await fs.mkdir(path.join(target, '.paqvilo'), { recursive: true });
  await fs.writeFile(path.join(target, MARKER), JSON.stringify({ kind: 'paqvilo-example', version: 2 }) + '\n', {
    flag: 'wx',
  });
}

async function interruptedCopies(target) {
  const parent = path.dirname(target);
  const prefix = `${path.basename(target)}.partial-`;
  return (await fs.readdir(parent)).filter((name) => name.startsWith(prefix)).map((name) => path.join(parent, name));
}

function interruptedCopyNote(leftovers) {
  return leftovers.length ? ` An interrupted copy left ${leftovers.join(', ')}. It can be deleted.` : '';
}

async function reuseExistingDemo(target, existing) {
  if (!existing) return null;
  if (!existing.isDirectory() || existing.isSymbolicLink())
    throw new Error(`Demo folder must be a regular directory: ${target}`);
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(path.join(target, MARKER), 'utf8'));
  } catch {
    /* not an owned demo */
  }
  if (marker?.kind === 'paqvilo-example' && marker.version === 2) {
    for (const name of ['paqvilo.config.yml', 'portal/website.yml', 'pack/pack.mjs'])
      await fs.access(path.join(target, name));
    await prepareEditorFiles(target);
    return { directory: target, created: false };
  }
  // Never replace the user's project, including an incomplete earlier copy.
  if ((await fs.readdir(target)).length) {
    const leftovers = await interruptedCopies(target);
    throw new Error(
      `Folder is not a Paqvilo demo: ${target}. Choose a new folder with --dir <path>. No files were changed.${interruptedCopyNote(leftovers)}`,
    );
  }
  return null;
}

function validateDemoOptions(values) {
  for (const [key, value] of Object.entries(values)) {
    const entries = Array.isArray(value) ? value : [value];
    if (entries.some((item) => typeof item === 'string' && !item.trim()))
      throw new Error(`--${key} must not be empty or whitespace`);
  }
  if (values.browser && !['msedge', 'chrome', 'chromium'].includes(values.browser))
    throw new Error('--browser must be msedge, chrome or chromium');
  if (
    values['debug-port'] !== undefined &&
    (!/^\d+$/.test(values['debug-port']) || Number(values['debug-port']) > 65535)
  )
    throw new Error('--debug-port must be an integer between 0 and 65535');
  if (values.scaffold && (values.browser !== undefined || values.headless || values['debug-port'] !== undefined))
    throw new Error('--scaffold cannot be combined with browser, headless or debug-port options');
}

// Repeated string options keep their last value. parseOptions refuses repeats unless an option is `multiple`.
const lastValue = (value) => (Array.isArray(value) ? value.at(-1) : value);

export function parseDemoOptions(args) {
  const { values, positionals } = parseOptions({
    args,
    options: {
      dir: { type: 'string', multiple: true },
      browser: { type: 'string', multiple: true },
      headless: { type: 'boolean' },
      'debug-port': { type: 'string', multiple: true },
      scaffold: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const chosen = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, lastValue(value)]));
  return { values: { dir: './paqvilo-example', ...chosen }, positionals };
}

async function runDemo() {
  const { values, positionals } = parseDemoOptions(process.argv.slice(2));
  if (positionals.length) throw new Error('demo accepts options only; use --dir <path> to choose its folder');
  if (values.help) {
    console.log(`Usage: paqvilo mirage demo [--dir ./paqvilo-example] [--browser msedge|chrome|chromium]

Copies a populated, editable sample project and opens it in the development browser.
Uses a free loopback port. Re-running keeps source edits and restores the sample dataset.
Close the browser or press Ctrl+C to stop. --headless and --debug-port are also supported.
Use --scaffold to prepare the project and VS Code workspace without starting a browser.`);
    return;
  }
  validateDemoOptions(values);
  const demo = await prepareDemo(values.dir);
  if (values.scaffold) {
    console.log(
      `Mirage demo ${demo.created ? 'created' : 'reused'}: ${demo.directory}\nOpen ${path.join(demo.directory, 'paqvilo-demo.code-workspace')} in VS Code.\nSelect "Demo: Mirage and browser debugger" in Run and Debug, then press F5.\nNo runtime was started. Source edits stay in the demo folder.`,
    );
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
  const args = [
    path.join(ROOT, 'bin/paqvilo.mjs'),
    'mirage',
    'dev',
    '--config',
    path.join(demo.directory, 'paqvilo.config.yml'),
    '--site',
    'example',
    '--portals',
    'selected',
    '--port',
    '0',
    '--preset',
    'example-demo',
  ];
  if (values.browser) args.push('--browser', values.browser);
  if (values.headless) args.push('--headless');
  if (values['debug-port']) args.push('--debug-port', values['debug-port']);
  const child = spawn(process.execPath, args, { cwd: demo.directory, stdio: 'inherit', windowsHide: true });
  const stopForwarding = forwardTerminationSignals(child);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    stopForwarding();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  /* NOSONAR: module-level promise chain must not block evaluation */ runDemo().catch((error) => {
    console.error(`Mirage demo: ${error.message}`);
    process.exitCode = 1;
  });
}
