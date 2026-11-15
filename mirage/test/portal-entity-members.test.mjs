// @test-kind contract: a portal page's entity object answers notes, permissions and relationship rows from the visitor's own permitted reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatorFixture } from './fixtures/source-site.mjs';
import { signInHeaders } from '../testing.mjs';

const SITE = '5e5e5e5e-0000-4000-8000-0000000000e0';
const ACCOUNT = '5e5e5e5e-0000-4000-8000-0000000000a1';
const NOTE = '5e5e5e5e-0000-4000-8000-0000000000b1';
const MEMBER = '5e5e5e5e-0000-4000-8000-0000000000e1';
const text = { dataverseType: 'nvarchar' };
const PAGE = `{% assign a = entities.account['${ACCOUNT}'] %}<p id="facts">{{ a.name }}|{{ a.notes.size }}|{% if a.permissions.can_read %}read{% endif %}|{{ a.contact_customer_accounts.size }}|{% for c in a.contact_customer_accounts %}{{ c.fullname }};{% endfor %}</p>`;

const files = {
  'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented members`,
  'webrole.yml': `- adx_webroleid: ${MEMBER}\n  adx_name: Member`,
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': PAGE,
};

const initial = () => ({
  version: 1,
  mappings: {
    account: {
      entitySet: 'accounts',
      idColumn: 'accountid',
      nameColumn: 'name',
      fields: { name: text },
      relationships: {
        contact_customer_accounts: { entity: 'contact', from: 'accountid', to: 'parentcustomerid', many: true },
      },
    },
    contact: {
      entitySet: 'contacts',
      idColumn: 'contactid',
      nameColumn: 'fullname',
      fields: { fullname: text, parentcustomerid: { dataverseType: 'lookup', targets: ['account'] } },
      relationships: {
        parentcustomerid: { entity: 'account', from: 'parentcustomerid', to: 'accountid', many: false },
      },
    },
    annotation: {
      entitySet: 'annotations',
      idColumn: 'annotationid',
      nameColumn: 'subject',
      fields: { subject: text, notetext: text, objectid: { dataverseType: 'lookup', targets: ['account'] } },
    },
  },
  tables: {
    account: [{ accountid: ACCOUNT, name: 'Contoso', statecode: 0 }],
    contact: [
      { contactid: 'alex', fullname: 'Alex Local', parentcustomerid: ACCOUNT, statecode: 0 },
      { contactid: 'bo', fullname: 'Bo Denied', parentcustomerid: ACCOUNT, statecode: 0 },
    ],
    annotation: [
      {
        annotationid: NOTE,
        subject: 'Welcome',
        notetext: '*WEB* Welcome',
        objectid: { id: ACCOUNT, logical_name: 'account' },
        createdon: '2026-01-01T00:00:00Z',
      },
    ],
  },
  permissions: [
    { id: 'accounts', name: 'Accounts', entity: 'account', roles: [], operations: ['read'], scope: 'global' },
    {
      id: 'own-contact',
      name: 'Own contact',
      entity: 'contact',
      roles: ['Member'],
      operations: ['read'],
      scope: 'self',
    },
    { id: 'notes', name: 'Notes', entity: 'annotation', roles: ['Member'], operations: ['read'], scope: 'global' },
  ],
  simulator: {
    mode: 'local',
    pageMode: 'local',
    permissionSource: 'configured',
    live: { allowWrites: false },
    endpoints: [],
    contactRoles: [{ contactId: 'alex', roleId: MEMBER }],
  },
});

async function site(t) {
  const sim = await simulatorFixture(t, {
    prefix: 'portal-entity-members-',
    files,
    port: 0,
    watch: false,
    initial: initial(),
  });
  const page = async (headers = {}) =>
    (await (await fetch(sim.url + '/', { headers })).text()).match(/<p id="facts">.*?<\/p>/)[0];
  return { sim, page };
}

test('a granted visitor sees the notes, the permission and only the permitted related rows of an entity', async (t) => {
  const { sim, page } = await site(t);
  assert.equal(await page(signInHeaders(sim, 'alex')), '<p id="facts">Contoso|1|read|1|Alex Local;</p>');
});

// @test-kind security: a visitor without the contact or note permissions gets nil or zero for the denied members and never the denied rows.
test('an anonymous visitor gets zero notes and related rows, never the denied data', async (t) => {
  const { page } = await site(t);
  const html = await page();
  assert.equal(html, '<p id="facts">Contoso|0|read|0|</p>');
  assert.doesNotMatch(html, /Bo Denied|Welcome/);
});
