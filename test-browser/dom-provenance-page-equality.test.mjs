// @test-kind contract: a page behaves the same with the script recorder and the response registry installed as without them (style and dataset objects, wrapped natives' shape, MutationObserver), on invented pages at a routed loopback address
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { installDomProvenance } from '../lense/dom-provenance.mjs';
import { installPortalProvenanceRegistry } from '../lense/portal-element-provider.mjs';

const ORIGIN = 'http://invented.test';
// Both bootstraps, installed the way the transports install them: before any page script, the recorder first.
const bootstrap =
  'window.__inventedEmit=function(){};' +
  `(${installDomProvenance.toString()})(${JSON.stringify({ slot: '__inventedDom', secret: 'invented-secret-1', notifyKey: 'invented-notify', binding: '__inventedEmit', releaseKey: 'invented-release-1' })});\n` +
  `(${installPortalProvenanceRegistry.toString()})(${JSON.stringify({ secret: 'invented-secret-2', slot: '__inventedPortal', domProvenanceSlot: '__inventedDom', releaseKey: 'invented-release-2' })});\n` +
  '//# sourceURL=paqvilo-tool://invented-bootstrap';
const html =
  '<!doctype html><html><head><title>Invented</title></head><body>' +
  '<div id="s" class="a b" data-x="1" style="color: blue">server</div><div id="s2" data-foo-bar="2">two</div>' +
  '<svg id="g"><rect id="r" style="fill:red" data-k="v"></rect></svg><iframe id="fr" src="/frame"></iframe>' +
  '</body></html>';
const pages = { '/': html, '/frame': '<!doctype html><body><div id="f" style="color:green" data-f="1">f</div></body>' };

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

/** `probe` evaluated in the page without and with the bootstraps. */
async function both(probe) {
  const out = [];
  for (const lense of [false, true]) {
    const context = await browser.newContext();
    try {
      if (lense) await context.addInitScript({ content: bootstrap });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN || !Object.hasOwn(pages, url.pathname)) return route.abort();
        return route.fulfill({ status: 200, contentType: 'text/html', body: pages[url.pathname] });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(ORIGIN + '/', { waitUntil: 'load' });
      out.push({ value: await page.evaluate(probe), errors });
    } finally {
      await context.close();
    }
  }
  return out;
}

const PROBES = {
  // The declaration and the map are the browser's own objects: brand checks, methods applied to another
  // declaration, identity, constructor, valueOf and native exceptions.
  'style and dataset objects': () => {
    const s = document.getElementById('s');
    const other = document.createElement('p');
    other.style.color = 'navy';
    const out = {};
    const t = (key, run) => {
      try {
        out[key] = run();
      } catch (error) {
        out[key] = 'THROW ' + error.constructor.name + ': ' + error.message;
      }
    };
    const descriptor = (name) => Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, name);
    t('same', () => [
      s.style === s.style,
      s.dataset === s.dataset,
      document.getElementById('r').style === document.getElementById('r').style,
    ]);
    t(
      'setPropertyCall',
      () => (CSSStyleDeclaration.prototype.setProperty.call(s.style, 'color', 'red'), s.getAttribute('style')),
    );
    t('cssTextSet', () => (descriptor('cssText').set.call(s.style, 'color: green'), s.getAttribute('style')));
    t('cssTextGet', () => descriptor('cssText').get.call(s.style));
    t('lengthGet', () => descriptor('length').get.call(s.style));
    t('extractedOther', () => {
      const read = s.style.getPropertyValue;
      return read.call(other.style, 'color');
    });
    t('cachedSetProperty', () => {
      const write = s.style.setProperty;
      write.call(other.style, 'margin-top', '3px');
      return [s.style.marginTop, other.style.marginTop];
    });
    t('identity', () => [
      s.style.setProperty === CSSStyleDeclaration.prototype.setProperty,
      s.style.constructor === CSSStyleDeclaration,
      s.style.valueOf() === s.style,
      s.dataset.constructor === DOMStringMap,
      Object.getPrototypeOf(s.dataset) === DOMStringMap.prototype,
    ]);
    t('nativeError', () => descriptor('cssText').set.call({}, 'x'));
    t('styleSetter', () => ((s.style = 'color: red; left: 2px'), s.getAttribute('style')));
    t('dataset', () => {
      s.dataset.y = '2';
      delete s.dataset.x;
      Object.defineProperty(s.dataset, 'd', { value: 'v', configurable: true, enumerable: true, writable: true });
      return [s.getAttribute('data-y'), s.hasAttribute('data-x'), s.getAttribute('data-d'), JSON.stringify(s.dataset)];
    });
    t('defineGetter', () => Object.defineProperty(s.dataset, 'g', { get: () => 1 }) && 'defined');
    return out;
  },
  // Every wrapped member keeps the native's shape: name, length, no `prototype`, not a constructor, the same
  // descriptor flags. (Function.prototype.toString is not changed: a wrapper's source text is its own.)
  'shape of every wrapped native': () => {
    const constructs = (f) => {
      try {
        Reflect.construct(function () {}, [], f);
        return true;
      } catch {
        return false;
      }
    };
    const shape = (f) => (typeof f === 'function' ? [f.name, f.length, 'prototype' in f, constructs(f)] : null);
    const members = [
      [
        Element.prototype,
        [
          'setAttribute',
          'setAttributeNS',
          'removeAttribute',
          'removeAttributeNS',
          'toggleAttribute',
          'setAttributeNode',
          'setAttributeNodeNS',
          'removeAttributeNode',
          'append',
          'prepend',
          'before',
          'after',
          'replaceWith',
          'replaceChildren',
          'insertAdjacentHTML',
          'insertAdjacentElement',
          'insertAdjacentText',
          'remove',
          'setHTMLUnsafe',
          'innerHTML',
          'outerHTML',
          'id',
          'className',
          'classList',
          'slot',
        ],
      ],
      [
        Node.prototype,
        [
          'appendChild',
          'insertBefore',
          'replaceChild',
          'removeChild',
          'cloneNode',
          'normalize',
          'textContent',
          'nodeValue',
        ],
      ],
      [Document.prototype, ['createElement', 'createElementNS', 'importNode', 'write', 'writeln', 'execCommand']],
      [DocumentFragment.prototype, ['append', 'prepend', 'replaceChildren']],
      [ShadowRoot.prototype, ['innerHTML', 'setHTMLUnsafe']],
      [Range.prototype, ['insertNode', 'surroundContents']],
      [
        CharacterData.prototype,
        ['data', 'appendData', 'insertData', 'deleteData', 'replaceData', 'before', 'after', 'replaceWith', 'remove'],
      ],
      [Text.prototype, ['splitText']],
      [HTMLElement.prototype, ['style', 'innerText', 'outerText', 'hidden', 'title', 'lang', 'dir', 'tabIndex']],
      [SVGElement.prototype, ['style']],
      [HTMLInputElement.prototype, ['value', 'checked', 'type', 'name']],
      [HTMLAnchorElement.prototype, ['href', 'relList']],
      [Attr.prototype, ['value']],
      [DOMTokenList.prototype, ['add', 'remove', 'toggle', 'replace', 'value']],
      [CSSStyleDeclaration.prototype, ['setProperty', 'removeProperty', 'cssText', 'cssFloat']],
      [HTMLTemplateElement.prototype, ['content']],
      [MutationObserver.prototype, ['takeRecords', 'observe', 'disconnect']],
    ];
    const out = {};
    for (const [prototype, names] of members)
      for (const name of names) {
        const d = Object.getOwnPropertyDescriptor(prototype, name);
        out[prototype.constructor.name + '.' + name] = d
          ? [shape(d.value), shape(d.get), shape(d.set), d.writable, d.enumerable, d.configurable]
          : null;
      }
    return out;
  },
  // MutationObserver keeps its interface: prototype object and its descriptor, constructor link, instanceof,
  // subclassing, the native refusals, the callback's receiver and arguments, takeRecords.
  'MutationObserver interface': async () => {
    const MO = MutationObserver;
    const out = {};
    const t = (key, run) => {
      try {
        out[key] = run();
      } catch (error) {
        out[key] = 'THROW ' + error.constructor.name + ': ' + error.message;
      }
    };
    const flags = (d) => d && [typeof d.value, d.writable, d.enumerable, d.configurable];
    t('shape', () => [
      MO.name,
      MO.length,
      typeof MO,
      'prototype' in MO,
      Object.getPrototypeOf(MO) === Function.prototype,
    ]);
    t('descriptors', () => [
      flags(Object.getOwnPropertyDescriptor(MO, 'prototype')),
      flags(Object.getOwnPropertyDescriptor(window, 'MutationObserver')),
      flags(Object.getOwnPropertyDescriptor(MO.prototype, 'constructor')),
    ]);
    t('links', () => [MO.prototype.constructor === MO, window.WebKitMutationObserver === MO, Object.keys(MO)]);
    t('withoutNew', () => MO(() => {}));
    t('notCallable', () => new MO(1));
    t('subclass', () => {
      class Sub extends MO {
        constructor(callback) {
          super(callback);
          this.extra = 1;
        }
      }
      const sub = new Sub(() => {});
      return [sub instanceof Sub, sub instanceof MO, Object.getPrototypeOf(sub) === Sub.prototype, sub.extra];
    });
    t('instance', () => {
      const mo = new MO(() => {});
      return [mo instanceof MO, Object.getPrototypeOf(mo) === MO.prototype, Object.prototype.toString.call(mo)];
    });
    const node = document.createElement('div');
    document.body.append(node);
    const delivered = await new Promise((resolve) => {
      const mo = new MO(function (records, observer) {
        resolve([
          this === mo,
          observer === mo,
          Array.isArray(records),
          records.length,
          records[0].attributeName,
          records[0].oldValue,
        ]);
      });
      mo.observe(node, { attributes: true, attributeOldValue: true });
      node.setAttribute('data-a', '1');
      node.setAttribute('data-a', '2');
    });
    out.delivered = delivered;
    const taker = new MO(() => {});
    taker.observe(node, { attributes: true, childList: true });
    node.setAttribute('data-b', '1');
    node.append('text');
    const taken = taker.takeRecords();
    out.taken = [Array.isArray(taken), taken.map((record) => record.type), taker.takeRecords().length];
    return out;
  },
  // A frame's natives are its own; one realm's wrapped member applied to another realm's object works as natively.
  'behaviour across frame realms': async () => {
    const frame = document.getElementById('fr');
    await new Promise((resolve) =>
      frame.contentDocument?.readyState === 'complete' && frame.contentDocument.getElementById('f')
        ? resolve()
        : frame.addEventListener('load', resolve),
    );
    const w = frame.contentWindow,
      f = w.document.getElementById('f');
    const out = {};
    const t = (key, run) => {
      try {
        out[key] = run();
      } catch (error) {
        out[key] = 'THROW ' + error.constructor.name + ': ' + error.message;
      }
    };
    t('styleSame', () => f.style === f.style);
    t('frameInstance', () => f.style instanceof w.CSSStyleDeclaration);
    t('crossSetAttribute', () => (Element.prototype.setAttribute.call(f, 'data-c', '1'), f.getAttribute('data-c')));
    t(
      'crossSetProperty',
      () => (CSSStyleDeclaration.prototype.setProperty.call(f.style, 'color', 'red'), f.style.color),
    );
    t(
      'ownSetProperty',
      () => (w.CSSStyleDeclaration.prototype.setProperty.call(f.style, 'color', 'blue'), f.style.color),
    );
    t('crossGetter', () => Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style').get.call(f) === f.style);
    return out;
  },
};

for (const [name, probe] of Object.entries(PROBES))
  test('the page sees the same ' + name + ' with the recorder and the registry installed', async () => {
    const [without, withLense] = await both(probe);
    assert.deepEqual(withLense.errors, without.errors);
    assert.deepEqual(withLense.value, without.value);
  });
