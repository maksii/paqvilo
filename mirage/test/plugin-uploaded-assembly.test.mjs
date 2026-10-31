// @test-kind contract: user decision 2026-10-30 (C08 "Run by default"): a registered step on uploaded assembly bytes runs in the CLR host without a trust step; the load-failure message wording is a local model
// @parity-evidence: user decision 2026-10-30 in this session (C08: "Run by default")
// Registered plug-in assemblies uploaded through the registration Web API run like native: the step changes data, a package's
// dependent assembly resolves, updated content runs the new code, and a step whose assembly cannot load fails with 0x80040224
// and rolls its operation back. Invented schema, assemblies and identities only.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { overlayRegisteredSteps } from '../lib/dataverse-plugin-registration.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { releaseStaleUploadedRuntimes, resolveXrmSdk } from '../lib/plugin-uploaded.mjs';
import { zipOf } from '../lib/dataverse-solutions.mjs';
import { CLR_SKIP, clrSdk, compileClr, strongNameKey } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory, removeFixtureDirectory } from '../testing/owned-fixture.mjs';

const APP = '77777777-7777-7777-7777-7777777777c8';
const SECRET = 'PAQVILO_UPLOADED_PLUGIN_SECRET';

// A PreOperation Create plug-in that rewrites the name with `expression` (over the submitted `name`).
const stamp = (namespace, expression) => `using System; using Microsoft.Xrm.Sdk;
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
namespace ${namespace} {
  public sealed class NameStamp : IPlugin {
    public void Execute(IServiceProvider services) {
      var context = (IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));
      var target = (Entity)context.InputParameters["Target"];
      var name = target.GetAttributeValue<string>("contoso_name");
      target["contoso_name"] = ${expression};
    }
  }
}`;

describe('uploaded plug-in assemblies run by default', { skip: CLR_SKIP }, () => {
  const uploads = {};
  const diagnostics = [];
  const created = [];
  const bytes = {};
  let work, store, api, backend, origin, token, runtimes, items, createFilter, createMessage;

  const call = (url, { method = 'GET', body } = {}) =>
    fetch(`${origin}/api/data/v9.2/${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const idOf = (response) => /\(([^)]+)\)/.exec(response.headers.get('OData-EntityId'))[1];
  async function post(set, body) {
    const response = await call(set, { method: 'POST', body });
    assert.equal(response.status, 204, await response.clone().text());
    return idOf(response);
  }
  const typeOf = (assembly) =>
    store.tableRows('plugintype').find((row) => String(row.pluginassemblyid?.id ?? row.pluginassemblyid) === assembly);
  async function registerStep(type) {
    const id = await post('sdkmessageprocessingsteps', {
      name: 'Uploaded stamp',
      stage: 20,
      mode: 0,
      rank: 1,
      'sdkmessageid@odata.bind': `/sdkmessages(${createMessage})`,
      'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${createFilter})`,
      'plugintypeid@odata.bind': `/plugintypes(${type})`,
      'eventhandler_plugintype@odata.bind': `/plugintypes(${type})`,
    });
    created.push(id);
    return id;
  }
  async function createWidget(name) {
    const response = await call('contoso_widgets', { method: 'POST', body: { contoso_name: name } });
    return { response, id: response.status === 204 ? idOf(response) : null };
  }
  const nameOf = async (id) => (await (await call(`contoso_widgets(${id})?$select=contoso_name`)).json()).contoso_name;

  before(async () => {
    work = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-uploaded-'));
    uploads.cacheRoot = path.join(work, 'cache');
    uploads.sdkAssembly = clrSdk();
    const key = strongNameKey(path.join(work, 'contoso.snk'));
    const build = (name, source, options = {}) => {
      const file = path.join(work, `${name}.cs`);
      fs.mkdirSync(path.join(work, options.folder ?? ''), { recursive: true });
      fs.writeFileSync(file, source);
      const out = path.join(work, options.folder ?? '', `${options.assembly ?? name}.dll`);
      compileClr(file, out, {
        references: [uploads.sdkAssembly, ...(options.references ?? [])],
        keyFile: options.keyFile,
      });
      return fs.readFileSync(out);
    };
    bytes.v1 = build('Contoso.Uploaded', stamp('Contoso.Uploaded', 'name + "-v1"'), { keyFile: key });
    bytes.v2 = build('Contoso.Uploaded', stamp('Contoso.Uploaded', 'name + "-v2"'), { keyFile: key, folder: 'v2' });
    bytes.unloadable = build('Contoso.Unloadable', stamp('Contoso.Unloadable', 'name + "-never"'), { keyFile: key });
    const helper = path.join(work, 'Contoso.Packaged.Helpers.dll');
    bytes.helpers = build(
      'Contoso.Packaged.Helpers',
      'namespace Contoso.Packaged.Helpers { public static class Suffix { public const string Value = "-helper"; public static string Of(string name) { return name + Value; } } }',
    );
    bytes.packaged = build('Contoso.Packaged', stamp('Contoso.Packaged', 'Contoso.Packaged.Helpers.Suffix.Of(name)'), {
      references: [helper],
    });

    process.env[SECRET] = 'uploaded-secret';
    const state = emptyState();
    state.mappings.contoso_widget = {
      logicalName: 'contoso_widget',
      entitySet: 'contoso_widgets',
      idColumn: 'contoso_widgetid',
      nameColumn: 'contoso_name',
      userConfigured: true,
      fields: { contoso_name: { dataverseType: 'nvarchar' } },
      relationships: {},
    };
    state.tables.contoso_widget = [];
    store = await new DataStore({ state }).init();
    api = await startDataverseApi({
      store,
      settings: dataverseSettings({
        enabled: true,
        applications: [
          { appId: APP, displayName: 'Uploader', secretEnvironmentVariable: SECRET, roles: ['System Administrator'] },
        ],
      }),
      log: () => {},
      extensions: [...EXTENSIONS],
    });
    origin = api.origin;
    token = (
      await (
        await fetch(`${origin}/${api.tenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: APP,
            client_secret: process.env[SECRET],
            scope: `${origin}/.default`,
          }),
        })
      ).json()
    ).access_token;
    createMessage = store.tableRows('sdkmessage').find((row) => row.name === 'Create').sdkmessageid;
    createFilter = store
      .tableRows('sdkmessagefilter')
      .find(
        (row) => row.sdkmessageid === createMessage && row.primaryobjecttypecode === 'contoso_widget',
      ).sdkmessagefilterid;
    // The host's wiring (organization-host.mjs): the registered rows are the step list; no handler, descriptor or mode choice.
    runtimes = new Map();
    items = () => pluginCatalogue({ plugins: overlayRegisteredSteps({ steps: [] }, store), runtimes });
    backend = await createOrganizationBackend({
      store,
      items,
      runtimes,
      clrUploads: uploads,
      diagnostic: (entry) => diagnostics.push(entry),
    });
  });

  after(async () => {
    await backend?.close();
    await api?.close();
    delete process.env[SECRET];
    if (work) await removeFixtureDirectory(work);
  });

  afterEach(async () => {
    for (const id of created.splice(0)) await call(`sdkmessageprocessingsteps(${id})`, { method: 'DELETE' });
    diagnostics.length = 0;
  });

  it('a step on assembly bytes uploaded through the Web API runs them and changes the data, then updated content runs the new code', async () => {
    const assembly = await post('pluginassemblies', { content: bytes.v1.toString('base64') });
    const type = await post('plugintypes', {
      typename: 'Contoso.Uploaded.NameStamp',
      name: 'Contoso.Uploaded.NameStamp',
      'pluginassemblyid@odata.bind': `/pluginassemblies(${assembly})`,
    });
    const step = await registerStep(type);
    const item = items().find((entry) => entry.id === step);
    assert.equal(item.mode, 'clr', 'no /_sim/ choice or trusted descriptor is needed');
    const first = await createWidget('alpha');
    assert.equal(first.response.status, 204, await first.response.clone().text());
    assert.equal(await nameOf(first.id), 'alpha-v1');
    assert.ok(diagnostics.some((entry) => entry.code === 'PLUGIN_STEP_CLR_EXECUTED' && entry.stepId === step));
    const prepared = runtimes.get(step).directory;
    assert.ok(prepared.startsWith(fs.realpathSync(uploads.cacheRoot)), 'the bytes are prepared under the cache root');

    const updated = await call(`pluginassemblies(${assembly})`, {
      method: 'PATCH',
      body: { content: bytes.v2.toString('base64') },
    });
    assert.equal(updated.status, 204, await updated.clone().text());
    const second = await createWidget('beta');
    assert.equal(second.response.status, 204, await second.response.clone().text());
    assert.equal(await nameOf(second.id), 'beta-v2', 'the updated content runs');
    assert.notEqual(runtimes.get(step).directory, prepared, 'the changed content was prepared again');
    assert.equal(fs.existsSync(prepared), false, 'the runtime of the old content was closed');

    // Deleting the step closes its runtime (the host sweeps on every catalogue rebuild).
    const current = runtimes.get(step).directory;
    assert.equal((await call(`sdkmessageprocessingsteps(${step})`, { method: 'DELETE' })).status, 204);
    created.splice(created.indexOf(step), 1);
    releaseStaleUploadedRuntimes(store, runtimes, items());
    assert.equal(runtimes.has(step), false);
    assert.equal(fs.existsSync(current), false);
  });

  // @test-kind parity: native trial captures native-trial and native-trial-r2 (dataverse-recorder round 2, n3-package): a step on a packaged type runs and the package's dependent unsigned assembly resolves at execution
  it("a plug-in package's other lib assembly resolves as the plug-in's dependency", async () => {
    const nuspec = Buffer.from(
      '<?xml version="1.0"?><package><metadata><id>Contoso.Packaged</id><version>1.0.0</version></metadata></package>',
    );
    const content = zipOf([
      { name: 'Contoso.Packaged.nuspec', data: nuspec },
      { name: 'lib/net462/Contoso.Packaged.dll', data: bytes.packaged },
      { name: 'lib/net462/Contoso.Packaged.Helpers.dll', data: bytes.helpers },
    ]).toString('base64');
    const pkg = await post('pluginpackages', { content });
    const assembly = store
      .tableRows('pluginassembly')
      .find((row) => String(row.packageid?.id ?? row.packageid).toLowerCase() === pkg.toLowerCase());
    await registerStep(typeOf(assembly.pluginassemblyid).plugintypeid);
    const { response, id } = await createWidget('gamma');
    assert.equal(response.status, 204, await response.clone().text());
    assert.equal(await nameOf(id), 'gamma-helper');
  });

  // @test-kind contract: user decision 2026-10-30 (C08): an uploaded assembly that cannot load faults 0x80040224 and rolls back; the message wording is a local model
  it('without a Microsoft.Xrm.Sdk the step fails with the plug-in load fault 0x80040224 and the create rolls back', async () => {
    const previous = uploads.sdkAssembly;
    uploads.sdkAssembly = path.join(uploads.cacheRoot, 'missing', 'Microsoft.Xrm.Sdk.dll');
    try {
      const assembly = await post('pluginassemblies', { content: bytes.unloadable.toString('base64') });
      const type = await post('plugintypes', {
        typename: 'Contoso.Unloadable.NameStamp',
        name: 'Contoso.Unloadable.NameStamp',
        'pluginassemblyid@odata.bind': `/pluginassemblies(${assembly})`,
      });
      await registerStep(type);
      const before = store.tableRows('contoso_widget').length;
      const { response } = await createWidget('delta');
      assert.equal(response.status, 400);
      const { error } = await response.json();
      assert.equal(error.code, '0x80040224');
      assert.match(error.message, /Contoso\.Unloadable\.NameStamp/);
      assert.match(error.message, /Contoso\.Unloadable/);
      assert.equal(store.tableRows('contoso_widget').length, before, 'the create rolled back');
      assert.ok(diagnostics.some((entry) => entry.code === 'PLUGIN_CLR_LOAD_FAILED'));
    } finally {
      uploads.sdkAssembly = previous;
    }
  });
});

// @test-kind contract: the documented Microsoft.Xrm.Sdk discovery order for uploaded assemblies (mirage/docs/dataverse-plugins.md)
describe('Microsoft.Xrm.Sdk discovery for uploaded assemblies', () => {
  it('takes the explicit path, then PAQVILO_XRM_SDK, then the newest NuGet copy; an explicit missing path fails', async () => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-xrm-sdk-'));
    after(() => removeFixtureDirectory(root));
    const sdk = (version) => {
      const file = path.join(
        root,
        'nuget',
        'microsoft.crmsdk.coreassemblies',
        version,
        'lib',
        'net462',
        'Microsoft.Xrm.Sdk.dll',
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'invented');
      return file;
    };
    sdk('9.0.2.9');
    const newest = sdk('9.0.2.10');
    const env = { NUGET_PACKAGES: path.join(root, 'nuget') };
    assert.equal(resolveXrmSdk({ env }), newest);
    assert.equal(resolveXrmSdk({ env: { ...env, PAQVILO_XRM_SDK: sdk('1.0.0') } }), path.resolve(sdk('1.0.0')));
    assert.equal(resolveXrmSdk({ sdkAssembly: newest, env: { PAQVILO_XRM_SDK: 'ignored' } }), newest);
    assert.throws(
      () => resolveXrmSdk({ env: { ...env, PAQVILO_XRM_SDK: path.join(root, 'absent.dll') } }),
      /PAQVILO_XRM_SDK/,
    );
  });
});
