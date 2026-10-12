#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { MIRAGE_TOOLS, mirageToolHelp } from '../mirage/tool-registry.mjs';

const HELP = `paqvilo — Power Pages development

Usage: paqvilo lense <command> [options]
       paqvilo mirage <command> [options]

  lense   Overlay local sources, inspect resources and browser sessions.
          dev, list, use, doctor, map, status, audit, resources, verify, agent
  mirage  Render exported portals with Liquid and simulated Dataverse on loopback.
          demo, init, dev, start, status, stop, serve, inspect, data, presets
          bootstrap-report, render-sweep, liquid-inventory, webapi-inventory,
          portal-matrix, parity-suite, liquid-conformance, acceptance

Run paqvilo lense --help or paqvilo mirage --help for options.
`;
const [product, ...args] = process.argv.slice(2);
if (['--version', '-v'].includes(product)) {
  console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
} else if (!product || ['--help', '-h'].includes(product)) {
  console.log(HELP);
} else if (product === 'doctor' && args.includes('--setup')) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/ensure-dependencies.mjs', import.meta.url)), '--check', ...args.filter(arg => arg !== '--setup')], { stdio: 'inherit', windowsHide: true });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
} else if (product === 'mirage' && Object.hasOwn(MIRAGE_TOOLS, args[0]) && args.some(arg => ['--help', '-h'].includes(arg))) {
  console.log(mirageToolHelp(args[0]));
} else if (!['lense', 'mirage'].includes(product)) {
  const message = `Unknown product "${product}". Choose lense or mirage.`;
  if (args.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'UNKNOWN_PRODUCT', message } }));
  else console.error(`paqvilo: ${message}`);
  process.exitCode = 1;
} else {
  const lifecycle = new Set(['init', 'dev', 'start', 'status', 'stop']);
  const tools = new Set(Object.keys(MIRAGE_TOOLS));
  let program, forwarded;
  if (product === 'lense') {
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
