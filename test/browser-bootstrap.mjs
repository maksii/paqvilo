import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = fileURLToPath(new URL('./browser-backport.mjs', import.meta.url));
const preload = '--import=' + import.meta.url;
// This also covers ordinary owned CLI subprocesses and nested test runners.
// The hook stays lazy: a CLI that does not need Playwright never loads it.
if (!(process.env.NODE_OPTIONS || '').split(/\s+/).includes(preload))
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' ');

if (process.platform === 'win32') {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.startsWith('file:') || !/\/playwright-core\/index\.js$/.test(new URL(url).pathname)) return loaded;
      const directory = path.dirname(fileURLToPath(url));
      return {
        ...loaded,
        source:
          (typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8')) +
          `\nrequire(${JSON.stringify(helper)}).installChromiumBackport(module.exports.chromium, ${JSON.stringify(directory)});\n`,
      };
    },
  });
}

// Preserve the company's npm command and working directory while activating the
// same unshipped bootstrap used by the other repository browser entrypoints.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--npm' || !process.env.npm_execpath)
    throw new Error('The browser test launcher expects --npm under npm run');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...process.argv.slice(3)], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
