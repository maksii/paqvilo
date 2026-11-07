// @test-kind unproven: local model of shared pre/post image aliases; the registration refusals, image ids and handler images are invented data, not native captures
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import {
  pluginCatalogue,
  pluginPhaseRequiresCheckpoint,
  pluginUnsupported,
  runPluginPhase,
} from '../lib/exported-plugins.mjs';
import { solutionPluginRows } from '../lib/dataverse-plugin-registration.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';

const ORG = '10000000-0000-4000-8000-0000000000e0';
const STEP = '30000000-0000-4000-8000-0000000000e1';
const ID = '10000000-0000-4000-8000-0000000000e1';
const pre = (alias, attributes = []) => ({ name: alias, alias, type: 0, attributes });
const post = (alias, attributes = []) => ({ name: alias, alias, type: 1, attributes });
const both = (alias, attributes = []) => ({ name: alias, alias, type: 2, attributes });
const step = (images) => ({
  id: STEP,
  message: 'Update',
  entity: 'x_widget',
  unfiltered: false,
  messageFilterId: null,
  enabled: true,
  mode: 0,
  stage: 40,
  rank: 1,
  supportedDeployment: 0,
  images,
  typeName: 'Invented.Images',
  assemblyId: 'invented',
});
const DUPLICATE = 'Registered image aliases must be unique.';

// @test-kind observation: native registration probes round 2 'Reg2: Update duplicate image alias' accepted a pre image (type 0) and a post image (type 1) with one alias on one Update 40 step; a single native capture
test('a pre and a post image may share one alias', () => {
  assert.equal(pluginUnsupported(step([pre('dup'), post('dup')]), { images: true }), null);
  assert.equal(pluginUnsupported(step([pre('dup', ['x_a']), post('dup', ['x_b'])]), { images: true }), null);
});

// @test-kind unproven: same-side duplicate alias refusal is not captured (NATIVE accepted-registrations-runtime)
test('two images of one collection may not share an alias', () => {
  assert.equal(pluginUnsupported(step([pre('Image'), pre('Image')]), { images: true }), DUPLICATE);
  assert.equal(pluginUnsupported(step([both('Image'), pre('Image')]), { images: true }), DUPLICATE);
  assert.equal(pluginUnsupported(step([both('Image'), post('Image')]), { images: true }), DUPLICATE);
  assert.equal(pluginUnsupported(step([post('Image'), post('Image')]), { images: true }), DUPLICATE);
});

// @test-kind unproven: image row ids are derived locally (uuidV5 over the step and alias); no native capture of the ids
test('solution image rows keep distinct ids for a shared alias and the alias id otherwise', () => {
  const rowsFor = (images) =>
    solutionPluginRows({ assemblies: [], types: [], steps: [step(images)] }, { organizationId: ORG })
      .sdkmessageprocessingstepimage;
  const shared = rowsFor([pre('dup'), post('dup')]);
  assert.equal(shared.length, 2);
  assert.notEqual(shared[0].sdkmessageprocessingstepimageid, shared[1].sdkmessageprocessingstepimageid);
  assert.deepEqual(
    shared.map((row) => row.sdkmessageprocessingstepimageid),
    [
      uuidV5(ORG, `sdkmessageprocessingstepimage:${STEP}:0:dup`),
      uuidV5(ORG, `sdkmessageprocessingstepimage:${STEP}:1:dup`),
    ],
  );
  const unique = rowsFor([pre('before'), post('after')]);
  assert.deepEqual(
    unique.map((row) => row.sdkmessageprocessingstepimageid),
    [
      uuidV5(ORG, `sdkmessageprocessingstepimage:${STEP}:before`),
      uuidV5(ORG, `sdkmessageprocessingstepimage:${STEP}:after`),
    ],
  );
});

// @test-kind unproven: a JavaScript handler's pre and post images for a shared alias are the registrations' own attributes; execution of shared aliases is not captured
test('a handler step with a shared alias sees the pre values of its pre image and the post values of its post image', async () => {
  const state = emptyState();
  state.mappings.x_widget = { entitySet: 'x_widgets', idColumn: 'x_widgetid' };
  state.tables.x_widget = [{ x_widgetid: ID, x_a: 'A0', x_b: 'B0' }];
  const store = new DataStore({ state });
  const steps = [step([pre('dup', ['x_a']), post('dup', ['x_b'])])];
  const seen = [];
  const handlers = new Map([
    [
      STEP,
      (ctx) => {
        seen.push({ preImage: ctx.preImage, postImage: ctx.postImage });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  store.setPluginPipeline(
    (ctx) => runPluginPhase({ ...ctx, store, items, handlers }),
    () => true,
    (ctx) => pluginPhaseRequiresCheckpoint(items, ctx),
  );
  await store.transact(() => store.updateRecord('x_widget', ID, { x_a: 'A1', x_b: 'B1' }, { admin: true }), {
    incremental: true,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].preImage.x_a, 'A0');
  assert.equal(seen[0].preImage.x_b, undefined);
  assert.equal(seen[0].postImage.x_b, 'B1');
  assert.equal(seen[0].postImage.x_a, undefined);
});
