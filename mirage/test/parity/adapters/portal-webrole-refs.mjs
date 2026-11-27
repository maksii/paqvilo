// Adapter for the portal-webrole-refs surface: one recorded portal Web API request on the web role membership navigations
// of an enhanced data model site (hosted session F1, AUTH-03c; capture-portal-webrole-refs.mjs) -> the same request to
// Mirage's /_api/ as a signed-in contact -> its status and the error's code and message.
//
// The fixture is an invented enhanced data model export holding what the recorded site held for these requests:
// - the signed-in contact belongs to one web role; a Self-scope permission on contact grants that role Read, Append and
//   Append To and no Write (the recorded site's only active contact permission for the contact's roles);
// - Webapi/contact is enabled with columns that name no navigation;
// - the referenced web role is another web role the contact does not hold;
// - configuration `webrole-api` adds what the recorder's refs phase enabled before the run (its actions log and
//   refs-phase.mjs): Webapi/mspp_webrole (mspp_webroleid,mspp_name) and Webapi/powerpagecomponent
//   (powerpagecomponentid,name), and Global Read, Append and Append To on mspp_webrole and powerpagecomponent for the
//   contact's role.
// Placeholders: `{contact}` the signed-in contact, `{role}` the referenced web role, `{origin}` the simulator origin.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../../server.mjs';
import { makeTemporaryDirectory, removeFixtureDirectory } from '../../../testing/owned-fixture.mjs';

const CONTACT = '71000000-0000-4000-8000-000000000001';
const RUNNER = '71000000-0000-4000-8000-000000000002';
const ROLE = '71000000-0000-4000-8000-000000000003';
const G = (n) => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const xmlText = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const component = (id, type, name, content) =>
  `<powerpagecomponent powerpagecomponentid="${id}"><name>${xmlText(name)}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><content>${xmlText(JSON.stringify(content))}</content><statecode>0</statecode></powerpagecomponent>`;
const permission = (id, table, scope, rights) =>
  component(id, 18, `Invented ${table} ${scope}`, {
    entitylogicalname: table,
    entityname: `Invented ${table} ${scope}`,
    scope,
    read: rights.includes('read'),
    write: false,
    create: false,
    delete: false,
    append: rights.includes('append'),
    appendto: rights.includes('appendto'),
    adx_entitypermission_webrole: [RUNNER],
  });

function files(configuration) {
  const settings = [
    ['Webapi/contact/enabled', 'true'],
    ['Webapi/contact/fields', 'contactid,firstname,fullname,lastname'],
    ...(configuration === 'webrole-api'
      ? [
          ['Webapi/mspp_webrole/enabled', 'true'],
          ['Webapi/mspp_webrole/fields', 'mspp_webroleid,mspp_name'],
          ['Webapi/powerpagecomponent/enabled', 'true'],
          ['Webapi/powerpagecomponent/fields', 'powerpagecomponentid,name'],
        ]
      : []),
  ];
  const rights = ['read', 'append', 'appendto'];
  return {
    'powerpagecomponents/runner/powerpagecomponent.xml': component(RUNNER, 11, 'Invented runner', {
      adx_name: 'Invented runner',
    }),
    'powerpagecomponents/target/powerpagecomponent.xml': component(ROLE, 11, 'Invented target role', {
      adx_name: 'Invented target role',
    }),
    // Self scope (756150004).
    'powerpagecomponents/contact-self/powerpagecomponent.xml': permission(G(10), 'contact', 756150004, rights),
    ...(configuration === 'webrole-api'
      ? {
          'powerpagecomponents/webroles/powerpagecomponent.xml': permission(G(11), 'mspp_webrole', 756150000, rights),
          'powerpagecomponents/components/powerpagecomponent.xml': permission(
            G(12),
            'powerpagecomponent',
            756150000,
            rights,
          ),
        }
      : {}),
    ...Object.fromEntries(
      settings.map(([name, value], index) => [
        `powerpagecomponents/setting-${index}/powerpagecomponent.xml`,
        component(G(100 + index), 9, name, { value, source: 0 }),
      ]),
    ),
  };
}

async function site(configuration) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-replay-webrole-refs-'));
  let app;
  try {
    for (const [file, content] of Object.entries(files(configuration))) {
      await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await fs.writeFile(path.join(directory, file), content);
    }
    app = await createSimulator({
      sourceDir: directory,
      dataModel: 'enhanced',
      watch: false,
      port: 0,
      initial: {
        mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
        tables: { contact: [{ contactid: CONTACT, fullname: 'Invented contact', statecode: 0 }] },
        settings: { permissionMode: 'enforce' },
        simulator: {
          mode: 'local',
          pageMode: 'local',
          permissionSource: 'exported',
          contactRoles: [{ contactId: CONTACT, roleId: RUNNER }],
          live: {},
          endpoints: [],
        },
      },
    });
  } catch (error) {
    await app?.close();
    await removeFixtureDirectory(directory);
    throw error;
  }
  return { app, directory, session: app.signIn(CONTACT) };
}

export async function open() {
  const sites = new Map();
  return {
    async run({ configuration, method, path: address, body }) {
      if (!sites.has(configuration)) sites.set(configuration, await site(configuration));
      const { app, session } = sites.get(configuration);
      const fill = (value) =>
        value.replaceAll('{contact}', CONTACT).replaceAll('{role}', ROLE).replaceAll('{origin}', app.url);
      const payload = body
        ? JSON.stringify(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, fill(v)])))
        : null;
      const response = await fetch(app.url + fill(address), {
        method,
        headers: {
          accept: 'application/json',
          cookie: session.cookieHeader,
          ...(method === 'GET' ? {} : { __RequestVerificationToken: app.portalToken }),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { body: payload } : {}),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
      const error = data?.error;
      return {
        status: response.status,
        error: error ? { code: error.code ?? null, message: error.message ?? null } : null,
      };
    },
    async close() {
      for (const { app, directory } of sites.values()) {
        await app.close();
        await removeFixtureDirectory(directory);
      }
    },
  };
}
