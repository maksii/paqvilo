import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

// Only pinned npm's typed in-process lifecycle is progress. Console text is never an admission.
process.once('disconnect', () => process.exit(1));
// Run directly (with --help or anything else) there is no parent: one line says what to run, before any work.
if (!process.connected) {
  console.error(
    'audit-observer.mjs is not an entry point: scripts/audit-process.mjs loads it into npm with --import. Run npm run audit:dependencies instead.',
  );
  process.exit(1);
}
const config = await new Promise((resolve) => process.once('message', resolve));
if (config?.v !== 1 || typeof config.nonce !== 'string' || config.nonce.length !== 64)
  throw new Error('Missing audit observer configuration.');
const require = createRequire(import.meta.url);
const npmPackage = require(path.resolve(process.argv[1], '../../package.json'));
if (npmPackage.version !== '12.2.2') throw new Error('Audit observer requires npm 12.2.2.');
let sequence = 0;
const send = (packet) => process.send({ v: 1, nonce: config.nonce, seq: ++sequence, ...packet });
const hash = (value) => createHash('sha256').update(value).digest('hex');
send({ type: 'hello' });
let emptyBulkRequest = false;
process.on('log', (level, prefix, report, body) => {
  if (level === 'silly' && prefix === 'audit' && report === 'bulk request') {
    emptyBulkRequest =
      body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0;
    return;
  }
  if (level !== 'silly' || prefix !== 'audit report') return;
  // Arborist deliberately returns null without HTTP when its freshly prepared bulk body is empty.
  if (report === null && emptyBulkRequest) {
    send({ type: 'inventory', seeds: [] });
    return;
  }
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('Audit did not provide a fresh bulk report.');
  const seeds = Object.entries(report).flatMap(([name, entries]) =>
    entries.map((entry) => ({ name, source: entry.id })),
  );
  send({ type: 'inventory', seeds });
});
process.on('time', (action, name) => {
  if (!['start', 'end'].includes(action)) return;
  if (action === 'end' && name === 'command:audit') {
    send({ type: 'complete' });
    return;
  }
  const matched = /^metavuln:(calculate|load|packument|cache:get|cache:put):(.+)$/.exec(name);
  if (!matched) return;
  const [, phase, identity] = matched;
  if (phase === 'packument') {
    send({ type: 'work', action, kind: phase, name: identity, id: hash(identity) });
    return;
  }
  const split = /^security-advisory:([^:]+):(.+)$/.exec(identity);
  if (!split) throw new Error('Unexpected pinned npm metadata identity.');
  if (phase === 'calculate') send({ type: 'calculation', action, name: split[1], source: split[2] });
  else send({ type: 'work', action, kind: phase, name: split[1], id: hash(identity) });
});
// The parent controls lifetime; the IPC channel itself must not keep a completed npm command alive.
process.channel.unref();
