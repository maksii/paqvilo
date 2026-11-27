// @test-kind unproven: local model of the legacy grid's SearchAction view action (Adxstudio ViewConfiguration.SetViewActions replaces the search box tooltip, button label and placeholder with the action's non-blank texts in the request language); no hosted capture of a configured SearchAction
import test from 'node:test';
import assert from 'node:assert/strict';
import { signInHeaders } from '../testing/session.mjs';
import { CASES, startCaseList } from './support/case-list-fixture.mjs';

const label = (value) => [{ LCID: 1033, Value: value }];

async function searchConfiguration(t, settings) {
  const app = await startCaseList(t, settings);
  const html = await (
    await fetch(app.url, { headers: signInHeaders(app, CASES.CONTACT, { roles: ['Agent'] }) })
  ).text();
  const encoded = /data-view-layouts="([^"]+)"/.exec(html)?.[1];
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))[0].Configuration.Search;
}

test('a SearchAction among the view actions gives the search box its texts', async (t) => {
  const search = await searchConfiguration(t, {
    ViewActions: [
      {
        Type: 'SearchAction',
        PlaceholderText: label('Find a case'),
        TooltipText: label('Search the case titles'),
        ButtonLabel: label('Go'),
      },
    ],
  });
  assert.deepEqual(
    [search.PlaceholderText, search.TooltipText, search.ButtonLabel],
    ['Find a case', 'Search the case titles', 'Go'],
  );
});

test('blank SearchAction texts and a list without one keep the default search texts', async (t) => {
  const defaults = await searchConfiguration(t, {});
  const blank = await searchConfiguration(t, {
    ViewActions: [{ Type: 'SearchAction', PlaceholderText: label(' '), TooltipText: [], ButtonLabel: null }],
  });
  assert.deepEqual(blank, defaults);
  assert.equal(defaults.PlaceholderText, 'Search');
  assert.match(defaults.ButtonLabel, /fa-search/);
});
