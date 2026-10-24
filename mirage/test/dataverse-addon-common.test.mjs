// Add-on message plumbing (lib/dataverse-addon-common.mjs): pack handlers, the default and fallback errors, the 204 rule and the
// GC stub for internal-only messages. The HTTP cases start two simulated APIs, one with a trusted pack and one without.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import {
  addonHandlerExtension,
  addonHandlers,
  aiUnavailable,
  argsOf,
  registerAddon,
  registerInternalMessage,
} from '../lib/dataverse-addon-common.mjs';

const APP_ID = '33333333-3333-3333-3333-333333333333';
const SECRET_VAR = 'PAQVILO_ADDON_COMMON_SECRET';
const ORIGIN_VERSION = 'v9.2';

// Operations: an echo action with a response, a void action, a predict-style action with no handler, and an
// internal-only action with no handler.
function testAddons() {
  return {
    name: 'test-addons',
    install(api) {
      registerAddon(api, {
        name: 'ContosoEcho',
        kind: 'action',
        binding: 'unbound',
        signature: { params: [['Text', 'Edm.String']], response: [['Echo', 'Edm.String']] },
        handle: (c) => ({ Echo: argsOf(c).Text }),
        fallback: () => new Error('unreachable: the echo has a handler'),
      });
      registerAddon(api, {
        name: 'ContosoVoid',
        kind: 'action',
        binding: 'unbound',
        signature: { params: [] },
        fallback: () => new Error('no default'),
      });
      registerAddon(api, {
        name: 'ContosoPredict',
        kind: 'action',
        binding: 'unbound',
        signature: { params: [['Text', 'Edm.String']], returns: 'Edm.String' },
        fallback: aiUnavailable,
      });
      registerInternalMessage(api, {
        name: 'ContosoInternal',
        kind: 'action',
        binding: 'unbound',
        signature: { params: [] },
      });
    },
  };
}

describe('addon handler registration', () => {
  it('ambiguous registration across packs fails', () => {
    const fn = async () => undefined;
    assert.throws(
      () =>
        addonHandlers([
          { id: 'a', dataverseMessages: { ContosoX: fn } },
          { id: 'b', dataverseMessages: { ContosoX: fn } },
        ]),
      /Ambiguous dataverseMessages registration for ContosoX/,
    );
  });

  it('a dataverseMessages entry must be a function', () => {
    assert.throws(
      () => addonHandlers([{ id: 'a', dataverseMessages: { ContosoX: 'text' } }]),
      /Data pack a: dataverseMessages must map message names to functions/,
    );
    assert.throws(
      () => addonHandlers([{ id: 'a', dataverseMessages: [] }]),
      /dataverseMessages must map message names to functions/,
    );
  });

  it('unknown message in dataverseMessages fails at start', () => {
    const api = { registry: createOperationRegistry() };
    const extension = addonHandlerExtension(
      addonHandlers([{ id: 'contoso-pack', dataverseMessages: { ContosoMissing: async () => undefined } }]),
    );
    assert.throws(
      () => extension.install(api),
      /Data pack contoso-pack: dataverseMessages names unknown message ContosoMissing/,
    );
  });

  it('registerInternalMessage answers 501 0x80040216 by default; a pack handler replaces it', async () => {
    const registry = createOperationRegistry();
    const api = { registry };
    registerInternalMessage(api, {
      name: 'ContosoInternal',
      kind: 'action',
      binding: 'unbound',
      signature: { params: [], returns: 'Edm.String' },
    });
    const op = registry.find({ name: 'ContosoInternal', kind: 'action', binding: 'unbound' });
    assert.match(op.csdl, /<Action Name="ContosoInternal">/);
    const context = { origin: 'http://127.0.0.1:1', version: ORIGIN_VERSION, params: {}, body: undefined };
    await assert.rejects(op.handle(context), (error) => {
      assert.equal(error.status, 501);
      assert.equal(error.details.innerCode, '0x80040216');
      assert.equal(error.message, 'ContosoInternal is for internal use only and is not simulated.');
      return true;
    });
    api.addonHandlers = addonHandlers([
      { id: 'contoso-pack', dataverseMessages: { ContosoInternal: async () => ({ Done: true }) } },
    ]);
    const replaced = await op.handle(context);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.Done, true);
    assert.equal(
      replaced.body['@odata.context'],
      'http://127.0.0.1:1/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.ContosoInternalResponse',
    );
  });
});

describe('addon messages over HTTP', () => {
  let withPack;
  let withoutPack;

  // A started API with the test operations and the given packs; its own client secret, so it can call the messages.
  async function start(packs) {
    process.env[SECRET_VAR] = 'addon-common-secret';
    const store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Addon app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
      ],
    });
    const api = await startDataverseApi({
      store,
      settings,
      log: () => {},
      extensions: [...EXTENSIONS, testAddons(), addonHandlerExtension(addonHandlers(packs))],
    });
    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: process.env[SECRET_VAR],
        scope: `${api.origin}/.default`,
      }),
    });
    const token = (await response.json()).access_token;
    const call = async (name, body) => {
      const result = await fetch(`${api.origin}/api/data/${ORIGIN_VERSION}/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const text = await result.text();
      return { status: result.status, body: text ? JSON.parse(text) : null };
    };
    const metadata = async () =>
      (
        await fetch(`${api.origin}/api/data/${ORIGIN_VERSION}/$metadata`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).text();
    return { api, call, metadata };
  }

  before(async () => {
    withPack = await start([
      {
        id: 'contoso-pack',
        dataverseMessages: {
          ContosoEcho: async (ctx) => ({ Echo: `pack:${ctx.args.Text}` }),
          ContosoVoid: async () => undefined,
          ContosoInternal: async () => ({ Done: true }),
        },
      },
    ]);
    withoutPack = await start([]);
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await withPack?.api.close();
    await withoutPack?.api.close();
  });

  it('pack handler wins over the default', async () => {
    const packed = await withPack.call('ContosoEcho', { Text: 'hi' });
    assert.equal(packed.status, 200);
    assert.equal(packed.body.Echo, 'pack:hi');
    const defaulted = await withoutPack.call('ContosoEcho', { Text: 'hi' });
    assert.equal(defaulted.status, 200);
    assert.equal(defaulted.body.Echo, 'hi');
    assert.match(defaulted.body['@odata.context'], /#Microsoft\.Dynamics\.CRM\.ContosoEchoResponse$/);
  });

  it('undefined result returns 204', async () => {
    const result = await withPack.call('ContosoVoid', {});
    assert.equal(result.status, 204);
    assert.equal(result.body, null);
  });

  it('fallback error body carries innerCode', async () => {
    const result = await withoutPack.call('ContosoPredict', { Text: 'x' });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, '0x80048d06');
    assert.match(result.body.error.message, /"code":"EntitlementNotAvailable"/);
  });

  it('an internal-only message answers 501 by default and is replaced by a pack', async () => {
    const defaulted = await withoutPack.call('ContosoInternal', {});
    assert.equal(defaulted.status, 501);
    assert.equal(defaulted.body.error.code, '0x80040216');
    assert.equal(defaulted.body.error.message, 'ContosoInternal is for internal use only and is not simulated.');
    const packed = await withPack.call('ContosoInternal', {});
    assert.equal(packed.status, 200);
    assert.equal(packed.body.Done, true);
  });

  it('every test operation is declared in $metadata', async () => {
    const metadata = await withoutPack.metadata();
    for (const name of ['ContosoEcho', 'ContosoVoid', 'ContosoPredict', 'ContosoInternal'])
      assert.match(metadata, new RegExp(`Name="${name}"`), name);
  });
});
