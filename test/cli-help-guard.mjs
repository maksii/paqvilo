// Preloaded by cli-tool-help.test.mjs: help must remain entirely in the declarative dispatcher.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

const sources = new Map(
  [
    '../bin/paqvilo.mjs',
    '../lense/cli-options.mjs',
    '../lense/signal-forwarding.mjs',
    '../mirage/tool-registry.mjs',
    '../mirage/tool-options.mjs',
  ].map((name) => {
    const url = new URL(name, import.meta.url);
    return [url.href, fs.readFileSync(url, 'utf8')];
  }),
);
const refuse = () => {
  throw new Error('Help attempted an operational side effect');
};
for (const name of [
  'readFile',
  'readFileSync',
  'writeFile',
  'writeFileSync',
  'mkdir',
  'mkdirSync',
  'open',
  'openSync',
  'readdir',
  'readdirSync',
  'stat',
  'statSync',
  'access',
  'accessSync',
])
  fs[name] = refuse;
for (const name of ['readFile', 'writeFile', 'mkdir', 'open', 'readdir', 'stat', 'access']) fsp[name] = refuse;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = refuse;
net.connect = net.createConnection = net.Server.prototype.listen = refuse;
http.request = http.get = https.request = https.get = globalThis.fetch = refuse;
syncBuiltinESMExports();
registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:')) {
      if (!sources.has(url)) throw new Error('Help imported operational code: ' + url);
      return { format: 'module', source: sources.get(url), shortCircuit: true };
    }
    return next(url, context);
  },
});
