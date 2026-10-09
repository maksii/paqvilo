import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createSimulator } from 'paqvilo/mirage/server.mjs';
import { DataStore } from 'paqvilo/mirage/lib/data.mjs';
import { discoverPacks, presetLibrary } from 'paqvilo/mirage/lib/preset-registry.mjs';
import { signInHeaders } from 'paqvilo/mirage/testing/session.mjs';

test('our portal renders anonymous and signed-in sessions with our registered pack', async (t) => {
  const module = fileURLToPath(new URL('../pack/pack.mjs', import.meta.url));
  const packs = await discoverPacks({ explicit: [{ module }] });
  const store = new DataStore();
  await store.applyPreset('example-demo', { generatedPresets: presetLibrary({ packs }) });
  const simulator = await createSimulator({
    sourceDir: fileURLToPath(new URL('../portal/', import.meta.url)),
    initial: store.snapshot(), dataPacks: [{ module }], port: 0, watch: false,
  });
  t.after(() => simulator.close());
  const anonymous = await fetch(simulator.url);
  assert.equal(anonymous.status, 200);
  assert.match(await anonymous.text(), /Anonymous/);
  const headers = signInHeaders(simulator, '11111111-1111-4111-8111-111111111111');
  const signedIn = await fetch(simulator.url, { headers });
  assert.equal(signedIn.status, 200);
  assert.match(await signedIn.text(), /Alex Example/);
});
