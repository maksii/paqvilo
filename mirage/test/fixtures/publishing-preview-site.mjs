// An invented site for the classic publishing preview toggle: one published home page and one draft page, and an Editor
// role whose website access permission holds Preview Unpublished Entities (a Reader role does not).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../../testing/owned-fixture.mjs';

export const PREVIEW_CONTACT = 'c3000000-0000-4000-8000-000000000030';

const record = (kind, id, fields = {}) =>
  [`- adx_${kind}id: ${id}`, `  adx_name: ${id}`, ...Object.entries(fields).map(([k, v]) => `  adx_${k}: ${v}`)].join(
    '\n',
  );

/** The simulator over the site, owned by `t`: { app, dir }. */
export async function publishingPreviewSite(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'publishing-preview-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented preview',
    'publishingstate.yml': [
      record('publishingstate', 'published', { isvisible: true }),
      record('publishingstate', 'draft', { isvisible: false }),
    ].join('\n'),
    'webrole.yml': [
      record('webrole', 'editors', { name: 'Editor' }),
      record('webrole', 'readers', { name: 'Reader' }),
    ].join('\n'),
    'websiteaccess.yml': `${record('websiteaccess', 'preview-right', { previewunpublishedentities: true })}\n  adx_websiteaccess_webrole:\n  - editors`,
    'webpage.yml': [
      record('webpage', 'home', { partialurl: '/', isroot: true, pagetemplateid: 'main' }),
      record('webpage', 'draft', {
        partialurl: 'draft',
        isroot: true,
        parentpageid: 'home',
        pagetemplateid: 'main',
        publishingstateid: 'draft',
      }),
    ].join('\n'),
    'pagetemplate.yml': record('pagetemplate', 'main', { webtemplateid: 'content' }),
    'Content.webtemplate.yml': 'adx_webtemplateid: content\nadx_name: Content',
    'Content.webtemplate.source.html': '<main>{{ page.name }}</main>',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
    tables: { contact: [{ contactid: PREVIEW_CONTACT, fullname: 'Invented Editor' }] },
    permissions: [],
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', identity: { roles: [] }, live: { origin: null }, endpoints: [] },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false });
  ownedFixture(t).add(() => app.close());
  return { app, dir };
}
