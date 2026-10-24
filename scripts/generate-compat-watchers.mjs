import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { watchJQuery } from './compat/jquery-watcher.mjs';
const root = new URL('../', import.meta.url);
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
    text = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
  const start = text.indexOf('  // BEGIN generated jQuery watcher'),
    end = text.indexOf('  // END generated jQuery watcher', start);
  if (start < 0 || end < start) throw Error('Missing generated watcher boundaries: ' + name);
  const next =
    text.slice(0, start) +
    '  // BEGIN generated jQuery watcher\n' +
    fragment +
    '\n  // END generated jQuery watcher' +
    text.slice(end + '  // END generated jQuery watcher'.length);
  if (process.argv.includes('--check')) {
    if (next !== text) throw Error('Regenerate compatibility watcher: ' + name);
  } else await fs.writeFile(file, next);
}
