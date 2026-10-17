#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { MIRAGE_TOOLS, MIRAGE_LIFECYCLE, mirageToolHelp } from '../mirage/tool-registry.mjs';

const HELP = `paqvilo — Power Pages development

Usage: paqvilo lense <command> [options]
       paqvilo mirage <command> [options]
       paqvilo init [dir] [options]
       paqvilo setup [--config FILE | --project FILE] [--open]
       paqvilo dataverse <command> [options]
       paqvilo doctor --setup [--json] [--browser CHANNEL]

  lense   Overlay local sources, inspect resources and browser sessions.
          dev, list, use, doctor, map, status, audit, resources, verify, agent
  mirage  Render exported portals with Liquid and simulated Dataverse on loopback.
          demo, init, dev, start, status, stop, serve, inspect, data
          ${Object.keys(MIRAGE_TOOLS).join(', ')}
  doctor  Check installed dependencies and browser readiness.
  init    Scaffold an empty consumer project; --check and --refresh-editor maintain it.
  setup   Local configuration workspace at /_setup/, including incomplete projects.
  dataverse  Register a provisioning app, plan/apply metadata, publish and export.

Run paqvilo lense --help, paqvilo mirage --help or paqvilo dataverse --help for options.
`;
const [product, ...args] = process.argv.slice(2);
if (['--version', '-v'].includes(product)) {
  console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
} else if (!product || ['--help', '-h'].includes(product)) {
  console.log(HELP);
} else if (product === 'setup' || ['lense', 'mirage'].includes(product) && args[0] === 'setup') {
  const setupArgs = product === 'setup' ? args : args.slice(1);
  try { process.exitCode = await (await import('../lense/commands/setup.mjs')).runSetup(setupArgs); }
  catch (error) {
    if (args.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'SETUP_FAILED', message: error.message } }));
    else console.error(`paqvilo setup: ${error.message}`);
    process.exitCode = 1;
  }
} else if (product === 'init') {
  try { process.exitCode = await (await import('../lense/commands/init.mjs')).runInit(args); }
  catch (error) {
    if (args.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: error.code ?? 'INIT_FAILED', message: error.message } }));
    else console.error(`paqvilo init: ${error.message.replace(/[\r\n]+/g, ' ')}`);
    process.exitCode = 1;
  }
} else if (product === 'doctor' && args.some(arg => ['--help', '-h'].includes(arg))) {
  console.log('Usage: paqvilo doctor --setup [--json] [--browser CHANNEL]\n\n  --setup    Check installed dependencies and browser readiness.\n  --json     Print the readiness report as JSON.\n  --browser  Browser channel to check (for example msedge or chromium).');
} else if (product === 'doctor' && args.includes('--setup')) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/ensure-dependencies.mjs', import.meta.url)), '--check', ...args.filter(arg => arg !== '--setup')], { stdio: 'inherit', windowsHide: true });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
} else if (product === 'mirage' && Object.hasOwn(MIRAGE_TOOLS, args[0]) && args.some(arg => ['--help', '-h'].includes(arg))) {
  console.log(mirageToolHelp(args[0]));
} else if (!['lense', 'mirage', 'dataverse'].includes(product)) {
  const message = `Unknown product "${product}". Choose lense, mirage or dataverse.`;
  if (args.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'UNKNOWN_PRODUCT', message } }));
  else console.error(`paqvilo: ${message}`);
  process.exitCode = 1;
} else {
  const lifecycle = new Set(MIRAGE_LIFECYCLE);
  const tools = new Set(Object.keys(MIRAGE_TOOLS));
  let program, forwarded;
  if (product === 'dataverse') {
    program = '../lense/dataverse/cli.mjs'; forwarded = args;
  } else if (product === 'lense') {
    program = '../lense/cli.mjs'; forwarded = args;
  } else if (args[0] === 'demo') {
    program = '../lense/commands/demo.mjs'; forwarded = args.slice(1);
  } else if (lifecycle.has(args[0])) {
    program = '../lense/cli.mjs'; forwarded = ['mirage', ...args];
  } else if (tools.has(args[0])) {
    program = `../mirage/${args[0]}.mjs`; forwarded = args.slice(1);
  } else {
    program = '../mirage/cli.mjs'; forwarded = args.length ? args : ['--help'];
    if (!args.length || args.some(arg => ['--help', '-h'].includes(arg))) console.log(`Public Mirage tools:\n${Object.keys(MIRAGE_TOOLS).map(mirageToolHelp).join('')}`);
    if (args.includes('--help') || args.includes('-h')) console.log('Mirage demo: paqvilo mirage demo (editable sample and development browser).\nMirage lifecycle: init, dev, start, status, stop (catalogue and browser options: paqvilo lense --help).');
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL(program, import.meta.url)), ...forwarded], { stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(`paqvilo: ${error.message}`); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
  // A terminal interrupt is also sent to the child; allow its browser/runtime cleanup to finish.
  process.on('SIGINT', () => { child.kill('SIGINT'); });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });
}
