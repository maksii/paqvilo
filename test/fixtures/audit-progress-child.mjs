import { createHash } from 'node:crypto';

const mode = process.argv[2];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const cache = (name, source) =>
  createHash('sha512')
    .update(JSON.stringify([name, source]))
    .digest('base64');
process.once('message', async ({ nonce }) => {
  let sequence = 0;
  const send = (packet) => new Promise((resolve) => process.send({ v: 1, nonce, seq: ++sequence, ...packet }, resolve));
  if (mode === 'absent') {
    process.stdout.write('{}');
    process.disconnect();
    return;
  }
  await send({ type: 'hello' });
  if (mode === 'cancel') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'overflow') {
    process.stdout.write('x'.repeat(8192));
    process.disconnect();
    return;
  }
  await send({
    type: 'inventory',
    seeds: [
      { name: 'alpha', source: 1 },
      { name: 'bravo', source: 2 },
    ],
  });
  for (const [name, source] of [
    ['alpha', 1],
    ['bravo', 2],
  ]) {
    await send({ type: 'calculation', action: 'start', name, source: String(source) });
    const work = (kind, action, id) => send({ type: 'work', action, kind, name, id: hash(id) });
    const identity = `security-advisory:${name}:${source}`;
    const cached = `security-advisory:${name}:${cache(name, source)}`;
    await work('cache:get', 'start', cached);
    await work('cache:get', 'end', cached);
    await work('packument', 'start', name);
    await work('packument', 'end', name);
    await work('load', 'start', identity);
    if (mode === 'hold') {
      setInterval(() => {}, 1000);
      return;
    }
    await work('load', 'end', identity);
    await send({ type: 'calculation', action: 'end', name, source: String(source) });
  }
  await send({ type: 'complete' });
  process.stdout.write('{"fresh":true}');
  process.disconnect();
});
