// @test-kind compatibility+contract: shortcut target priority (external URL, web page, survey, web file, event, forum) is https://learn.microsoft.com/power-pages/configure/place-child-nodes#manage-shortcuts and the enhanced columns (mspp_externalurl, mspp_webpageid, mspp_webfileid) are https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/mspp_shortcut#writable-columns-attributes; the diagnostic code is Mirage's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importPortal } from '../lib/importer.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function standardExport(t, shortcuts) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'shortcut-targets-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented shortcuts',
    'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /',
    'web-pages/docs/Docs.webpage.yml':
      'adx_webpageid: docs\nadx_name: Docs\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: docs',
    'web-files/guide.pdf.webfile.yml':
      'adx_webfileid: guide\nadx_name: guide.pdf\nadx_partialurl: guide.pdf\nadx_parentpageid: home',
    'web-files/guide.pdf': 'invented',
    'shortcut.yml': shortcuts,
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return importPortal(dir);
}

const entry = (id, fields) =>
  [
    `- adx_shortcutid: ${id}`,
    `  adx_name: ${id}`,
    '  adx_parentpage_webpageid: home',
    ...fields.map((f) => `  ${f}`),
  ].join('\n');

test('a standard shortcut to a survey, event or forum reports SHORTCUT_TARGET_UNSUPPORTED and has no URL', async (t) => {
  const portal = await standardExport(
    t,
    [
      entry('to-survey', ['adx_surveyid: aaaaaaaa-0000-4000-8000-000000000001']),
      // The survey outranks the web file, so the shortcut is not rendered as a link to the file.
      entry('survey-over-file', ['adx_surveyid: aaaaaaaa-0000-4000-8000-000000000002', 'adx_webfileid: guide']),
      entry('to-event', ['adx_eventid: aaaaaaaa-0000-4000-8000-000000000003']),
      entry('to-forum', ['adx_forumid: aaaaaaaa-0000-4000-8000-000000000004']),
    ].join('\n'),
  );
  const unsupported = portal.diagnostics.filter((item) => item.code === 'SHORTCUT_TARGET_UNSUPPORTED');
  assert.deepEqual(
    unsupported.map(({ shortcutId, targetId, targetKind }) => ({ shortcutId, targetId, targetKind })),
    [
      { shortcutId: 'to-survey', targetId: 'aaaaaaaa-0000-4000-8000-000000000001', targetKind: 'survey' },
      { shortcutId: 'survey-over-file', targetId: 'aaaaaaaa-0000-4000-8000-000000000002', targetKind: 'survey' },
      { shortcutId: 'to-event', targetId: 'aaaaaaaa-0000-4000-8000-000000000003', targetKind: 'event' },
      { shortcutId: 'to-forum', targetId: 'aaaaaaaa-0000-4000-8000-000000000004', targetKind: 'forum' },
    ],
  );
  for (const item of unsupported) assert.match(item.message, /mspp_shortcut/);
  assert.deepEqual(
    portal.shortcuts.map(({ id, url, targetPageId, targetFileId }) => ({ id, url, targetPageId, targetFileId })),
    ['to-survey', 'survey-over-file', 'to-event', 'to-forum'].map((id) => ({
      id,
      url: null,
      targetPageId: null,
      targetFileId: null,
    })),
  );
  assert.equal(
    portal.diagnostics.some((item) => item.code === 'SHORTCUT_TARGET_UNRESOLVED'),
    false,
  );
});

test('supported shortcut targets keep their priority and report nothing', async (t) => {
  const portal = await standardExport(
    t,
    [
      entry('external', [
        'adx_externalurl: https://example.test/',
        'adx_surveyid: aaaaaaaa-0000-4000-8000-000000000005',
      ]),
      entry('page', ['adx_webpageid: docs', 'adx_eventid: aaaaaaaa-0000-4000-8000-000000000006']),
      entry('file', ['adx_webfileid: guide', 'adx_forumid: aaaaaaaa-0000-4000-8000-000000000007']),
    ].join('\n'),
  );
  assert.equal(
    portal.diagnostics.some((item) => item.code === 'SHORTCUT_TARGET_UNSUPPORTED'),
    false,
  );
  assert.deepEqual(
    portal.shortcuts.map(({ id, url, targetPageId, targetFileId }) => ({ id, url, targetPageId, targetFileId })),
    [
      { id: 'external', url: 'https://example.test/', targetPageId: null, targetFileId: null },
      { id: 'page', url: '/docs/', targetPageId: 'docs', targetFileId: null },
      {
        id: 'file',
        url: portal.webFiles.find((file) => file.id === 'guide').url,
        targetPageId: null,
        targetFileId: 'guide',
      },
    ],
  );
});
