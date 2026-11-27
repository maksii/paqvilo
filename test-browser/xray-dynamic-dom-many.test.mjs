// @test-kind contract: what X-ray answers for elements of pages whose scripts build or change thousands of elements, past the recorder's bounds, on an invented loopback portal page is Paqvilo's designed attribution rule
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dynamicPortal, settled, lineOf, LAYOUT } from './helpers/dynamic-dom-portal.mjs';
import { manyScript, manyTemplate } from './helpers/dynamic-dom-pages.mjs';

const MANY = 'web-files/many.js';

test('B: past every bound an element is still answered: inside its identified container, made by a script, never by a wrong one', async (t) => {
  const fx = await dynamicPortal(t, { template: manyTemplate(), webFiles: { 'many.js': manyScript } });
  await fx.page.goto(fx.origin + '/', { waitUntil: 'load' });
  // A virtualised list scrolled twenty times, each scroll a task of its own: rows made and removed.
  for (let i = 0; i < 20; i++) await fx.page.evaluate(() => window.scrollList(100));
  const got = await settled(fx, {
    h0: '#h0',
    h4999: '#h4999',
    l0: '#l0',
    l4999: '#l4999',
    t0: '#t0-0-0',
    t99: '#t99-9-18',
    lt99: '#lt99-9-18',
    s0: '#s0',
    s4999: '#s4999',
    vlast: '#v-list > li:last-child',
  });
  const line = (needle) => lineOf(manyScript, needle);
  const named = (answer) => [answer.source?.file, answer.source?.line, answer.source?.how];
  // One innerHTML of 5000 rows and of a 20,000-element tree: the first 2000 elements are recorded one by one, the rest
  // as that call's region; every one names the call.
  assert.deepEqual(named(got.h0), [MANY, line("time('innerHTML-rows'"), 'Created by this script']);
  assert.deepEqual(named(got.h4999), [MANY, line("time('innerHTML-rows'"), 'Created by this script']);
  assert.ok(got.h4999.limits.includes('dom-evidence-limit'), JSON.stringify(got.h4999));
  assert.ok(!got.h0.limits.includes('dom-evidence-limit'));
  assert.deepEqual(named(got.t0), [MANY, line("time('innerHTML-tree'"), 'Created by this script']);
  assert.deepEqual(named(got.t99), [MANY, line("time('innerHTML-tree'"), 'Created by this script']);
  // A loop of createElement in the same task: the first calls are recorded (one notification per line, shared),
  // the calls past the task's capture budget are not; their elements stand in their identified container.
  assert.deepEqual(named(got.l0), [MANY, line("time('loop-rows'"), 'Created by this script']);
  for (const [id, title] of [
    ['l4999', 'Inside Layout · tbody · tr'],
    ['lt99', 'Inside Layout · div · li'],
  ]) {
    assert.equal(got[id].source, null, id + ' ' + JSON.stringify(got[id]));
    assert.equal(got[id].title, title, id);
    assert.ok(got[id].limits.includes('dom-evidence-limit'), id);
  }
  // Server rows the script changed after the budget was spent: the template's rows, with what changed and the limit.
  // The named style write (`style.color = …`) has no hook: listed without a script.
  for (const id of ['s0', 's4999']) {
    assert.deepEqual(
      [got[id].title, got[id].source?.file],
      ['Layout · tr', LAYOUT],
      id + ' ' + JSON.stringify(got[id]),
    );
    assert.deepEqual(
      got[id].rows.filter((row) => row.relationship === 'changed-by').map((row) => [row.label, row.at]),
      [
        ['Changed without a recorded script call: style', null],
        ['Changed by a script past the recording limit (its call was not recorded): data-i, class', null],
      ],
      id,
    );
  }
  // The newest row of the virtualised list, made in a later task: named again.
  assert.deepEqual(named(got.vlast), [MANY, line('window.scrollList = '), 'Created by this script']);
  const coverage = await fx.panel.coverageFor(fx.page, { limit: 100000 });
  assert.equal(coverage.counts.none, 0, JSON.stringify(coverage.counts));
  assert.equal(coverage.counts.direct + coverage.counts.contained, coverage.total);
  assert.deepEqual(fx.errors, []);
});
