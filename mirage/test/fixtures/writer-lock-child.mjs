// Child writer for writer-lock-recovery.test.mjs: a Mirage runtime whose next record write stops at one named
// file-system step (the gate) and waits there until the parent ends it. argv[2] is JSON { options, gate }, where gate is
// { name, op, suffix, flag?, when: 'before' | 'after' }: the first `op` call (fs/promises) after the parent sends `write`
// with an argument ending in `suffix` (and naming `flag`) reports `{ gate: name }` before or after the call completes.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const { options, gate } = JSON.parse(process.argv[2]);
let armed = false;
const matches = (args) =>
  args.some((arg) => typeof arg === 'string' && arg.endsWith(gate.suffix)) && (!gate.flag || args.includes(gate.flag));
const stop = () => {
  armed = false;
  process.send({ gate: gate.name });
  return new Promise(() => {});
};
const original = fs[gate.op];
fs[gate.op] = async (...args) => {
  if (!armed || !matches(args)) return original.apply(fs, args);
  if (gate.when === 'before') return stop();
  await original.apply(fs, args);
  return stop();
};
// Named imports of node:fs/promises in the runtime see the gated function too.
syncBuiltinESMExports();

const { createSimulator } = await import('../../api.mjs');
const sim = await createSimulator(options);
process.on('message', async (message) => {
  if (message !== 'write') return;
  armed = true;
  try {
    await sim.store.create('x_item', { x_name: 'Interrupted' }, { admin: true });
    process.send({ done: true });
  } catch (error) {
    process.send({ failed: error.message });
  }
});
process.send({ ready: true });
