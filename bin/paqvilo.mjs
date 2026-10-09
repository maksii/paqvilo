#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELP = `paqvilo — Power Pages development

Usage: paqvilo lense <command> [options]
       paqvilo mirage <command> [options]

  lense   Overlay local sources, inspect resources and browser sessions.
          dev, list, use, doctor, map, status, audit, resources, verify, agent
  mirage  Render exported portals with Liquid and simulated Dataverse on loopback.
          init, dev, start, status, stop, serve, inspect, data, presets
          bootstrap-report, render-sweep, liquid-inventory, webapi-inventory,
          portal-matrix, parity-suite, liquid-conformance, acceptance

Run paqvilo lense --help or paqvilo mirage --help for options.
`;
const [product, ...args] = process.argv.slice(2);
if (!product || ['--help', '-h'].includes(product)) {
  console.log(HELP);
} else if (!['lense', 'mirage'].includes(product)) {
  const message = `Unknown product "${product}". Choose lense or mirage.`;
  if (args.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'UNKNOWN_PRODUCT', message } }));
  else console.error(`paqvilo: ${message}`);
  process.exitCode = 1;
} else {
  const lifecycle = new Set(['init', 'dev', 'start', 'status', 'stop']);
  const tools = new Set(['bootstrap-report', 'render-sweep', 'liquid-inventory', 'webapi-inventory', 'portal-matrix', 'parity-suite', 'liquid-conformance', 'acceptance']);
  let program, forwarded;
  if (product === 'lense') {
    program = '../lense/cli.mjs'; forwarded = args;
  } else if (lifecycle.has(args[0])) {
    program = '../lense/cli.mjs'; forwarded = ['mirage', ...args];
  } else if (tools.has(args[0])) {
    program = `../mirage/${args[0]}.mjs`; forwarded = args.slice(1);
  } else {
    program = '../mirage/cli.mjs'; forwarded = args.length ? args : ['--help'];
    if (args.includes('--help') || args.includes('-h')) console.log('Mirage lifecycle: init, dev, start, status, stop (catalogue and browser options: paqvilo lense --help).');
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL(program, import.meta.url)), ...forwarded], { stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(`paqvilo: ${error.message}`); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
  // A terminal interrupt is also sent to the child; allow its browser/runtime cleanup to finish.
  process.on('SIGINT', () => { child.kill('SIGINT'); });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });
}
