import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { componentContent, componentContentSpan, componentIdentity } from '../lense/portal-model.mjs';

test('content spans preserve exact offsets through comments, CDATA, processing instructions and quoted delimiters', () => {
  const prefix = '<?fixture text="<content>not a real opening</content>"?>\n<!-- <content>comment</content> -->\n';
  const opening = '<content data-note="quoted > delimiter">';
  const body = '<!-- </content> --><![CDATA[{"copy":"<content>literal</content>","count":7}]]>';
  const suffix = '</content>\n<!-- trailing </content> -->';
  const xml = prefix + opening + body + suffix;
  const span = componentContentSpan(xml);
  assert.deepEqual(span, { openStart: prefix.length, contentStart: prefix.length + opening.length, contentEnd: prefix.length + opening.length + body.length, closeEnd: prefix.length + opening.length + body.length + '</content>'.length });
  assert.equal(xml.slice(span.contentStart, span.contentEnd), body);
  assert.deepEqual(componentContent(xml), { copy: '<content>literal</content>', count: 7 });
});

test('fromIndex advances to the next real content element and multiple content bodies remain ambiguous', () => {
  const first = '<content>{"value":1}</content>';
  const between = '<!-- <content>fake</content> --><?fixture text="<content>fake</content>"?>';
  const second = '<content note=\'greater >\'>{"value":2}</content>';
  const xml = first + between + second;
  const one = componentContentSpan(xml);
  const two = componentContentSpan(xml, one.closeEnd);
  assert.equal(one.openStart, 0);
  assert.equal(two.openStart, first.length + between.length);
  assert.equal(xml.slice(two.contentStart, two.contentEnd), '{"value":2}');
  assert.equal(componentContent(xml), null);
});

test('malformed real markup is refused while fake records inside valid sections remain text', () => {
  for (const xml of ['<content ', '<content note="unterminated>', '<content <!--nested>','<!--> <content>{}</content>', '<![CDATA[unterminated']) assert.equal(componentContentSpan(xml), null);
  const xml = '<powerpagecomponent powerpagecomponentid="real"><content><![CDATA[{"copy":"<powerpagecomponent powerpagecomponentid=\'fake\'>"}]]></content></powerpagecomponent>';
  assert.equal(componentIdentity(xml), 'real');
  assert.deepEqual(componentContent(xml), { copy: "<powerpagecomponent powerpagecomponentid='fake'>" });
});

test('large incomplete content tags finish in a bounded worker with semantic refusal', { timeout: 10000 }, async () => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ componentContentSpan, componentIdentity }) => {
      const incomplete = '<content '.repeat(500000);
      const whitespace = '<powerpagecomponent' + ' '.repeat(1000000) + 'invalid/>';
      parentPort.postMessage([componentContentSpan(incomplete), componentIdentity(whitespace)]);
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { module: new URL('../lense/portal-model.mjs', import.meta.url).href } });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('XML cursor exceeded its worker deadline.')), 5000);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code) reject(new Error('XML cursor worker exited early.')); });
    });
    assert.deepEqual(result, [null, null]);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});
