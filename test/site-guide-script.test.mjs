// @test-kind tooling: the project site's guide script (copy buttons, contents list, panel tour) run against a small document double.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../site/guide.js');

// A document double with the few DOM features the script uses: a tree, classes, attributes, events and the selector
// forms it queries (tag, .class, descendant, direct child, :target).
class Node {
  constructor(tag, { id = '', classes = [], text = '' } = {}) {
    Object.assign(this, { tag, id, text, children: [], parent: null, attributes: new Map(), listeners: new Map() });
    this.hidden = false;
    this.tabIndex = 0;
    this.open = true;
    this.hash = '';
    const names = new Set(classes);
    this.classList = {
      add: (name) => names.add(name),
      contains: (name) => names.has(name),
      toggle: (name, on) => (on ? names.add(name) : names.delete(name)),
    };
  }
  set className(value) {
    for (const name of value.split(' ')) this.classList.add(name);
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }
  get childNodes() {
    return this.children;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  prepend(node) {
    node.parent = this;
    this.children.unshift(node);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  cloneNode() {
    const copy = new Node(this.tag, { id: this.id, text: this.text });
    copy.append(...this.children.map((child) => child.cloneNode()));
    return copy;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async fire(type, event = {}) {
    const sent = { target: this, preventDefault() {}, ...event };
    for (const listener of this.listeners.get(type) ?? []) await listener(sent);
  }
  focus() {
    document.activeElement = this;
  }
  closest(tag) {
    for (let node = this; node; node = node.parent) if (node.tag === tag) return node;
    return null;
  }
  matches(simple) {
    if (simple === ':target') return this.id !== '' && `#${this.id}` === location.hash;
    return simple.startsWith('.') ? this.classList.contains(simple.slice(1)) : this.tag === simple;
  }
  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  querySelectorAll(selector) {
    const parts = selector.replace(' > ', '>').split(' ');
    return this.descendants().filter((node) => {
      let current = node;
      for (const part of parts.toReversed()) {
        const [parentPart, childPart] = part.includes('>') ? part.split('>') : [null, part];
        while (current && !current.matches(childPart)) current = current === node ? null : current.parent;
        if (!current) return false;
        if (parentPart && !current.parent?.matches(parentPart)) return false;
        current = parentPart ? current.parent.parent : current.parent;
        if (part === parts[0]) return true;
      }
      return false;
    });
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const element = (tag, options, ...children) => {
  const node = new Node(tag, options);
  node.append(...children);
  return node;
};

function page() {
  const command = element('div', { classes: ['cmd'] }, element('code', { text: 'npx paqvilo mirage demo' }));
  const link = element('a');
  link.hash = '#lense-panel';
  const contents = element('nav', { classes: ['toc'] }, element('details', {}, link));
  const view = (id, title) =>
    element(
      'section',
      { id, classes: ['tour-view'] },
      element('h4', { text: title }),
      element('a', { classes: ['spot'] }),
      element('a', { classes: ['spot'] }),
      element('p', { classes: ['tour-caption'] }),
      element(
        'ol',
        { classes: ['tour-legend'] },
        element('li', { id: `${id}-1` }, element('b', { text: `${title} first` })),
        element('li', { id: `${id}-2` }, element('b', { text: `${title} second` })),
      ),
    );
  const tour = element(
    'div',
    { classes: ['tour'] },
    view('lense-overrides', 'Overrides'),
    view('lense-issues', 'Issues'),
  );
  const body = element('body', {}, command, contents, element('article', { id: 'lense-panel' }, tour));
  return { body, command, contents, link, tour };
}

// Loads the script once against one page. A module runs once per process, so every test shares this page.
async function load({ hash = '', clipboard, narrow = false } = {}) {
  const parts = page();
  const media = { matches: narrow, addEventListener() {} };
  const observed = [];
  Object.assign(globalThis, {
    document: {
      body: parts.body,
      activeElement: null,
      createElement: (tag) => new Node(tag),
      querySelector: (selector) => parts.body.querySelector(selector),
      querySelectorAll: (selector) => parts.body.querySelectorAll(selector),
      getElementById: (id) => parts.body.descendants().find((node) => node.id === id) ?? null,
    },
    location: { hash },
    matchMedia: () => media,
    IntersectionObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(node) {
        observed.push(node);
        this.callback([
          { isIntersecting: true, target: node },
          { isIntersecting: false, target: node },
        ]);
      }
    },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
  await import(pathToFileURL(script).href);
  return { ...parts, observed };
}

// A narrow screen, an address that names an explanation in the second view, and a clipboard whose answer a test chooses.
const copied = [];
let refuseCopy = false;
const clipboard = {
  async writeText(text) {
    if (refuseCopy) throw new Error('denied');
    copied.push(text);
  },
};
const main = await load({ clipboard, narrow: true, hash: '#lense-issues-2' });

test('a command gets a copy button that copies its text and reports the result', async () => {
  const { command, body } = main;
  const button = command.querySelector('button');
  await button.fire('click');
  assert.deepEqual(copied, ['npx paqvilo mirage demo']);
  assert.equal(button.textContent, 'Copied');
  assert.equal(body.querySelector('.sr-only').textContent, 'Copied to clipboard');
});

test('a refused copy tells the reader to select the text', async () => {
  const { command, body } = main;
  const button = command.querySelector('button');
  refuseCopy = true;
  await button.fire('click');
  refuseCopy = false;
  assert.equal(button.textContent, 'Select the text');
  assert.equal(body.querySelector('.sr-only').textContent, 'Copy failed; select the text instead');
});

test('the contents list is closed on a narrow screen and marks the task in view', async () => {
  const { contents, link, observed } = main;
  const details = contents.querySelector('details');
  assert.equal(details.open, false);
  assert.equal(link.getAttribute('aria-current'), 'true');
  assert.deepEqual(
    observed.map((node) => node.id),
    ['lense-panel'],
  );
  details.open = true;
  await details.fire('click', { target: link });
  assert.equal(details.open, false);
});

test('the panel tour becomes tabs, opens the view the address names and shows one view at a time', async () => {
  const { tour } = main;
  const [tabs, overrides, issues] = tour.children;
  assert.equal(tabs.getAttribute('role'), 'tablist');
  assert.deepEqual(
    tabs.children.map((button) => [button.textContent, button.getAttribute('aria-selected')]),
    [
      ['Overrides', 'false'],
      ['Issues', 'true'],
    ],
  );
  assert.deepEqual([overrides.hidden, issues.hidden], [true, false]);
  assert.equal(tour.classList.contains('is-tabbed'), true);

  await tabs.children[0].fire('click');
  assert.deepEqual([overrides.hidden, issues.hidden], [false, true]);
  assert.deepEqual([tabs.children[0].tabIndex, tabs.children[1].tabIndex], [0, -1]);

  tabs.children[0].focus();
  await tabs.fire('keydown', { key: 'ArrowRight' });
  assert.deepEqual([overrides.hidden, issues.hidden], [true, false]);
  assert.equal(document.activeElement, tabs.children[1]);
  await tabs.fire('keydown', { key: 'ArrowRight' });
  assert.deepEqual([overrides.hidden, issues.hidden], [false, true]);
  await tabs.fire('keydown', { key: 'ArrowLeft' });
  assert.deepEqual([overrides.hidden, issues.hidden], [true, false]);
  await tabs.fire('keydown', { key: 'Enter' });
  assert.deepEqual([overrides.hidden, issues.hidden], [true, false]);
});

test('a chip or a list item selects its part, shows its explanation and stops the pulse', async () => {
  const { tour } = main;
  const view = tour.children[1];
  const spots = view.querySelectorAll('.spot');
  const items = view.querySelectorAll('.tour-legend > li');
  const caption = view.querySelector('.tour-caption');
  // The first part is selected from the start; that is not a use.
  assert.equal(caption.textContent, '1Overrides first');
  assert.equal(caption.getAttribute('aria-live'), 'polite');
  assert.equal(tour.classList.contains('is-used'), false);

  let prevented = false;
  await spots[1].fire('click', {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(caption.textContent, '2Overrides second');
  assert.deepEqual(
    [spots[0], spots[1], items[0], items[1]].map((node) => node.classList.contains('is-on')),
    [false, true, false, true],
  );
  assert.equal(tour.classList.contains('is-used'), true);
  // The explanation is a copy: the list keeps its own text.
  assert.equal(items[1].textContent, 'Overrides second');

  await items[0].fire('mouseenter');
  assert.equal(caption.textContent, '1Overrides first');
  await spots[1].fire('focus');
  assert.equal(caption.textContent, '2Overrides second');
  await spots[0].fire('mouseenter');
  await items[1].fire('click');
  assert.equal(spots[1].classList.contains('is-on'), true);
});
