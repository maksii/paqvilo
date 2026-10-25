import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { installDomProvenance } from '../lense/dom-provenance.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
const scope = { documentId: 'invented-document', frameId: 'top', uiEpoch: 1, sourceRevision: 'invented-source' };
const options = {
  slot: '__inventedDomReader',
  secret: 'invented-private-writer-secret',
  binding: '__inventedDomBinding',
};
const proofFor = (id) => ({
  sourceRefs: [
    {
      id: 'source-' + id,
      key: 'source-' + id,
      ref: 'scripts/created.js',
      sourceRevision: scope.sourceRevision,
      contentRevision: 'invented-content',
    },
  ],
  facts: [{ id: 'fact-' + id, dimension: 'source', proof: 'observed-dom-callsite', sourceRefIds: ['source-' + id] }],
});
async function fixture(
  t,
  {
    html = '<main id="target"><b id="parser">Parser markup</b></main><aside id="other"></aside>',
    limit = 10000,
    counters = false,
  } = {},
) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const origin = 'http://127.0.0.1:11883',
    packets = [],
    scripts = new Map();
  await page.exposeBinding(options.binding, (_source, payload) => packets.push(JSON.parse(payload)));
  await context.addInitScript({
    content: `
    window.nativeDom = {createElement:Document.prototype.createElement,appendChild:Node.prototype.appendChild,append:Element.prototype.append,
      innerHTML:Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML'),cloneNode:Node.prototype.cloneNode};
    window.domReads=0;window.digestCalls=0;
    ${
      counters
        ? `for(const name of ['nodeType','parentNode','lastChild','previousSibling','ownerDocument','isConnected']) {
      const descriptor=Object.getOwnPropertyDescriptor(Node.prototype,name);
      Object.defineProperty(Node.prototype,name,{...descriptor,get:function(){window.domReads++;return Reflect.apply(descriptor.get,this,[])}});
    }
    const originalDigest=crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest=(...args)=>{window.digestCalls++;return originalDigest(...args)};`
        : ''
    }
    (${installDomProvenance.toString()})(${JSON.stringify({ ...options, limit })});
    //# sourceURL=paqvilo-tool://dom-provenance
  `,
  });
  await page.route(origin + '/**', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      contentType: scripts.has(url.pathname) ? 'application/javascript' : 'text/html',
      body: scripts.get(url.pathname) ?? html,
    });
  });
  await page.goto(origin);
  const writer = await page.evaluateHandle(({ slot, secret }) => window[slot].claim(secret), options);
  t.after(() => writer.dispose());
  const script = async (body, name = '/application.js') => {
    const url = new URL(name, origin);
    scripts.set(url.pathname, body);
    await page.evaluate(
      (url) =>
        new Promise((resolve, reject) => {
          const script = Reflect.apply(window.nativeDom.createElement, document, ['script']);
          script.src = url;
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Invented script failed'));
          Reflect.apply(window.nativeDom.appendChild, document.head, [script]);
        }),
      url.href,
    );
  };
  const query = (name) =>
    page.evaluate(
      ({ name, slot, scope }) =>
        window[slot].query(window[name] ?? document.getElementById(name), { scope, anchorGeneration: 7 }),
      { name, slot: options.slot, scope },
    );
  const settle = async () => {
    await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  const resolve = async () => {
    await settle();
    for (const packet of packets)
      await writer.evaluate((writer, { id, proof }) => writer.resolve(id, proof), {
        id: packet.id,
        proof: proofFor(packet.id),
      });
  };
  return { page, writer, packets, script, query, resolve, settle, origin };
}

test('creation, cloning, insertion and moves retain actual-node identity without emitting content or query values', async (t) => {
  const fx = await fixture(t);
  await fx.script(
    `function PRIVATE_FUNCTION_SENTINEL(){
    window.created=document.createElement('section');created.id='PRIVATE_ROW_SENTINEL';
    const input=document.createElement('input');input.name='PRIVATE_NAME_SENTINEL';input.value='PRIVATE_VALUE_SENTINEL';created.append(input);
    document.getElementById('target').append(created);
    window.cloned=created.cloneNode(true);document.getElementById('target').append(cloned);
    document.getElementById('target').insertAdjacentHTML('beforeend','<em id="inserted">PRIVATE_HTML_SENTINEL</em>');
    window.inserted=document.getElementById('inserted');
    window.parser=document.getElementById('parser');document.getElementById('other').appendChild(parser);
  }PRIVATE_FUNCTION_SENTINEL();`,
    '/application.js?private=PRIVATE_QUERY_SENTINEL',
  );
  const pending = await fx.query('created');
  assert.deepEqual(pending.facts, []);
  assert.deepEqual(pending.sourceRefs, []);
  assert.ok(pending.availability.some((item) => item.reason === 'creation-proof-pending'));
  assert.deepEqual(pending.scope, scope);
  assert.equal(pending.anchorGeneration, 7);
  await fx.resolve();
  for (const [name, relationship] of [
    ['created', 'created-by'],
    ['cloned', 'cloned-by'],
    ['inserted', 'created-by'],
    ['parser', 'attached-by'],
  ]) {
    const result = await fx.query(name);
    assert.equal(result.facts.length, 1, name);
    assert.equal(result.facts[0].predicate, relationship, name);
  }
  assert.notEqual((await fx.query('created')).facts[0].subject, (await fx.query('cloned')).facts[0].subject);
  assert.equal(
    await fx.page.evaluate((slot) => window[slot].isScriptCreated(window.parser), options.slot),
    false,
    'attachment does not relabel a parser node as script-created',
  );
  const original = (await fx.query('created')).facts[0].subject;
  await fx.script(`created.remove();`, '/detach.js');
  assert.deepEqual((await fx.query('created')).facts, []);
  await fx.script(`document.getElementById('other').append(created);`, '/move.js');
  assert.equal(
    (await fx.query('created')).facts[0].subject,
    original,
    'moving the same created node retains its creator',
  );
  const text = JSON.stringify(fx.packets);
  assert.doesNotMatch(text, /PRIVATE_(?:FUNCTION|ROW|NAME|VALUE|HTML|QUERY)_SENTINEL/);
  const expected = createHash('sha256')
    .update(fx.origin + '/application.js?private=PRIVATE_QUERY_SENTINEL')
    .digest('hex');
  assert.ok(
    fx.packets.some((packet) =>
      packet.frames.some((frame) => frame.url === fx.origin + '/application.js' && frame.urlKey === expected),
    ),
  );
  for (const packet of fx.packets) {
    assert.deepEqual(Object.keys(packet).sort(), ['frames', 'id', 'relationship', 'secret', 'version']);
    for (const frame of packet.frames)
      if (!frame.barrier) {
        assert.equal(/[?#]/.test(frame.url), false);
        assert.match(frame.urlKey, /^[a-f0-9]{64}$/);
        assert.ok(Number.isInteger(frame.line) && frame.line > 0 && Number.isInteger(frame.column) && frame.column > 0);
      }
  }
});

test('wrapped DOM methods preserve native receivers, return values and conversion failures', async (t) => {
  const fx = await fixture(t);
  const result = await fx.page.evaluate(() => {
    const a = document.createElement('i'),
      b = document.createElement('b'),
      parent = document.createElement('div');
    const appended = parent.appendChild(a) === a;
    const inserted = parent.insertBefore(b, a) === b;
    const replacement = document.createElement('u');
    const replaced = parent.replaceChild(replacement, b) === b;
    const appendedVoid = parent.append('text') === undefined;
    const errors = [];
    for (const method of [Document.prototype.createElement, Node.prototype.cloneNode]) {
      const original =
        method === Document.prototype.createElement ? window.nativeDom.createElement : window.nativeDom.cloneNode;
      const read = (fn) => {
        try {
          Reflect.apply(fn, {}, ['i']);
          return null;
        } catch (error) {
          return [error.name, error.message];
        }
      };
      errors.push(JSON.stringify(read(method)) === JSON.stringify(read(original)));
    }
    let conversions = 0;
    const sentinel = new Error('conversion-sentinel');
    const value = {
      toString() {
        conversions++;
        throw sentinel;
      },
    };
    let sameError = false;
    try {
      parent.innerHTML = value;
    } catch (error) {
      sameError = error === sentinel;
    }
    return {
      appended,
      inserted,
      replaced,
      appendedVoid,
      errors,
      conversions,
      sameError,
      name: Document.prototype.createElement.name,
      length: Document.prototype.createElement.length,
    };
  });
  assert.deepEqual(result, {
    appended: true,
    inserted: true,
    replaced: true,
    appendedVoid: true,
    errors: [true, true],
    conversions: 1,
    sameError: true,
    name: 'createElement',
    length: 1,
  });
});

test('nested custom-element constructors retain their own creation callsite instead of outer HTML insertion', async (t) => {
  const fx = await fixture(t);
  await fx.script(
    `customElements.define('invented-control',class extends HTMLElement {constructor(){super();this.append(document.createElement('button'));}});`,
    '/component.js',
  );
  await fx.script(
    `document.getElementById('target').innerHTML='<invented-control></invented-control>';window.component=document.querySelector('invented-control');window.nested=component.firstChild;`,
    '/outer.js',
  );
  await fx.resolve();
  for (const [name, url] of [
    ['component', '/outer.js'],
    ['nested', '/component.js'],
  ]) {
    const result = await fx.query(name),
      packet = fx.packets.find((item) => item.id === result.facts[0].subject);
    assert.equal(packet.frames[0].url, fx.origin + url, name);
    assert.equal(result.facts[0].predicate, 'created-by');
  }
});

test('custom stack formatting and unknown evaluation frames abstain without reading a custom formatter', async (t) => {
  const fx = await fixture(t);
  await fx.script(
    `window.originalPrepare=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace');window.stackHookCalls=0;Error.prepareStackTrace=()=>{window.stackHookCalls++;return 'PRIVATE_STACK_SENTINEL'};window.custom=document.createElement('i');document.body.append(custom);`,
  );
  await fx.settle();
  assert.equal(fx.packets.length, 0);
  assert.equal(await fx.page.evaluate(() => window.stackHookCalls), 0);
  assert.equal((await fx.query('custom')).availability[0].reason, 'custom-stack-format');
  await fx.page.evaluate(() => {
    if (window.originalPrepare) Object.defineProperty(Error, 'prepareStackTrace', window.originalPrepare);
    else delete Error.prepareStackTrace;
    window.unknown = document.createElement('b');
    document.body.append(window.unknown);
  });
  await fx.settle();
  assert.equal(fx.packets.length, 0, 'unknown execution never promotes an older caller or creates a backend/UI loop');
  assert.equal((await fx.query('unknown')).availability[0].reason, 'callsite-unavailable');
  assert.deepEqual((await fx.query('unknown')).facts, []);
});

test('private proof admission uses captured intrinsics and disposal preserves authored later overrides', async (t) => {
  const fx = await fixture(t);
  await fx.page.evaluate(() => {
    window.leakedSecret = null;
    const stringify = JSON.stringify;
    JSON.stringify = function (value, ...args) {
      if (value?.secret) window.leakedSecret = value.secret;
      return Reflect.apply(stringify, this, [value, ...args]);
    };
    window.structuredClone = () => ({ sourceRefs: [{ id: 'FORGED_SOURCE' }], facts: [{ id: 'FORGED_FACT' }] });
    window.Event = window.CustomEvent = function () {
      throw new Error('Authored event override');
    };
    EventTarget.prototype.dispatchEvent = function () {
      throw new Error('Authored dispatch override');
    };
    const get = WeakMap.prototype.get;
    WeakMap.prototype.get = function (key) {
      const value = Reflect.apply(get, this, [key]);
      if (value?.relationship)
        value.proof = { sourceRefs: [{ id: 'FORGED_WEAKMAP' }], facts: [{ id: 'FORGED_WEAKMAP' }] };
      return value;
    };
  });
  await fx.script(`window.created=document.createElement('button');document.body.append(created);`);
  await fx.resolve();
  const result = await fx.query('created');
  assert.equal(
    await fx.page.evaluate(() => window.leakedSecret),
    null,
    'page JSON hooks never see the private writer secret',
  );
  assert.equal(result.facts[0].proof, 'observed-dom-callsite');
  assert.doesNotMatch(JSON.stringify(result), /FORGED/);
  await fx.page.evaluate((slot) => {
    const result = window[slot].query(window.created);
    result.sourceRefs[0].id = 'FORGED_PUBLIC_QUERY';
  }, options.slot);
  assert.doesNotMatch(
    JSON.stringify(await fx.query('created')),
    /FORGED/,
    'public metadata copies never mutate private admitted proof',
  );
  await fx.page.evaluate(() => {
    const wrapped = Document.prototype.createElement;
    window.authoredCreate = function (...args) {
      return Reflect.apply(wrapped, this, args);
    };
    Document.prototype.createElement = window.authoredCreate;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    window.authoredSetter = function (value) {
      return Reflect.apply(descriptor.set, this, [value]);
    };
    Object.defineProperty(Element.prototype, 'innerHTML', { ...descriptor, set: window.authoredSetter });
  });
  await fx.writer.evaluate((writer) => writer.dispose());
  assert.deepEqual(
    await fx.page.evaluate(() => ({
      create: Document.prototype.createElement === window.authoredCreate,
      html: Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set === window.authoredSetter,
      append: Element.prototype.append === window.nativeDom.append,
      claim: window.__inventedDomReader.claim('invented-private-writer-secret'),
    })),
    { create: true, html: true, append: true, claim: null },
  );
  assert.deepEqual((await fx.query('created')).facts, []);
});

test('bounded changes never attribute untouched huge-parent siblings or continue hashing after pending limit', async (t) => {
  const fx = await fixture(t, {
    html: '<div id="huge">' + '<i></i>'.repeat(30000) + '</div>',
    limit: 3,
    counters: true,
  });
  await fx.script(
    `window.domReads=0;window.untouched=huge.children[huge.children.length-2000];huge.lastChild.replaceWith();window.readsForRemoval=domReads;`,
    '/remove.js',
  );
  await fx.settle();
  assert.equal(fx.packets.length, 0, 'a bounded before/after scan must not invent attachment of an untouched sibling');
  assert.deepEqual((await fx.query('untouched')).availability, []);
  assert.ok((await fx.page.evaluate(() => window.readsForRemoval)) < 10000, 'one operation never walks all30000nodes');
  await fx.script(
    `window.digestCalls=0;window.created=[];for(let i=0;i<1000;i++)created.push(document.createElement('b'));document.body.append(...created);window.overflow=created.at(-1);`,
    '/bounded.js',
  );
  await fx.settle();
  assert.ok(fx.packets.length <= 3);
  assert.ok(
    (await fx.page.evaluate(() => window.digestCalls)) <= 36,
    'only the three admitted records may request at most12frame hashes each',
  );
  const overflow = await fx.query('overflow');
  assert.equal(overflow.limits.truncated, true);
  assert.equal(overflow.availability[0].reason, 'dom-evidence-limit');
  await fx.page.evaluate(() => {
    window.domReads = 0;
    document.getElementById('huge').innerHTML = '<!--comment-->'.repeat(30000);
    window.commentReads = window.domReads;
  });
  assert.ok(
    (await fx.page.evaluate(() => window.commentReads)) < 10000,
    'non-element nodes consume the same traversal budget',
  );
});

test('batch resolution admits at most128records and sends one source-ready event with the reader slot', async (t) => {
  const fx = await fixture(t);
  await fx.script(
    `window.created=[];for(let i=0;i<4;i++){const node=document.createElement('i');created.push(node);document.body.append(node)};window.ready=[];document.addEventListener('paqvilo-provenance-ready',event=>ready.push(event.detail));`,
  );
  await fx.settle();
  assert.equal(fx.packets.length, 4);
  const entries = fx.packets.map((packet) => ({ id: packet.id, proof: proofFor(packet.id) }));
  assert.equal(await fx.writer.evaluate((writer, entries) => writer.resolveMany(entries), entries.slice(0, 3)), 3);
  assert.deepEqual(await fx.page.evaluate(() => window.ready), [{ slot: options.slot }]);
  assert.equal(await fx.writer.evaluate((writer, entry) => writer.resolve(entry.id, entry.proof), entries[3]), true);
  assert.deepEqual(await fx.page.evaluate(() => window.ready), [{ slot: options.slot }, { slot: options.slot }]);
  assert.equal(
    await fx.writer.evaluate((writer, entries) => writer.resolveMany(entries), Array(129).fill(entries[0])),
    0,
  );
  assert.equal(
    await fx.writer.evaluate((writer, entries) => writer.resolveMany(entries), entries),
    0,
    'resolved IDs cannot be rewritten',
  );
  assert.equal(await fx.page.evaluate(() => window.ready.length), 2);
  for (let index = 0; index < 4; index++)
    assert.equal(
      (
        await fx.page.evaluate(
          ({ slot, scope, index }) => window[slot].query(window.created[index], { scope, anchorGeneration: 7 }),
          { slot: options.slot, scope, index },
        )
      ).facts[0].proof,
      'observed-dom-callsite',
    );
});

test('anonymous UI redraws do not generate backend events or a provenance-ready feedback loop', async (t) => {
  const fx = await fixture(t);
  await fx.page.evaluate(() => {
    window.redraws = 0;
    document.addEventListener('paqvilo-provenance-ready', () => {
      window.redraws++;
      const container = document.createElement('div');
      container.innerHTML = '<span>PRIVATE_UI_TEXT</span>'.repeat(20);
      document.body.append(container);
    });
  });
  for (let round = 0; round < 3; round++) {
    const prior = fx.packets.length;
    await fx.script(
      `window.selected=document.createElement('b');document.body.append(selected);`,
      '/round-' + round + '.js',
    );
    await fx.settle();
    assert.equal(fx.packets.length, prior + 1);
    const packet = fx.packets.at(-1);
    assert.equal(
      await fx.writer.evaluate((writer, { id, proof }) => writer.resolveMany([{ id, proof }]), {
        id: packet.id,
        proof: round === 2 ? { sourceRefs: [], facts: [], reason: 'script-callsite-unmapped' } : proofFor(packet.id),
      }),
      1,
    );
    await fx.settle();
    assert.equal(fx.packets.length, prior + 1, 'ready-triggered anonymous UI work never emits another backend event');
    assert.equal(await fx.page.evaluate(() => window.redraws), round + 1);
  }
  assert.equal((await fx.query('selected')).availability[0].reason, 'script-callsite-unmapped');
  assert.doesNotMatch(JSON.stringify(fx.packets), /PRIVATE_UI_TEXT/);
});
