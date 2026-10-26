#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { MIRAGE_TOOLS, MIRAGE_LIFECYCLE, mirageToolHelp } from '../mirage/tool-registry.mjs';

const HELP = `paqvilo — Power Pages development

Usage: paqvilo lense <command> [options]
       paqvilo mirage <command> [options]
       paqvilo init [dir] [options]
       paqvilo setup [--config FILE | --project FILE] [--open]
       paqvilo dataverse <command> [options]
       paqvilo doctor --setup [--json] [--config FILE] [--browser CHANNEL]

  lense   Overlay local sources, inspect resources and browser sessions.
          dev, list, use, doctor, map, status, audit, resources, verify, agent, model-driven
  mirage  Render exported portals with Liquid and simulated Dataverse on loopback.
          demo, init, dev, start, status, stop, serve, inspect, data
          ${Object.keys(MIRAGE_TOOLS).join(', ')}
  doctor  Check installed dependencies and browser readiness.
  init    Scaffold a consumer project; --check, --ready and --refresh-editor maintain it.
  setup   Local configuration workspace at /_setup/, including incomplete projects.
  dataverse  Register a provisioning app, plan/apply metadata, publish and export.

Run paqvilo lense --help, paqvilo mirage --help or paqvilo dataverse --help for options.
`;
const argv = process.argv.slice(2);
const [product, ...args] = argv;
// A flag after the option terminator is a positional value, never a request for help/JSON.
const hasFlag = (items, ...flags) =>
  items.slice(0, items.indexOf('--') < 0 ? items.length : items.indexOf('--')).some((arg) => flags.includes(arg));
function failure(error, code, label = 'paqvilo', items = args) {
  if (hasFlag(items, '--json'))
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message: error.message } }));
  else console.error(`${label}: ${error.message.replace(/[\r\n]+/g, ' ')}`);
  process.exitCode = 1;
}
const exitStatus = (code, signal) => code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
if (['--version', '-v', '--help', '-h'].includes(product)) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' } },
    });
    console.log(values.help ? HELP : JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
  } catch (error) {
    failure(error, 'INVALID_ARGUMENT', 'paqvilo', argv);
  }
} else if (product === undefined) {
  console.log(HELP);
} else if (product === 'setup' || (['lense', 'mirage'].includes(product) && args[0] === 'setup')) {
  const setupArgs = product === 'setup' ? args : args.slice(1);
  try {
    process.exitCode = await (await import('../lense/commands/setup.mjs')).runSetup(setupArgs);
  } catch (error) {
    failure(error, 'SETUP_FAILED', 'paqvilo setup', setupArgs);
  }
} else if (product === 'init') {
  try {
    process.exitCode = await (await import('../lense/commands/init.mjs')).runInit(args);
  } catch (error) {
    failure(error, error.code ?? 'INIT_FAILED', 'paqvilo init');
  }
} else if (product === 'doctor' && hasFlag(args, '--help', '-h')) {
  console.log(
    'Usage: paqvilo doctor --setup [--json] [--config FILE] [--browser CHANNEL]\n\n  --setup    Check installed dependencies and browser readiness.\n  --json     Print the readiness report as JSON.\n  --config   Resolve the catalogue browser without importing portal sources.\n  --browser  Explicit browser channel, overriding the catalogue.',
  );
} else if (product === 'doctor') {
  try {
    const { values } = parseArgs({
      args,
      options: {
        setup: { type: 'boolean' },
        json: { type: 'boolean' },
        config: { type: 'string' },
        browser: { type: 'string' },
      },
    });
    if (!values.setup) throw new Error('doctor requires --setup. Run paqvilo doctor --help for options.');
    for (const key of ['config'])
      if (values[key] !== undefined && !values[key].trim()) throw new Error(`--${key} requires a non-empty value`);
    let browser = values.browser;
    if (browser !== undefined && !['msedge', 'chrome', 'chromium'].includes(browser))
      throw new Error('--browser must be msedge, chrome or chromium');
    if (values.config) {
      const { loadCatalogue } = await import('../lense/api.mjs');
      const catalogue = loadCatalogue({ config: values.config });
      browser ??= catalogue.settings.values.PAQVILO_BROWSER ?? catalogue.root.browser.channel;
    }
    if (browser !== undefined && !['msedge', 'chrome', 'chromium'].includes(browser))
      throw new Error('--browser must be msedge, chrome or chromium');
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../scripts/ensure-dependencies.mjs', import.meta.url)),
        '--check',
        ...(values.json ? ['--json'] : []),
        ...(browser ? ['--browser', browser] : []),
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    child.on('exit', (code, signal) => {
      process.exitCode = exitStatus(code, signal);
    });
    child.on('error', (error) => {
      failure(error, 'SETUP_CHECK_FAILED', 'paqvilo doctor');
    });
  } catch (error) {
    failure(error, 'SETUP_CHECK_FAILED', 'paqvilo doctor');
  }
} else if (product === 'mirage' && Object.hasOwn(MIRAGE_TOOLS, args[0]) && hasFlag(args, '--help', '-h')) {
  console.log(mirageToolHelp(args[0]));
} else if (!['lense', 'mirage', 'dataverse'].includes(product)) {
  const message = `Unknown command ${JSON.stringify(product)}. Choose lense, mirage, dataverse, init, setup or doctor. Run paqvilo --help for options.`;
  failure(new Error(message), 'UNKNOWN_PRODUCT', 'paqvilo', argv);
} else {
  const lifecycle = new Set(MIRAGE_LIFECYCLE);
  const tools = new Set(Object.keys(MIRAGE_TOOLS));
  let program, forwarded;
  if (product === 'dataverse') {
    program = '../lense/dataverse/cli.mjs';
    forwarded = args;
  } else if (product === 'lense') {
    program = '../lense/cli.mjs';
    forwarded = args;
  } else if (args[0] === 'demo') {
    program = '../lense/commands/demo.mjs';
    forwarded = args.slice(1);
  } else if (lifecycle.has(args[0])) {
    program = '../lense/cli.mjs';
    forwarded = ['mirage', ...args];
  } else if (tools.has(args[0])) {
    program = `../mirage/${args[0]}.mjs`;
    forwarded = args.slice(1);
  } else {
    program = '../mirage/cli.mjs';
    forwarded = args.length ? args : ['--help'];
    const overview = !args.length || ['--help', '-h', 'help'].includes(args[0]);
    if (overview) console.log(`Public Mirage tools:\n${Object.keys(MIRAGE_TOOLS).map(mirageToolHelp).join('')}`);
    if (overview && hasFlag(args, '--help', '-h'))
      console.log(
        'Mirage demo: paqvilo mirage demo (editable sample and development browser).\nMirage lifecycle: init, dev, start, status, stop (catalogue and browser options: paqvilo lense --help).',
      );
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL(program, import.meta.url)), ...forwarded], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (error) => {
    failure(error, 'SPAWN_FAILED');
  });
  child.on('exit', (code, signal) => {
    process.exitCode = exitStatus(code, signal);
  });
  // A terminal interrupt is also sent to the child; allow its browser/runtime cleanup to finish.
  process.on('SIGINT', () => {
    child.kill('SIGINT');
  });
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });
}
