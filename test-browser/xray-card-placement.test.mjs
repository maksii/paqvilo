// @test-kind contract: the X-ray details card opens beside the picked element without covering it; Paqvilo's own designed layout on an invented loopback page.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';

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
