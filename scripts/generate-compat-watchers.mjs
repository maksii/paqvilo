import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { watchJQuery } from './compat/jquery-watcher.mjs';
const root = new URL('../', import.meta.url);
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/generate-compat-watchers.mjs [--check]
  (no option)   rewrite the generated jQuery watcher block in each mirage/lib/*-compat.js file
  --check       fail when a generated block differs from scripts/compat/jquery-watcher.mjs; writes nothing
  --help        print this help`);
  process.exit(0);
}
if (args.some((arg) => arg !== '--check')) {
  console.error(
    `generate-compat-watchers: unknown option ${args.find((arg) => arg !== '--check')}; run with --help to see supported options.`,
  );
  process.exit(1);
}
const names = [
  'mirage/lib/bootstrap-plugins-compat.js',
  'mirage/lib/datetimepicker-compat.js',
  'mirage/lib/jquery-blockui-compat.js',
  'mirage/lib/jqueryui-dialog-compat.js',
  'mirage/lib/jqueryui-widgets-compat.js',
];
const fragment = watchJQuery
  .toString()
  .split('\n')
  .map((line) => '  ' + line)
  .join('\n');
for (const name of names) {
  const file = fileURLToPath(new URL(name, root)),
    text = (await fs.readFile(file, 'utf8')).replaceAll('\r\n', '\n');
  const start = text.indexOf('  // BEGIN generated jQuery watcher'),
    end = text.indexOf('  // END generated jQuery watcher', start);
  if (start < 0 || end < start) throw new Error('Missing generated watcher boundaries: ' + name);
  const next =
    text.slice(0, start) +
    '  // BEGIN generated jQuery watcher\n' +
    fragment +
    '\n  // END generated jQuery watcher' +
    text.slice(end + '  // END generated jQuery watcher'.length);
  if (args.includes('--check')) {
    if (next !== text) throw new Error('Regenerate compatibility watcher: ' + name);
  } else await fs.writeFile(file, next);
}
