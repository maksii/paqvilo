// @test-kind contract: the portal renderer takes every current-time read (now, the date filter for 'now' and 'today', and time-only parsing) from the injected runtime clock, so a fixed store clock renders the same dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { changeType } from '../lib/liquid-dotnet.mjs';

const CLOCK_AT = Date.parse('2031-05-05T10:00:00Z');

/** A renderer on an empty portal whose page context takes its now from the given clock. */
function clockedRender(clock) {
  const portal = {
    templates: {},
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    records: [],
    weblinks: {},
    sitemarkers: {},
    website: {},
    pageTemplates: [],
  };
  const renderer = createPortalRenderer(portal, { clock });
  const page = { id: 'clock-page', url: '/', name: 'Clock', title: 'Clock' };
  const context = renderer.contextForPage(page, '/');
  return (source) => renderer.renderString(source, context);
}

test('now, the date filter for now and today, and time-only parsing render the runtime clock date', async () => {
  const render = clockedRender(fixedClock(CLOCK_AT));
  assert.equal(await render("{{ now | date: 'yyyy-MM-dd' }}"), '2031-05-05');
  assert.equal(await render("{{ 'now' | date: 'yyyy-MM-dd' }}"), '2031-05-05');
  assert.equal(await render("{{ 'today' | date: 'yyyy-MM-dd' }}"), '2031-05-05');
  assert.equal(await render("{{ '10:30' | date: 'yyyy-MM-dd' }}"), '2031-05-05');
  assert.equal(await render("{{ 'now' | date: 'HH:mm' }}"), '10:00');
});

test('the clock moves with the runtime clock between renders', async () => {
  const clock = fixedClock(CLOCK_AT);
  const render = clockedRender(clock);
  assert.equal(await render("{{ 'today' | date: 'yyyy-MM-dd' }}"), '2031-05-05');
  clock.advance(3 * 24 * 60 * 60 * 1000);
  assert.equal(await render("{{ 'today' | date: 'yyyy-MM-dd' }}"), '2031-05-08');
});

test('Convert.ChangeType on a time-only string takes the day from the injected runtime clock', () => {
  const converted = changeType('10:30', 'date', { clock: fixedClock(CLOCK_AT) });
  assert.equal(converted.toISOString(), '2031-05-05T10:30:00.000Z');
});

test('rendered comparisons convert a time-only string on the runtime clock day', async () => {
  const render = clockedRender(fixedClock(CLOCK_AT));
  // now is 2031-05-05 10:00. 14:30 on the clock's day is later, while 14:30 on today's wall-clock day is in an earlier year.
  assert.equal(await render("{% assign t = '14:30' %}{% if now < t %}before{% else %}not before{% endif %}"), 'before');
  assert.equal(
    await render("{% assign t = '14:30' %}{% if now > t %}after{% else %}not after{% endif %}"),
    'not after',
  );
  assert.equal(await render("{% assign t = '10:00' %}{% if now == t %}same{% else %}other{% endif %}"), 'same');
  assert.equal(
    await render("{% assign t = '10:00' %}{% case now %}{% when t %}match{% else %}miss{% endcase %}"),
    'match',
  );
});
