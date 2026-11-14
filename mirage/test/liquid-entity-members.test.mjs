// @test-kind contract: an entity object answers its notes, permissions and related records by schema name from the entity member provider; attributes keep their exact names and the drop properties keep their case-insensitive lookup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { DataError } from '../lib/data-error.mjs';

const ACCOUNT = '9a4d1c2e-0000-4000-8000-0000000000ac';
const CONTACT_A = '9a4d1c2e-0000-4000-8000-0000000000c1';
const CONTACT_B = '9a4d1c2e-0000-4000-8000-0000000000c2';
const PAGE = { id: 'p1', url: '/', name: 'Home', title: 'Home', metadata: {} };
const SHOW = `{% assign a = entities.account['${ACCOUNT}'] %}`;
const PERMISSIONS = {
  can_read: true,
  can_write: false,
  can_create: false,
  can_delete: false,
  can_append: false,
  can_append_to: false,
  rules_exist: true,
};

function rendererWith(options = {}) {
  const portal = {
    pages: [PAGE],
    templates: {},
    pageTemplates: [],
    settings: {},
    snippets: {},
    webFiles: [],
  };
  const renderer = createPortalRenderer(portal, {
    entity: async (table, id) =>
      table === 'account' && id === ACCOUNT ? { accountid: ACCOUNT, name: 'Contoso' } : null,
    ...options,
  });
  return (source, extra = {}) => renderer.renderString(source, renderer.contextForPage(PAGE, '/', extra));
}

test('an entity object answers its notes, permissions and related rows from the entity member provider', async () => {
  const render = rendererWith({
    entityMembers: {
      notes: async (table, id) =>
        table === 'account' && id === ACCOUNT ? [{ subject: 'Intro', notetext: '*WEB* Welcome' }] : [],
      permissions: async () => PERMISSIONS,
      related: async (table, id, name) =>
        name === 'contact_customer_accounts'
          ? [
              { fullname: 'Ada', contactid: CONTACT_A },
              { fullname: 'Grace', contactid: CONTACT_B },
            ]
          : null,
    },
  });
  assert.equal(
    await render(
      `${SHOW}{{ a.name }}|{{ a.notes | size }}|{% if a.permissions.can_read %}read{% endif %}|{{ a.contact_customer_accounts | size }}|{{ a.contact_customer_accounts[0].fullname }}|{{ a.nothing }}|{{ a.id }}`,
    ),
    `Contoso|1|read|2|Ada||${ACCOUNT}`,
  );
});

test('an entity object without an entity member provider reports notes and permissions as nil', async () => {
  const renderer = createPortalRenderer(
    { pages: [PAGE], templates: {}, pageTemplates: [], settings: {}, snippets: {}, webFiles: [] },
    {
      entity: async (table, id) =>
        table === 'account' && id === ACCOUNT ? { accountid: ACCOUNT, name: 'Contoso' } : null,
    },
  );
  const context = renderer.contextForPage(PAGE, '/');
  assert.equal(await renderer.renderString(`${SHOW}{{ a.notes | size }}|{{ a.name }}`, context), '0|Contoso');
  assert.deepEqual(
    context.__diagnostics.map((diagnostic) => diagnostic.code),
    ['liquid-entity-member-unavailable'],
  );
});

// @test-kind security: a visitor's entity members come from the provider with that visitor's identity, and a read the provider refuses (403) is nil, never the rows.
test('an entity object gives a visitor only the members the provider grants that visitor', async () => {
  const forbidden = () => new DataError('Forbidden', 403, 'AccessDenied');
  const visitor = { id: CONTACT_A, contactId: CONTACT_A, authenticated: true, roles: [] };
  const identities = [];
  const render = rendererWith({
    entityMembers: {
      notes: async (table, id, identity) => {
        identities.push(identity);
        throw forbidden();
      },
      permissions: async (table, id, identity) => {
        identities.push(identity);
        return { ...PERMISSIONS, can_read: false };
      },
      related: async (table, id, name, identity) => {
        identities.push(identity);
        if (name === 'contact_customer_accounts') throw forbidden();
        return null;
      },
    },
  });
  const output = await render(
    `${SHOW}{{ a.notes | size }}|{% if a.permissions.can_read %}read{% endif %}|{{ a.contact_customer_accounts | size }}`,
    { user: visitor },
  );
  assert.equal(output, '0||0');
  assert.ok(identities.length >= 3);
  assert.ok(identities.every((identity) => identity === visitor));
});
