// @test-kind contract: the polls and ads objects read their time-only dates and publishing windows from the renderer's runtime clock, as the page and date filters do, so a fixed clock decides what a render shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';

// 2031 is far from the real date: a wall-clock read would put a time-only date in the real year.
const CLOCK_AT = Date.parse('2031-05-05T10:00:00Z');
const PAGE = { id: 'p1', url: '/', name: 'Home', title: 'Home', metadata: {} };
const WEBSITE = '9a4d1c2e-0000-4000-8000-0000000000aa';

/** A renderer whose records are one poll and one ad, each closing at 10:30 (a time-only date). */
function communityRender() {
  const portal = {
    pages: [PAGE],
    templates: {},
    pageTemplates: [],
    settings: {},
    snippets: {},
    webFiles: [],
    website: { id: WEBSITE },
    records: [
      {
        kind: 'poll',
        id: '9a4d1c2e-0000-4000-8000-0000000000b1',
        name: 'Timed poll',
        statecode: 0,
        expirationdate: '10:30',
      },
      {
        kind: 'ad',
        id: '9a4d1c2e-0000-4000-8000-0000000000a1',
        name: 'Timed ad',
        statecode: 0,
        expirationdate: '10:30',
      },
    ],
  };
  const renderer = createPortalRenderer(portal, { clock: fixedClock(CLOCK_AT) });
  return (source) => renderer.renderString(source, renderer.contextForPage(PAGE, '/'));
}

test('a time-only poll expiration is the fixed clock day at that time, so the poll is still open', async () => {
  const render = communityRender();
  assert.equal(await render("[{{ polls['Timed poll'].name }}]"), '[Timed poll]');
});

test('a time-only ad expiration is the fixed clock day at that time, so the ad is still shown', async () => {
  const render = communityRender();
  assert.equal(await render("[{{ ads['Timed ad'].name }}]"), '[Timed ad]');
});
