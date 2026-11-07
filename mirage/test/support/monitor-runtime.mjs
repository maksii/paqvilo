// A Power Pages runtime over an invented one-page portal with the x_item Web API enabled, for the Monitor backend suites
// (activity-backend.test.mjs, logs-history.test.mjs).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../api.mjs';
import { connectRuntime } from '../../testing/runtime.mjs';
import { makeTemporaryDirectory } from '../../testing/owned-fixture.mjs';

/** The portal export files: site `name`, the Main template `source`, Web API `fields` on x_item, plus `extra` files. */
export const monitorPortal = ({ name, source, fields = 'x_name', extra = {} }) => ({
  'website.yml': `adx_websiteid: site\nadx_name: ${name}`,
  'Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
  'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main',
  'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'Main.webtemplate.source.html': source,
  'sitesetting.yml': `- adx_sitesettingid: s1\n  adx_name: Webapi/x_item/enabled\n  adx_value: "true"\n- adx_sitesettingid: s2\n  adx_name: Webapi/x_item/fields\n  adx_value: ${fields}`,
  'webrole.yml': '- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
  ...extra,
});

/** The initial state: the x_item mapping, its `rows`, declarative `plugins`, permissive permissions, local mode. */
export const monitorState = ({ rows = [], plugins } = {}) => ({
  version: 1,
  mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } },
  tables: { x_item: rows },
  ...(plugins ? { plugins } : {}),
  permissions: [],
  settings: { permissionMode: 'permissive' },
  simulator: { mode: 'local', pageMode: 'local', live: { allowWrites: false }, endpoints: [] },
});

/**
 * Starts the runtime in a temporary folder (prefix) with the files and state, trace level summary and options merged;
 * closers (drained by the suite's after hook) closes it and then removes the folder. Resolves { sim, root, client }.
 */
export async function startMonitorRuntime(closers, { prefix, files, state, ...options }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  closers.push(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const sim = await createSimulator({
    sourceDir: root,
    stateFile: path.join(root, 'state.json'),
    port: 0,
    watch: false,
    initial: state,
    trace: { level: 'summary' },
    ...options,
  });
  closers.unshift(() => sim.close());
  return { sim, root, client: await connectRuntime({ origin: sim.url }) };
}
