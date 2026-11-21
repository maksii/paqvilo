// @test-kind contract: the X-ray details card opens beside the picked element without covering it; Paqvilo's own designed layout on an invented loopback page.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { lenseUiKit } from '../lense/ui-kit.mjs';

// X-ray paints in animation frames; after two more frames every paint scheduled before the call has run.
const painted = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const PAGE =
  '<!doctype html><style>body{margin:0;height:3000px;font:14px sans-serif}div{position:absolute;box-sizing:border-box;border:1px solid #888;padding:4px}</style>' +
  '<div id="left" style="left:40px;top:300px;width:200px;height:40px">Left field</div>' +
  '<div id="right" style="right:30px;top:420px;width:200px;height:40px">Right field</div>' +
  '<div id="wide" style="left:10px;right:10px;top:200px;height:40px">Full-width field</div>' +
  '<div id="low" style="left:10px;right:10px;top:720px;height:40px">Full-width field near the bottom</div>' +
  '<div id="x_title" data-id="x_title" style="left:300px;top:520px;width:300px;height:40px;display:flex"><button data-paq-model-logical-name>x_title</button><span>Title</span></div>';

async function fixture(t, viewport) {
  const context = await browser.newContext({ viewport });
  ownedFixture(t).add(() => context.close());
  await context.route('http://127.0.0.1:11951/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:11951/');
  const data = { origin: 'http://127.0.0.1:11951', token: 'invented-placement', sourceRevision: 'placement-1' };
  await page.evaluate(xrayUi, data);
  await page.evaluate((data) => {
    const api = document.getElementById('paqvilo-xray').__px;
    api.update(data, { componentIndex: { forms: [] }, columns: [], sourceRefs: [] });
    api.toggle(true);
  }, data);
  const boxes = () =>
    page.evaluate(() => {
      const root = document.getElementById('paqvilo-xray').shadowRoot;
      const box = (node) => {
        const r = node?.getBoundingClientRect();
        return r && { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      };
      const card = root.querySelector('.card');
      return { card: card.hidden ? null : box(card), selected: box(root.querySelector('.selected')) };
    });
  const pick = async (selector) => {
    // The card of an earlier pick can sit where the next element is: Esc releases that selection first.
    if ((await boxes()).card) await page.keyboard.press('Escape');
    const target = await page.locator(selector).boundingBox();
    await page.mouse.click(target.x + Math.min(10, target.width / 2), target.y + target.height / 2);
    const { card } = await boxes();
    assert.ok(card, `${selector}: the card opened`);
    return page.locator(selector).evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    });
  };
  return { page, pick, boxes };
}

const apart = (card, element) =>
  card.x >= element.right || card.right <= element.x || card.y >= element.bottom || card.bottom <= element.y;
const inside = (card, { width, height }) => card.x >= 0 && card.y >= 0 && card.right <= width && card.bottom <= height;

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 540, height: 900 },
])
  test(`the details card opens beside the picked element inside a ${viewport.width}x${viewport.height} viewport`, async (t) => {
    const { pick, boxes } = await fixture(t, viewport);
    for (const selector of ['#left', '#right', '#wide', '#low']) {
      const element = await pick(selector);
      const { card } = await boxes();
      assert.ok(apart(card, element), `${selector}: ${JSON.stringify({ card, element })}`);
      assert.ok(inside(card, viewport), `${selector}: ${JSON.stringify(card)}`);
      const gap = Math.min(
        ...[card.x - element.right, element.x - card.right, card.y - element.bottom, element.y - card.bottom].filter(
          (value) => value >= 0,
        ),
      );
      assert.ok(gap <= 24, `${selector}: the card is next to the element (${gap}px away)`);
    }
    if (viewport.width >= 1000) {
      const left = await pick('#left');
      assert.ok((await boxes()).card.x >= left.right, 'a narrow element at the left gets the card on its right');
      const right = await pick('#right');
      assert.ok((await boxes()).card.right <= right.x, 'an element at the right edge gets the card on its left');
    }
  });

test('the details card follows its element when the page scrolls', async (t) => {
  const { page, pick, boxes } = await fixture(t, { width: 1280, height: 800 });
  await pick('#wide');
  const before = (await boxes()).card;
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(
    (top) =>
      document.getElementById('paqvilo-xray').shadowRoot.querySelector('.card').getBoundingClientRect().y !== top,
    before.y,
  );
  const element = await page.locator('#wide').evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
  });
  const { card } = await boxes();
  assert.ok(apart(card, element), JSON.stringify({ card, element }));
  assert.ok(card.y < before.y, 'the card moved up with the element');
});

test('picking a logical-name label Lense added selects the field it labels', async (t) => {
  const { page, pick, boxes } = await fixture(t, { width: 1280, height: 800 });
  await pick('[data-paq-model-logical-name]');
  const field = await page.locator('#x_title').boundingBox();
  const { selected, card } = await boxes();
  assert.ok(selected, 'a selection mark is drawn');
  assert.ok(
    Math.abs(selected.x - field.x) <= 2 && Math.abs(selected.right - (field.x + field.width)) <= 2,
    JSON.stringify({ selected, field }),
  );
  assert.ok(apart(card, { x: field.x, y: field.y, right: field.x + field.width, bottom: field.y + field.height }));
});

const rectOf = (locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width };
  });

test('the hover summary sits beside the hovered element, left of it first, and never on the rows above or below', async (t) => {
  const { page } = await fixture(t, { width: 1280, height: 800 });
  const tip = page.locator('#paqvilo-xray .tip');
  const hover = async (selector) => {
    const target = await page.locator(selector).boundingBox();
    await page.mouse.move(target.x + 10, target.y + target.height / 2, { steps: 3 });
    await tip.waitFor();
    return { element: await rectOf(page.locator(selector)), tip: await rectOf(tip) };
  };
  // Room on the left: the summary sits there, level with the element.
  const right = await hover('#right');
  assert.ok(right.tip.right <= right.element.x, JSON.stringify(right));
  assert.ok(right.tip.y >= right.element.y - 1 && right.tip.y < right.element.bottom, JSON.stringify(right));
  // No room on the left: on the right.
  const left = await hover('#left');
  assert.ok(left.tip.x >= left.element.right, JSON.stringify(left));
  // A full-width element: below it, else above it near the bottom edge.
  const wide = await hover('#wide');
  assert.ok(wide.tip.y >= wide.element.bottom, JSON.stringify(wide));
  const low = await hover('#low');
  assert.ok(low.tip.bottom <= low.element.y, JSON.stringify(low));
  // An element no source matches says so, and how to go on.
  assert.equal(
    (await tip.innerText()).replace(/\s+/g, ' ').trim(),
    'Not matched to any source Click to see parent elements.',
  );
});

test('a pick hides the hover summary under the open card and opens the parent elements of an unmatched element', async (t) => {
  const { page, pick } = await fixture(t, { width: 1280, height: 800 });
  await pick('#left');
  const xray = page.locator('#paqvilo-xray');
  assert.equal(await xray.locator('.tip').isHidden(), true, 'the card describes the element under the pointer');
  assert.equal(await xray.locator('.card .eyebrow').innerText(), 'Not matched to any source');
  assert.equal(await xray.locator('.card .title').innerText(), 'div element');
  assert.equal(await xray.locator('.card details.ancestry').evaluate((node) => node.open), true);
  // With details off, the summary is the only description and comes back.
  await xray.locator('[data-action=details]').click();
  assert.equal(await xray.locator('[data-action=details]').getAttribute('aria-pressed'), 'false');
  await page.mouse.move(60, 320, { steps: 2 });
  await xray.locator('.tip').waitFor();
});

test('in a 700px window the details card keeps most of the page visible', async (t) => {
  const { pick, boxes } = await fixture(t, { width: 700, height: 900 });
  await pick('#left');
  const { card } = await boxes();
  // At most half the window, and wide enough (340px) that a row's name and its chips stay readable.
  const width = card.right - card.x;
  assert.ok(width >= 340 && width <= 350, JSON.stringify(card));
});

test('the legend steps aside for Lense UI under it and returns when that UI moves away', async (t) => {
  const { page } = await fixture(t, { width: 700, height: 900 });
  const legend = page.locator('#paqvilo-xray .legend');
  const covered = () => legend.evaluate((node) => node.classList.contains('covered'));
  await page.mouse.move(350, 400, { steps: 2 });
  await page.waitForFunction(() =>
    document.getElementById('paqvilo-xray').shadowRoot.querySelector('.tip:not([hidden])'),
  );
  assert.equal(await covered(), false);
  // A stand-in for the dev panel's pill at the bottom of a narrow window.
  await page.evaluate(() => {
    const pill = document.createElement('div');
    pill.id = 'paqvilo-panel';
    pill.style.cssText = 'position:fixed;left:12px;bottom:12px;width:640px;height:32px;background:#eee';
    document.body.append(pill);
  });
  await page.mouse.move(350, 300, { steps: 2 });
  await page.waitForFunction(() =>
    document.getElementById('paqvilo-xray').shadowRoot.querySelector('.legend').classList.contains('covered'),
  );
  assert.equal(await legend.evaluate((node) => getComputedStyle(node).visibility), 'hidden');
  await page.evaluate(() => document.getElementById('paqvilo-panel').remove());
  await page.mouse.move(350, 400, { steps: 2 });
  await page.waitForFunction(
    () => !document.getElementById('paqvilo-xray').shadowRoot.querySelector('.legend').classList.contains('covered'),
  );
});

// @test-kind contract: every X-ray toolbar and card control says what it does; Paqvilo's own designed UI
test('every X-ray control has a tooltip, and the Inspect tooltip follows the mode', async (t) => {
  const { page, pick } = await fixture(t, { width: 1280, height: 800 });
  await pick('#wide');
  const xray = page.locator('#paqvilo-xray');
  const untitled = await xray.evaluate((host) =>
    [...host.shadowRoot.querySelectorAll('.bar button, .bar select, .cardhead button, .foot button')]
      .filter((node) => !node.title)
      .map((node) => node.textContent),
  );
  assert.deepEqual(untitled, []);
  const mode = xray.locator('[data-action=mode]');
  assert.match(await mode.getAttribute('title'), /^Inspect mode: hover for a summary, click to select\./);
  await mode.click();
  assert.equal(await mode.getAttribute('aria-pressed'), 'false');
  assert.match(await mode.getAttribute('title'), /^Interact mode: the page works normally\./);
  // One label: the pressed state, not a second word, says which mode is on.
  assert.equal(await mode.textContent(), 'Inspect');
  // Reveal is a command button like Parent and Child, with the kit's locate icon ("find it on the page").
  const reveal = xray.locator('.foot [data-action=reveal]');
  assert.equal(await reveal.evaluate((node) => node.className), 'btn sec');
  assert.ok((await reveal.innerHTML()).includes(/d="([^"]+)"/.exec(lenseUiKit().ICON.locate)[1]));
});

test('content that grows after placement (an opened disclosure) scrolls inside the card, never past the window', async (t) => {
  const { page, pick, boxes } = await fixture(t, { width: 1280, height: 800 });
  await pick('#left');
  await page.evaluate(() => {
    const filler = document.createElement('div');
    filler.style.height = '2000px';
    document.getElementById('paqvilo-xray').shadowRoot.querySelector('.card .content').append(filler);
  });
  const { card } = await boxes();
  assert.ok(card.bottom <= 800, JSON.stringify(card));
});

// @test-kind contract: the hover summary never covers the open details card; Paqvilo's own designed layout
test('in a narrow window the hover summary never covers the open details card', async (t) => {
  for (const width of [700, 500]) {
    const { page, pick, boxes } = await fixture(t, { width, height: 900 });
    await pick('#wide');
    const { card } = await boxes();
    for (const selector of ['#left', '#right', '#low', '#x_title']) {
      const target = await page.locator(selector).boundingBox();
      await page.mouse.move(target.x + 5, target.y + target.height / 2, { steps: 2 });
      await painted(page);
      const tip = await page.evaluate(() => {
        const node = document.getElementById('paqvilo-xray').shadowRoot.querySelector('.tip');
        const r = node.getBoundingClientRect();
        return node.hidden ? null : { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      });
      if (tip)
        assert.ok(
          tip.x >= card.right || tip.right <= card.x || tip.y >= card.bottom || tip.bottom <= card.y,
          `${width}px ${selector}: ${JSON.stringify({ tip, card })}`,
        );
    }
  }
});

// @test-kind contract: X-ray outlines leave the Lense pill and panel uncovered; Paqvilo's own designed layout
test('outlines leave the Lense pill uncovered, and stop doing so when it is gone', async (t) => {
  const { page, pick } = await fixture(t, { width: 1280, height: 800 });
  await page.evaluate(() => {
    const pill = document.createElement('div');
    pill.id = 'paqvilo-panel';
    pill.style.cssText = 'position:fixed;left:40px;top:325px;width:150px;height:30px;background:#eee';
    document.body.append(pill);
  });
  // The selected field lies under the stand-in pill.
  await pick('#left');
  // The window, less the pill's box (the browser serializes the path with its own spacing).
  const clip = () =>
    page.evaluate(() =>
      document.getElementById('paqvilo-xray').shadowRoot.querySelector('.marks').style.clipPath.replaceAll(' ', ''),
    );
  assert.equal(await clip(), 'path(evenodd,"M00H1280V800H0ZM40325h150v30h-150Z")');
  await page.evaluate(() => document.getElementById('paqvilo-panel').remove());
  await page.mouse.move(700, 700, { steps: 2 });
  await painted(page);
  assert.equal(await clip(), '');
});
