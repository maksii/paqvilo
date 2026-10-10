import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  schemaFromFormXml,
  renderComponent,
  clientRuntime,
  contextualViewFetchXml,
  injectRuntime,
  readLookupView,
} from "../lib/platform.mjs";
import { createWebFormSessions } from "../lib/form-service.mjs";

test('exported advanced redirect steps retain an omitted record query name when rendered directly', async () => {
  const id = 'd6300000-0000-4000-8000-000000000001';
  const step = { kind: 'advancedformstep', id: 'finish', adx_webform: 'wizard', adx_type: 100000003, adx_redirecturl: '/detail/?existing=1', adx_redirecturlappendentityidquerystring: true };
  const options = { portal: { advancedForms: [{ id: 'wizard', name: 'Wizard', metadata: { adx_startstep: 'finish' } }], records: [step], pages: [] }, schemas: {}, store: {} };
  const context = { request: { url: 'http://localhost/form/', params: { stepid: 'finish', id } } };
  assert.equal(await renderComponent('webform', 'Wizard', context, options), `<script>location.replace("/detail/?existing=1&${id}");</script>`);
  step.adx_redirecturlquerystringname = 'row';
  assert.equal(await renderComponent('webform', 'Wizard', context, options), `<script>location.replace("/detail/?existing=1&row=${id}");</script>`);
  step.adx_redirecturl = '/detail/?existing=1#record';
  assert.equal(await renderComponent('webform', 'Wizard', context, options), `<script>location.replace("/detail/?existing=1&row=${id}#record");</script>`);
});

test("lookup views follow exact XML paging cookies and fail explicitly on incomplete pagination", async () => {
  const calls = [],
    cookie = '<cookie page="1"><name last="A & B"/></cookie>',
    identity = { id: "contact" };
  const rows = await readLookupView(
    '<fetch count="5000"><entity name="term"/></fetch>',
    {
      fetchXml: async (xml, user) => {
        calls.push({ xml, user });
        return calls.length === 1
          ? {
              entities: [{ id: "first" }],
              more_records: true,
              paging_cookie: cookie,
            }
          : { entities: [{ id: "later" }], more_records: false };
      },
    },
    identity,
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ["first", "later"],
  );
  assert.equal(calls[1].user, identity);
  assert.match(
    calls[1].xml,
    /count="5000" page="2" paging-cookie="&lt;cookie page=&quot;1&quot;/,
  );
  await assert.rejects(
    readLookupView(
      '<fetch><entity name="term"/></fetch>',
      {
        fetchXml: async () => ({
          entities: [{ id: "first" }],
          more_records: true,
        }),
      },
      identity,
    ),
    (error) => error.code === "LOOKUP_VIEW_PAGING_UNRESOLVED",
  );
});

test("readonly and hidden lookup bindings do not query inaccessible lookup choices", async () => {
  const formConfig = (html) =>
  JSON.parse(/<script type="application\/json" data-paqvilo-mirage-form-config>([\s\S]*?)<\/script>/.exec(html)[1]);
  const lookedUp = [];
  const store = {
    resolveMapping: (entity) => {
      if (entity !== "example")
        throw new Error("Audit lookup mapping is absent");
      return {
        relationships: {
          audit: { from: "createdby", entity: "systemuser", many: false },
        },
      };
    },
    get: async () => ({
      createdby: {
        id: "actor",
        logical_name: "systemuser",
        name: "Local service actor",
      },
    }),
    query: async (entity) => {
      lookedUp.push(entity);
      throw new Error("Lookup choice read is forbidden");
    },
  };
  const html = await renderComponent(
    "entityform",
    "audit",
    { request: { params: { id: "record" } } },
    {
      store,
      portal: { forms: [{ id: "audit", mode: 100000001 }], records: [] },
      schemas: {
        audit: {
          entity: "example",
          fields: [
            { name: "createdby", type: "lookup", validForUpdate: false },
            {
              name: "hiddenaudit",
              type: "lookup",
              hidden: true,
              readOnly: true,
              lookupTargets: ["systemuser"],
            },
          ],
        },
      },
    },
  );
  assert.deepEqual(lookedUp, []);
  // Native read-only lookup: disabled text box plus the hidden id/entityname pair, no modal.
  assert.match(html, /id="createdby_name" class="text form-control lookup form-control  readonly" readonly="" aria-readonly="true"/);
  assert.match(html, /value="Local service actor"/);
  assert.doesNotMatch(html, /createdby_lookupmodal|launchentitylookup/);
  assert.deepEqual(formConfig(html).fields, []);
});

test("editable hidden lookups retain native navigation bindings without reading target choices", async () => {
  const formConfig = (html) =>
  JSON.parse(/<script type="application\/json" data-paqvilo-mirage-form-config>([\s\S]*?)<\/script>/.exec(html)[1]);
  const store = {
    resolveMapping: (entity) =>
      entity === "example"
        ? {
            relationships: {
              contactnav: { from: "contactid", entity: "contact", many: false },
            },
          }
        : { entitySet: "contacts" },
    query: async () => {
      throw new Error("Hidden lookup choices must not be queried");
    },
  };
  const html = await renderComponent(
    "entityform",
    "hidden",
    {},
    {
      store,
      portal: { forms: [{ id: "hidden", mode: 100000000 }], records: [] },
      schemas: {
        hidden: {
          entity: "example",
          fields: [{ name: "contactid", type: "lookup", hidden: true }],
        },
      },
    },
  );
  const field = formConfig(html).fields.find((candidate) => candidate.name === "contactid");
  assert.deepEqual(field.bindings, { contact: { navigation: "contactnav", entitySet: "contacts" } });
  assert.match(html, /<input name="[^"]*\$contactid" type="hidden" id="contactid" value="">/);
  assert.match(html, /id="contactid_entityname" value="contact"/);
});

test("rich text adapters fetch source-bound configuration URLs and reject malformed source JSON", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rte-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "configuration.js");
  await fs.writeFile(
    file,
    JSON.stringify({ defaultSupportedProps: { height: 195 } }),
  );
  const portal = {
    forms: [{ id: "form" }],
    records: [],
    webFiles: [
      {
        file,
        url: "/resources/configuration.js",
        metadata: { adx_filename: "configuration.js" },
      },
    ],
  };
  const options = {
    portal,
    store: { resolveMapping: () => ({}) },
    schemas: {
      form: {
        entity: "example",
        fields: [
          {
            name: "narrative",
            richText: {
              name: "RichText",
              configUrl: "/_webresource/configuration.js",
            },
          },
        ],
      },
    },
  };
  const html = await renderComponent("entityform", "form", {}, options);
  assert.match(html, /"configUrl":"\/resources\/configuration.js"/);
  assert.doesNotMatch(html, /"height":195/);
  await fs.writeFile(file, "invalid JSON");
  await assert.rejects(
    renderComponent("entityform", "form", {}, options),
    (error) => error.code === "RICHTEXT_CONFIG_INVALID",
  );
});

test("native form query aliases select component records and rich text binds JSON HTML without source markup injection", async () => {
  const requested = [];
  const portal = {
    forms: [
      {
        id: "edit",
        name: "Edit",
        mode: 100000001,
        metadata: { adx_recordidquerystringparametername: "pnpccid" },
      },
    ],
    records: [],
    webFiles: [],
  };
  const store = {
    resolveMapping: () => ({ idColumn: "rowid" }),
    get: async (_entity, id) => {
      requested.push(id);
      return { narrative: "<p>Saved &amp; formatted text</p>" };
    },
  };
  const html = await renderComponent(
    "entityform",
    "Edit",
    { request: { params: { id: "application", pnpccid: "change" } } },
    {
      portal,
      store,
      schemas: {
        edit: {
          entity: "example",
          fields: [
            {
              name: "narrative",
              type: "textarea",
              richText: {
                name: "MscrmControls.RichTextEditor.RichTextEditorControl",
              },
            },
          ],
        },
      },
    },
  );
  assert.deepEqual(requested, ["change"]);
  assert.match(html, /data-sim-richtext-value/);
  assert.match(html, /id="PcfControl_narrative"/);
  assert.match(
    html,
    /value="&quot;&lt;p&gt;Saved &amp;amp; formatted text&lt;\/p&gt;&quot;"/,
  );
  assert.match(html, /RTEGlobalConfiguration/);
  const document = injectRuntime(
    "<html><head></head><body><main></main></body></html>",
    "safe<token",
    "1",
  );
  // Native holder: rendered empty with its token URL; shell.getTokenDeferred fills it.
  assert.match(document, /<body><div id="antiforgerytoken" data-url="\/_layout\/tokenhtml"><\/div>/);
  assert.doesNotMatch(document, /<input name="__RequestVerificationToken"/);
  assert.match(document, /<script src="\/__sim-static\/native\/entity-grid-compat\.js" data-paqvilo-mirage-native><\/script><\/body>/);
  const again = injectRuntime(document, "safe<token", "2");
  assert.equal(again.match(/id="antiforgerytoken"/g).length, 1);
  assert.equal(again.match(/entity-grid-compat\.js/g).length, 1);
});

test("page trace propagation correlates same-origin fetch/XHR and preserves explicit headers without tracing external requests", async () => {
  const requests = [];
  class XMLHttpRequest {
    open(method, url) {
      this.url = url;
      this.headers = {};
    }
    setRequestHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    }
    send() {
      requests.push({ url: this.url, headers: this.headers });
    }
  }
  const scope = {
    window: null,
    document: { addEventListener() {} },
    location: {
      href: "http://127.0.0.1:8787/page/",
      origin: "http://127.0.0.1:8787",
    },
    URL,
    Headers,
    XMLHttpRequest,
    fetch: async (input, options) => {
      requests.push({
        url: typeof input === "string" ? input : input.url,
        headers: Object.fromEntries(
          new Headers(options?.headers ?? input?.headers),
        ),
      });
    },
    EventSource: class {
      addEventListener() {}
    },
    addEventListener() {},
    setTimeout() {},
  };
  scope.window = scope;
  scope.parent = scope;
  vm.runInNewContext(
    clientRuntime("token", "revision", {}, "trace-parent"),
    scope,
  );
  await scope.fetch("/_api/examples");
  await scope.fetch("http://external.invalid/api");
  await scope.fetch("/explicit", {
    headers: { "x-sim-parent-trace": "caller" },
  });
  const local = new scope.XMLHttpRequest();
  local.open("POST", "/__sim/forms/example");
  local.send();
  const explicit = new scope.XMLHttpRequest();
  explicit.open("GET", "/explicit");
  explicit.setRequestHeader("X-Sim-Parent-Trace", "xhr-caller");
  explicit.send();
  const external = new scope.XMLHttpRequest();
  external.open("GET", "https://external.invalid/api");
  external.send();
  assert.equal(requests[0].headers["x-sim-parent-trace"], "trace-parent");
  assert.equal(requests[1].headers["x-sim-parent-trace"], undefined);
  assert.equal(requests[2].headers["x-sim-parent-trace"], "caller");
  assert.equal(requests[3].headers["x-sim-parent-trace"], "trace-parent");
  assert.equal(requests[4].headers["x-sim-parent-trace"], "xhr-caller");
  assert.deepEqual(requests[5].headers, {});
  assert.match(
    injectRuntime("<head></head>", "token", "rev", {}, "trace<id"),
    /<meta name="sim-trace-id" content="trace&lt;id">/,
  );
});

test("enhanced component views replace contextual conditions at every link depth", () => {
  const xml =
    '<fetch><entity name="account"><filter><condition attribute="accountid" uitype="account" value="authored-account"/><condition attribute="category" value="unchanged"/></filter><link-entity name="contact"><filter><condition attribute="contactid" uitype="contact" value="authored-contact"/><condition attribute="websiteid" uitype="adx_website" value="authored-site"/></filter></link-entity></entity></fetch>';
  const result = contextualViewFetchXml(xml, {
    user: { id: "current-contact", accountId: "current-account" },
    website: { id: "current-site" },
  });
  assert.match(result, /uitype="contact" value="current-contact"/);
  assert.match(result, /uitype="account" value="current-account"/);
  assert.match(result, /uitype="adx_website" value="current-site"/);
  assert.match(result, /attribute="category" value="unchanged"/);
  assert.match(
    contextualViewFetchXml(xml),
    /uitype="contact" value="00000000-0000-0000-0000-000000000000"/,
  );
  assert.equal(xml.includes("authored-contact"), true);
});

test("systemform XML maps ordered controls, labels, types and disabled controls", () => {
  const schema = schemaFromFormXml(
    '<form><tabs><tab><columns><column><sections><section><rows><row><cell visible="true"><labels><label description="Nom" languagecode="1036"/><label description="Name &amp; title" languagecode="1033"/></labels><control id="name" datafieldname="fullname" disabled="false" /></cell><cell><control id="age" datafieldname="age" disabled="true"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>',
    { entity: "contact", fieldTypes: { age: "number" } },
  );
  assert.equal(schema.entity, "contact");
  assert.deepEqual(
    schema.fields.map((f) => f.name),
    ["fullname", "age"],
  );
  assert.equal(schema.fields[0].label, "Name & title");
  assert.equal(schema.fields[1].type, "number");
  assert.equal(schema.fields[1].readOnly, true);
  assert.throws(
    () => schemaFromFormXml("<!DOCTYPE form><form></form>"),
    /declarations/,
  );
});
test("mapped form and list query identity, render escaping and original custom script", async () => {
  const formConfig = (html) =>
  JSON.parse(/<script type="application\/json" data-paqvilo-mirage-form-config>([\s\S]*?)<\/script>/.exec(html)[1]);
  let received;
  const store = {
    resolveMapping: () => ({ entitySet: "contacts", idColumn: "contactid" }),
    get: async (_entity, id, identity) => {
      received = { id, identity };
      return { fullname: "<Ada>", active: true };
    },
    query: async () => ({ value: [{ contactid: "abc", fullname: "<Ada>" }] }),
  };
  const portal = {
    forms: [
      { id: "form", name: "Edit contact", mode: 100000001, js: "window.formScript=true;" },
    ],
    lists: [{ id: "list", name: "Contacts", entityName: "contact", metadata: {} }],
    records: [],
    website: { id: "site" },
    pages: [],
  };
  const context = {
    user: { id: "current" },
    request: { params: { id: "abc" } },
  };
  const schemas = {
    form: {
      entity: "contact",
      fields: [
        { name: "fullname", required: true },
        { name: "active", type: "boolean" },
      ],
    },
    list: { entity: "contact", fields: [{ name: "fullname" }] },
  };
  const form = await renderComponent("entityform", "form", context, {
    portal,
    store,
    schemas,
  });
  assert.deepEqual(received, { id: "abc", identity: context.user });
  assert.equal(formConfig(form).submitUrl, "/__sim/forms/entityform/form/submit");
  assert.match(form, /id="fullname" class="text form-control " onchange="setIsDirty\(this.id\);" value="&lt;Ada&gt;" aria-required="true"/);
  assert.match(form, /<span id="RequiredFieldValidatorfullname" style="display:none;">\*<\/span>/);
  assert.match(form, /type="checkbox" name="[^"]*\$active" checked="checked"/);
  // Native order: the custom JavaScript span is the first child of the form control.
  assert.match(form, /<div id="EntityFormControl_form" data-pp-native-form><span><script type="text\/javascript">window.formScript=true;<\/script><\/span>/);
  // Legacy EntityForm adds the startup script before reading the record: a missing record
  // or a read denial still runs it, ahead of the message.
  const notFound = await renderComponent("entityform", "form", { ...context, request: { params: {} } }, { portal, store, schemas });
  assert.match(notFound, /^<div id="EntityFormControl_form"><span><script type="text\/javascript">window.formScript=true;<\/script><\/span><div id="MessagePanel"[^>]*><span id="MessageLabel">The record you are looking for couldn&#39;t be found\.<\/span>/);
  const deniedStore = { ...store, get: async () => { throw Object.assign(new Error("denied"), { status: 403 }); } };
  const denied = await renderComponent("entityform", "form", context, { portal, store: deniedStore, schemas });
  assert.match(denied, /^<div id="EntityFormControl_form"><span><script type="text\/javascript">window.formScript=true;<\/script><\/span><div class='alert alert-block alert-danger'><span class='fa fa-lock'/);
  // An authored {% entitylist %} only exposes the list object; it does not render the grid.
  const list = await renderComponent("entitylist", "list", context, {
    portal,
    store,
    schemas,
    args: { name: "list" },
  });
  assert.equal(list.html, "");
  assert.equal(list.context.entitylist.entity_logical_name, "contact");
  assert.equal(list.context.entitylist.get_data_url, "/_services/entity-grid-data.json/site");
  // The built-in entity_list include (key matches the include variable) renders the grid shell.
  const grid = await renderComponent("entitylist", "list", { ...context, key: "list" }, {
    portal,
    store,
    schemas,
    args: { key: "list" },
  });
  assert.match(grid.html, /<div class="entitylist"><div class="entity-grid entitylist" [^>]*data-get-url="\/_services\/entity-grid-data.json\/site"/);
  assert.equal(
    await renderComponent("entityform", "", context, { portal, store }),
    "",
  );
  // A form name that resolves to no exported form renders nothing (platform entityform tag).
  const missing = [];
  assert.equal(await renderComponent("entityform", "missing", context, { portal, store, diagnostic: (entry) => missing.push(entry) }), "");
  assert.deepEqual(missing.map((entry) => [entry.code, entry.form]), [["COMPONENT_NOT_EXPORTED", "missing"]]);
});

test("portal runtime adds legacy contains and the native shell token API", () => {
  const js = clientRuntime("verification", "1");
  assert.match(js, /String\.prototype, Array\.prototype/);
  for (const member of ["getTokenDeferred", "ajaxSafePost", "refreshToken"])
    assert.match(js, new RegExp("window\\.shell\\." + member));
  // Validation globals belong to native form pages only (webforms-compat.js).
  assert.doesNotMatch(js, /Page_Validators|entityFormClientValidate/);
});

test("legacy jQuery window load handlers retain event semantics without changing AJAX load", () => {
  const handlers = {};
  const scope = {
    addEventListener() {},
    document: {
      addEventListener: (event, fn) => {
        handlers[event] = fn;
      },
    },
    EventSource: class {
      addEventListener() {}
    },
  };
  scope.window = scope;
  vm.runInNewContext(clientRuntime("token", "revision"), scope);
  scope.jQuery = {
    fn: {
      load(url) {
        return "ajax:" + url;
      },
    },
  };
  handlers.load();
  const collection = Object.create(scope.jQuery.fn);
  collection.on = (event, callback) => ({ event, callback });
  const callback = () => {};
  assert.deepEqual(collection.load(callback), { event: "load", callback });
  assert.equal(collection.load("/fragment"), "ajax:/fragment");
});

test("runtime bootstrap is singleton and closes/reopens its one tab stream across page lifecycle", () => {
  const listeners = {},
    documentListeners = {},
    streams = [];
  const scope = {
    document: {
      addEventListener: (name, fn) => (documentListeners[name] ??= []).push(fn),
    },
    addEventListener: (name, fn) => (listeners[name] ??= []).push(fn),
    location: { reload() {} },
    EventSource: class {
      constructor() {
        this.readyState = 1;
        streams.push(this);
      }
      addEventListener() {}
      close() {
        this.readyState = 2;
      }
    },
  };
  scope.window = scope;
  scope.parent = scope;
  const source = clientRuntime("token", "1", {
    contactId: "contact-id",
    firstname: "Quoted </script> name",
  });
  assert.doesNotMatch(source, /<\/script>/);
  vm.runInNewContext(source, scope);
  vm.runInNewContext(clientRuntime("token", "2"), scope);
  assert.equal(streams.length, 1);
  // Form submission and grid handling are native compatibility scripts, not shared runtime listeners.
  assert.equal(documentListeners.submit, undefined);
  assert.equal(documentListeners.click, undefined);
  assert.equal(scope.__portalSimulation.revision, "2");
  assert.equal(scope.Microsoft.Dynamic365.Portal.User.contactId, "contact-id");
  assert.equal(
    scope.Microsoft.Dynamic365.Portal.User.firstName,
    "Quoted </script> name",
  );
  listeners.pagehide[0]();
  assert.equal(streams[0].readyState, 2);
  listeners.pageshow[0]();
  listeners.pageshow[0]();
  assert.equal(streams.length, 2);
  assert.equal(listeners.pagehide.length, 1);
});

test("advanced progress, empty quick views, scoped subgrids and authored action markup match native contracts", async () => {
  const layoutsOf = (html, selector = 'class="entity-grid') => {
  const start = html.indexOf(selector);
  const encoded = /data-view-layouts="([^"]*)"/.exec(html.slice(start))[1];
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
};
  const portal = {
    website: { id: "site" },
    forms: [],
    lists: [],
    pages: [],
    advancedForms: [
      {
        id: "wizard",
        name: "Wizard",
        metadata: {
          adx_progressindicatorenabled: true,
          adx_progressindicatorprependstepnum: true,
        },
      },
    ],
    records: [
      {
        adx_webformstep: "second",
        adx_subgrid_name: "Children",
        adx_subgrid_settings: JSON.stringify({
          ViewActions: [
            {
              Type: "CrmEntityFormView-CreateAction",
              EntityFormId: "child-form",
              ButtonLabel: [
                {
                  LCID: 1033,
                  Value: "<svg data-exported-icon></svg>Add child",
                },
              ],
            },
          ],
        }),
      },
    ],
  };
  const store = {
    resolveMapping: (entity) =>
      entity === "contact"
        ? {
            entitySet: "contacts",
            idColumn: "contactid",
            relationships: {
              contact_children: {
                entity: "child",
                from: "contactid",
                to: "parentid",
                many: true,
              },
            },
          }
        : { entitySet: "children", idColumn: "childid" },
    get: async () => ({ fullname: "Local Person" }),
    fetchXml: async () => {
      throw new Error("Subgrid rows load through the native grid service, not during rendering");
    },
  };
  const cells = [
    {
      type: "quickform",
      id: "Details",
      lookup: "parentid",
      entity: "contact",
      schema: { formName: "Contact quick view", fields: [{ name: "fullname", label: "Full name" }] },
    },
    {
      type: "subgrid",
      id: "Children",
      entity: "child",
      relationship: "contact_children",
      fields: [{ name: "name", label: "Name" }],
      fetchXml:
        '<fetch><entity name="child"><attribute name="name"/></entity></fetch>',
    },
  ];
  const schemas = {
    wizard: {
      initialStepId: "first",
      steps: [
        { stepId: "first", nextStepId: "second", title: "First" },
        {
          stepId: "second",
          entity: "contact",
          mode: 100000001,
          title: "Second",
          fields: [{ name: "fullname" }],
          layout: [
            {
              name: "tab",
              columns: [{ sections: [{ name: "section", rows: [cells] }] }],
            },
          ],
        },
      ],
    },
  };
  // A visitor session that saved the first step and is on the second.
  const webFormSessions = createWebFormSessions();
  const progressed = webFormSessions.create("wizard", "visitor:progress");
  progressed.history.push({ stepId: "first", recordId: null, entity: null });
  progressed.current = "second";
  const sessionOptions = { webFormSessions, webFormOwner: () => "visitor:progress" };
  const html = await renderComponent(
    "webform",
    "Wizard",
    { request: { params: { id: "person", stepid: "second" } } },
    { portal, store, schemas, renderLiquid: async (source) => source, ...sessionOptions },
  );
  assert.match(
    html,
    /<ol class="progress list-group top"><li class="list-group-item text-muted list-group-item-success complete"><span class="number">1<\/span>First<span class="glyphicon glyphicon-ok"><\/span><\/li>/,
  );
  assert.match(html, /<li class="list-group-item active"><span class="number">2<\/span>Second/);
  assert.match(html, /id="NextButton"/);
  assert.match(html, /id="WebFormControl_wizard_ProgressIndicator"/);
  assert.match(html, /id="WebFormPanel" class="crmEntityFormView"/);
  assert.match(html, /<div id="EntityFormView" class="entity-form"><input type="hidden" name="ctl00\$ContentContainer\$WebFormControl_wizard\$EntityFormView\$EntityFormView_EntityName" id="EntityFormView_EntityName" value="contact">/);
  assert.match(html, /<div class="actions"><div class="col-sm-6 clearfix"><div role="group" class="btn-group entity-action-button">/);
  // Subgrid: native shell with relationship reference and configuration-only layouts.
  assert.match(html, /<div id="Children" class="subgrid"><div class="entity-grid subgrid" [^>]*data-get-url="\/_services\/entity-subgrid-data.json\/site"[^>]*data-ref-entity="contact" data-ref-id="person" data-ref-rel="contact_children"/);
  const [layout] = layoutsOf(html);
  assert.equal(layout.Columns[0].Name, "Name");
  assert.equal(layout.Configuration.ViewActionLinks[0].Label, "<svg data-exported-icon></svg>Add child");
  assert.equal(layout.Configuration.ViewActionLinks[0].EntityForm.Id, "child-form");
  assert.match(html, /class="modal fade modal-form modal-form-insert"/);
  // Quick view: native iframe, empty without a related record.
  assert.match(html, /class="clearfix cell crmquickform-cell"/);
  assert.match(html, /<div class="control"><iframe src="about:blank" id="Details" tabindex="0" class="quickform" data-path="\/_portal\/quickform-template-path\/site"/);
  const relatedHtml = await renderComponent(
    "webform",
    "Wizard",
    { request: { params: { id: "person", stepid: "second" } } },
    {
      portal,
      store: { ...store, get: async (_entity, id) => (id === "person" ? { parentid: "related" } : { fullname: "Readonly related name" }) },
      schemas,
      renderLiquid: async (source) => source,
      ...sessionOptions,
    },
  );
  assert.match(relatedHtml, /<iframe src="\/_portal\/quickform-template-path\/site\?entityid=related&amp;entityname=contact&amp;entityprimarykeyname=contactid&amp;formname=Contact%20quick%20view&amp;controlid=Details"/);
  assert.doesNotMatch(relatedHtml, /srcdoc=|holdReady/);
});

test("configured component read provider supplies records, lookups and views consistently", async () => {
  const layoutsOf = (html, selector = 'class="entity-grid') => {
  const start = html.indexOf(selector);
  const encoded = /data-view-layouts="([^"]*)"/.exec(html.slice(start))[1];
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
};
  const reads = [];
  const store = {
    resolveMapping: (name) =>
      name === "contact"
        ? {
            entitySet: "contacts",
            idColumn: "contactid",
            relationships: {
              customer: {
                entity: "account",
                from: "parentcustomerid",
                to: "accountid",
                many: false,
              },
            },
          }
        : { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" },
    get: () => {
      throw new Error("Local record provider used");
    },
    query: () => {
      throw new Error("Local query provider used");
    },
  };
  const readProvider = {
    get: async (entity, id) => {
      reads.push(["get", entity, id]);
      return {
        parentcustomerid: {
          id: "org",
          name: "Online organisation",
          logical_name: "account",
        },
      };
    },
    query: async (entity) => {
      reads.push(["query", entity]);
      return { value: [{ accountid: "org", name: "Online organisation" }] };
    },
    fetchXml: async (xml) => {
      reads.push(["fetch", xml]);
      return { entities: [{ contactid: "c1", fullname: "Online contact" }], total_record_count: 1 };
    },
  };
  const portal = {
    website: { id: "site" },
    pages: [],
    forms: [{ id: "form", name: "Edit", mode: 100000001 }],
    lists: [{ id: "list", name: "Contacts", entityName: "contact", metadata: {} }],
    records: [],
  };
  const schemas = {
    form: {
      entity: "contact",
      fields: [{ name: "parentcustomerid", type: "lookup" }],
    },
    list: {
      entity: "contact",
      fetchXml: '<fetch><entity name="contact"><attribute name="fullname"/></entity></fetch>',
      fields: [{ name: "fullname" }],
    },
  };
  const form = await renderComponent(
    "entityform",
    "form",
    { request: { params: { id: "person" } } },
    { portal, store, readProvider, schemas },
  );
  assert.match(form, /id="parentcustomerid_name"[^>]*value="Online organisation"/);
  // Lookup rows load through the lookup grid service on demand, not during rendering.
  assert.deepEqual(reads, [["get", "contact", "person"]]);
  const [lookupLayout] = layoutsOf(form, 'id="parentcustomerid_lookupmodal"');
  assert.equal(lookupLayout.Configuration.EntityName, "account");
  const { context: listContext } = await renderComponent(
    "entityview",
    "list",
    { entitylist: { id: "list" } },
    { portal, store, readProvider, schemas, args: {} },
  );
  assert.equal(listContext.entityview.records[0].fullname, "Online contact");
  assert.equal(listContext.entityview.total_records, 1);
  assert.equal(reads.length, 2);
  assert.match(reads[1][1], /<fetch count="10" page="1" returntotalrecordcount="true"><entity name="contact"><attribute name="fullname"\/><\/entity><\/fetch>/);
});

test("empty native choices retain a blank select option for source cache refresh", async () => {
  const html = await renderComponent(
    "entityform",
    "choice",
    {},
    {
      portal: { forms: [{ id: "choice", name: "Choice" }], records: [] },
      store: { resolveMapping: () => ({ entitySet: "examples" }) },
      schemas: {
        choice: {
          entity: "example",
          fields: [
            {
              name: "indicator",
              type: "number",
              dataverseType: "picklist",
              options: [
                { value: 172250000, label: "Yes" },
                { value: 172250001, label: "No" },
              ],
            },
          ],
        },
      },
    },
  );
  assert.match(
    html,
    /<select name="[^"]*\$indicator" id="indicator" class="form-control picklist " onchange="setIsDirty\(this.id\);"><option selected="selected" value="" label="Select" aria-label="Select"><\/option>/,
  );
  assert.match(html, /<option value="172250001">No<\/option>/);
  assert.match(html, /class="clearfix cell picklist-cell"|<div class="form-group">/);
});

test("formatted choice wrappers select scalar values and display labels", async () => {
  const store = {
    resolveMapping: () => ({ entitySet: "contacts", idColumn: "contactid" }),
    get: () => ({ statuscode: { value: 1, label: "Active" }, preferred: { value: 2, label: "Email" } }),
  };
  const portal = {
    forms: [{ id: "form", mode: 100000001 }],
    records: [],
  };
  const schemas = {
    form: {
      entity: "contact",
      fields: [
        {
          name: "preferred",
          type: "number",
          dataverseType: "picklist",
          options: [
            { value: 1, label: "Phone" },
            { value: 2, label: "Email" },
          ],
        },
        {
          name: "statuscode",
          type: "number",
          dataverseType: "status",
          options: [
            { value: 1, label: "Active" },
            { value: 2, label: "Inactive" },
          ],
        },
      ],
    },
  };
  const form = await renderComponent(
    "entityform",
    "form",
    { request: { params: { id: "person" } } },
    { portal, store, schemas },
  );
  assert.match(form, /<option selected="selected" value="2">Email<\/option>/);
  // Native status reason cells render the formatted label and are not saved.
  assert.match(form, /<span id="statuscode" class="status ">Active<\/span>/);
});

test("Dataverse bit choices retain the native checkbox contract", async () => {
  const portal = { forms: [{ id: "form", mode: 100000001 }], records: [] };
  const store = {
    resolveMapping: () => ({
      entitySet: "applications",
      idColumn: "applicationid",
    }),
    get: () => ({ userdeclaration: true }),
  };
  const schemas = {
    form: {
      entity: "application",
      fields: [
        {
          name: "userdeclaration",
          type: "boolean",
          options: [
            { value: 0, label: "No" },
            { value: 1, label: "Yes" },
          ],
        },
      ],
    },
  };
  const html = await renderComponent(
    "entityform",
    "form",
    { request: { params: { id: "application" } } },
    { portal, store, schemas },
  );
  assert.match(
    html,
    /<span class="checkbox "><input id="userdeclaration" type="checkbox" name="[^"]*\$userdeclaration" checked="checked" onclick="setIsDirty\(this.id\);"><\/span>/,
  );
  assert.doesNotMatch(html, /<select[^>]*id="userdeclaration"/);
  schemas.form.fields[0].controlClassId = "3ef39988-22bb-4f0b-bbbe-64b5a3748aee";
  const dropdown = await renderComponent("entityform", "form", {request:{params:{id:"application"}}}, {portal,store,schemas});
  assert.match(dropdown, /<select name="[^"]*\$userdeclaration" id="userdeclaration" class="form-control boolean-dropdown " onchange="setIsDirty\(this.id\);">/);
  assert.match(dropdown, /<option selected="selected" value="1">Yes<\/option>/);
  assert.doesNotMatch(dropdown, /type="checkbox"/);
  schemas.form.fields[0].controlClassId = "67fac785-cd58-4f9f-abb3-4b7ddc6ed5ed";
  const radio = await renderComponent("entityform", "form", {request:{params:{id:"application"}}}, {portal,store,schemas});
  assert.match(radio, /<span id="userdeclaration" class="boolean-radio "[^>]*><input id="userdeclaration_0" type="radio"[^>]* value="0"><label for="userdeclaration_0"><span class='sr-only'>userdeclaration <\/span>No<\/label><input id="userdeclaration_1" type="radio"[^>]* value="1" checked="checked">/);
});

test("imported form layouts supply section legends without an invented outer legend", async () => {
  const portal = {
    forms: [{ id: "form", name: "Component name" }],
    records: [],
  };
  const store = {
    resolveMapping: () => ({ entitySet: "contacts", idColumn: "contactid" }),
  };
  const schemas = {
    form: {
      entity: "contact",
      title: "Component name",
      fields: [{ name: "fullname", label: "Name" }],
      layout: [
        {
          name: "tab",
          columns: [
            {
              sections: [
                {
                  name: "details",
                  label: "Details",
                  showLabel: true,
                  rows: [[{ name: "fullname", label: "Name" }]],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const html = await renderComponent(
    "entityform",
    "form",
    {},
    { portal, store, schemas },
  );
  assert.equal((html.match(/<legend\b/g) ?? []).length, 1);
  assert.match(html, /<legend class="section-title"><h3>Details<\/h3><\/legend>/);
  assert.doesNotMatch(html, /<legend>Component name<\/legend>/);
});

test("exported lookup views filter choices and owner fields stay hidden when configured", async () => {
  const formConfig = (html) =>
  JSON.parse(/<script type="application\/json" data-paqvilo-mirage-form-config>([\s\S]*?)<\/script>/.exec(html)[1]);
  const xml =
      '<fetch><entity name="term"><filter><condition attribute="category" operator="eq" value="country"/></filter></entity></fetch>',
    reads = [];
  const portal = {
    forms: [{ id: "form", metadata: { adx_showownerfields: false } }],
    records: [],
  };
  const store = {
    resolveMapping: (name) => {
      assert.notEqual(name, "owner");
      return name === "application"
        ? {
            entitySet: "applications",
            relationships: {
              country: { entity: "term", from: "countryid", many: false },
              ownerid: { entity: "owner", from: "ownerid", many: false },
            },
          }
        : { entitySet: "terms", idColumn: "termid", nameColumn: "name" };
    },
    fetchXml: async (source) => {
      reads.push(source);
      return {
        entities: [{ termid: "country", shortname: "FR", name: "France" }],
      };
    },
    query: () => {
      throw Error("Unfiltered lookup query used");
    },
  };
  const html = await renderComponent(
    "entityform",
    "form",
    {},
    {
      portal,
      store,
      schemas: {
        form: {
          entity: "application",
          fields: [
            { name: "ownerid", type: "lookup" },
            {
              name: "countryid",
              type: "lookup",
              lookupStyle: "dropdown",
              lookupView: {
                entity: "term",
                fetchXml: xml,
                fields: [{ name: "shortname" }],
              },
            },
          ],
        },
      },
    },
  );
  assert.deepEqual(reads, [xml]);
  // Native "render lookup as dropdown": a select of the lookup view rows.
  assert.match(html, /<select name="[^"]*\$countryid" id="countryid" class="lookup form-control "[^>]*><option value="" label="Select" aria-label="Select"><\/option><option value="country">FR<\/option><\/select>/);
  assert.doesNotMatch(html, /id="ownerid"/);
  assert.ok(!formConfig(html).fields.some((field) => field.name === "ownerid"));
  assert.doesNotMatch(html, /ownerid_lookupmodal/);
});


test("basic forms without exported form XML render an approximated native section and report it", async () => {
  const diagnostics = [];
  const portal = {
    forms: [{ id: "contact-us", name: "Contact Us Form", entityName: "lead", formName: "Contact Us Personal Web Form", mode: 100000000, metadata: {} }],
    records: [{ kind: "basicformmetadata", adx_entityform: "contact-us", adx_type: 100000000, adx_attributelogicalname: "description" }],
  };
  const metadata = {
    entities: {
      lead: {
        primaryNameAttribute: "fullname",
        fields: {
          fullname: { name: "fullname", label: "Name", dataverseType: "nvarchar", type: "text", validForCreate: false },
          lastname: { name: "lastname", label: "Last Name", dataverseType: "nvarchar", type: "text", required: true, requiredLevel: "applicationrequired" },
          subject: { name: "subject", label: "Topic", dataverseType: "nvarchar", type: "text", required: true, requiredLevel: "applicationrequired" },
          ownerid: { name: "ownerid", label: "Owner", dataverseType: "owner", type: "lookup", required: true, requiredLevel: "systemrequired" },
          description: { name: "description", label: "Description", dataverseType: "memo", type: "textarea" },
        },
      },
    },
  };
  const html = await renderComponent("entityform", "Contact Us Form", {}, {
    portal,
    metadata,
    schemas: {},
    store: { resolveMapping: () => ({ entitySet: "leads", idColumn: "leadid", relationships: {} }) },
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.match(html, /<table role="presentation" data-name="general" class="section">/);
  assert.match(html, /<label for="lastname" id="lastname_label" class="field-label">Last Name<\/label>/);
  assert.match(html, /id="subject"/);
  assert.match(html, /<textarea name="[^"]*\$description"[^>]*id="description"/);
  assert.doesNotMatch(html, /id="ownerid"|id="fullname"/);
  assert.doesNotMatch(html, /<legend/);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "COMPONENT_SCHEMA_REQUIRED");
  assert.deepEqual(diagnostics[0].fields, ["lastname", "subject", "description"]);
  assert.match(diagnostics[0].message, /Contact Us Personal Web Form/);
  // Without an exported basic form the platform renders nothing; the absence is reported.
  diagnostics.length = 0;
  assert.equal(await renderComponent("entityform", "Unknown form", {}, { portal, metadata, schemas: {}, store: { resolveMapping: () => ({}) }, diagnostic: (entry) => diagnostics.push(entry) }), "");
  assert.deepEqual(diagnostics.map((entry) => entry.code), ["COMPONENT_NOT_EXPORTED"]);
  // An exported form whose table has no metadata still cannot be laid out locally.
  await assert.rejects(
    renderComponent("entityform", "Orphan form", {}, { portal: { ...portal, forms: [{ id: "orphan", name: "Orphan form", metadata: {} }] }, metadata, schemas: {}, store: { resolveMapping: () => ({}) } }),
    (error) => error.code === "COMPONENT_SCHEMA_REQUIRED" && error.status === 501,
  );
});

test("FormXml section labels become fieldset aria-labels; legends follow showlabel", async (t) => {
  const { createSimulator } = await import("../server.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "formxml-sections-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const portal = path.join(root, "portal"), solution = path.join(root, "solution");
  const files = {
    [path.join(portal, "website.yml")]: "adx_websiteid: site\nadx_name: Test",
    [path.join(portal, "Home.webpage.yml")]: "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    [path.join(portal, "Main.pagetemplate.yml")]: "adx_pagetemplateid: template\nadx_webtemplateid: main",
    [path.join(portal, "Main.webtemplate.yml")]: "adx_webtemplateid: main\nadx_name: Main",
    [path.join(portal, "Main.webtemplate.source.html")]: '{% entityform name: "Contact" %}',
    [path.join(portal, "Contact.basicform.yml")]: "adx_entityformid: contact-form\nadx_name: Contact\nadx_entityname: contact\nadx_formname: Portal contact\nadx_mode: 100000000",
    [path.join(solution, "Entities/Contact/Entity.xml")]:
      '<Entity><Name>contact</Name><EntityInfo><entity><attributes><attribute PhysicalName="fullname"><Name>fullname</Name><LogicalName>fullname</LogicalName><Type>nvarchar</Type><displaynames><displayname description="Full name" languagecode="1033" /></displaynames></attribute><attribute PhysicalName="telephone1"><Name>telephone1</Name><LogicalName>telephone1</LogicalName><Type>nvarchar</Type><displaynames><displayname description="Business phone" languagecode="1033" /></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
    [path.join(solution, "Entities/Contact/FormXml/main/{contact-form}.xml")]:
      '<forms><systemform><formid>{contact-form}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general" showlabel="false"><labels><label description="General" languagecode="1033" /></labels><columns><column width="100%"><sections>' +
      '<section name="details" showlabel="true"><labels><label description="Contact details" languagecode="1033" /><label description="Coordonnées" languagecode="1036" /></labels><rows><row><cell><labels><label description="Name" languagecode="1033" /></labels><control id="fullname" datafieldname="fullname" /></cell></row></rows></section>' +
      '<section name="routing" showlabel="false"><labels><label description="Internal routing" languagecode="1033" /></labels><rows><row><cell><labels><label description="" languagecode="1033" /></labels><control id="telephone1" datafieldname="telephone1" /></cell></row></rows></section>' +
      '</sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Portal contact" languagecode="1033" /></LocalizedNames></systemform></forms>',
  };
  for (const [file, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  const app = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    stateFile: path.join(root, "state.json"),
    watch: false,
    initial: { mappings: { contact: { entitySet: "contacts", idColumn: "contactid" } }, tables: { contact: [] }, permissions: [], settings: { permissionMode: "permissive" }, simulator: { identity: { id: "editor" } } },
  });
  t.after(() => app.close());
  const html = await (await fetch(app.url + "/")).text();
  // A labelled section keeps its FormXml label (languagecode 1033) as aria-label and legend.
  assert.match(html, /<fieldset aria-label="Contact details"><legend class="section-title"><h3>Contact details<\/h3><\/legend><table role="presentation" data-name="details" class="section">/);
  // showlabel="false" keeps the aria-label and omits the legend, as the platform does.
  assert.match(html, /<fieldset aria-label="Internal routing"><table role="presentation" data-name="routing" class="section">/);
  assert.doesNotMatch(html, /aria-label="Section"/);
  // Cell label first, then the column display name for an empty cell label.
  assert.match(html, /<label for="fullname" id="fullname_label" class="field-label">Name<\/label>/);
  assert.match(html, /<label for="telephone1" id="telephone1_label" class="field-label">Business phone<\/label>/);
});

test("dropdown lookups over a table the identity cannot read render without choices and report it", async () => {
  const diagnostics = [];
  const denied = Object.assign(new Error("No read permission on account"), { status: 403 });
  const store = {
    resolveMapping: (name) =>
      name === "contact"
        ? { entitySet: "contacts", idColumn: "contactid", relationships: { parentcustomerid_account: { entity: "account", from: "parentcustomerid", many: false } } }
        : { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" },
    query: async (entity) => {
      if (entity === "account") throw denied;
      return { value: [] };
    },
  };
  const html = await renderComponent("entityform", "form", {}, {
    portal: { forms: [{ id: "form", name: "Profile", metadata: {} }], records: [] },
    store,
    schemas: { form: { entity: "contact", fields: [{ name: "parentcustomerid", type: "lookup", lookupStyle: "dropdown", label: "Organisation" }] } },
    diagnostic: (entry) => diagnostics.push(entry),
  });
  // The control renders with only the blank option; the denial is reported, not thrown.
  assert.match(html, /<select name="[^"]*\$parentcustomerid" id="parentcustomerid" class="lookup form-control "[^>]*><option value="" label="Select" aria-label="Select"><\/option><\/select>/);
  assert.deepEqual(diagnostics.map((entry) => [entry.code, entry.field, entry.entity]), [["LOOKUP_CHOICES_DENIED", "parentcustomerid", "account"]]);
  // Other read failures still surface.
  store.query = async () => {
    throw Object.assign(new Error("Query failed"), { status: 500 });
  };
  await assert.rejects(
    renderComponent("entityform", "form", {}, { portal: { forms: [{ id: "form", name: "Profile", metadata: {} }], records: [] }, store, schemas: { form: { entity: "contact", fields: [{ name: "parentcustomerid", type: "lookup", lookupStyle: "dropdown" }] } } }),
    /Query failed/,
  );
});

test("advanced forms without resolved systemforms render approximated steps; unresolved steps fall back and are reported", async () => {
  const diagnostics = [];
  const portal = {
    pages: [{ id: "done-page", url: "/done/" }],
    advancedForms: [{ id: "appeal", name: "Appeal", metadata: { adx_startstep: "s1" } }],
    records: [
      { kind: "advancedformstep", id: "s1", name: "Details", adx_webform: "appeal", adx_type: 100000001, adx_targetentitylogicalname: "lead", adx_formname: "Appeal Form", adx_mode: 100000000, adx_nextstep: "s2" },
      { kind: "advancedformstep", id: "s2", name: "Finished", adx_webform: "appeal", adx_type: 100000003, adx_redirectwebpage: "done-page" },
      { kind: "advancedformmetadata", adx_webformstep: "s1", adx_type: 100000000, adx_attributelogicalname: "description" },
    ],
  };
  const metadata = {
    entities: {
      lead: {
        primaryNameAttribute: "subject",
        fields: {
          subject: { name: "subject", label: "Topic", dataverseType: "nvarchar", type: "text" },
          lastname: { name: "lastname", label: "Last Name", dataverseType: "nvarchar", type: "text", required: true, requiredLevel: "applicationrequired" },
          description: { name: "description", label: "Description", dataverseType: "memo", type: "textarea" },
        },
      },
    },
  };
  const options = {
    portal,
    metadata,
    schemas: {},
    store: { resolveMapping: () => ({ entitySet: "leads", idColumn: "leadid", relationships: {} }) },
    diagnostic: (entry) => diagnostics.push(entry),
  };
  const html = await renderComponent("webform", "Appeal", { request: { params: {} } }, options);
  assert.match(html, /<div id="WebFormControl_appeal" data-pp-native-form>/);
  assert.match(html, /id="subject"/);
  assert.match(html, /id="lastname"/);
  assert.match(html, /<textarea name="[^"]*\$description"[^>]*id="description"/);
  // The next step is the exported redirect step, so the button submits.
  assert.match(html, /<input type="button" name="ctl00\$ContentContainer\$WebFormControl_appeal\$NextButton" value="Submit"/);
  assert.deepEqual(diagnostics.map((entry) => [entry.code, entry.component, entry.step]), [["COMPONENT_SCHEMA_REQUIRED", "webform", "Details"]]);
  diagnostics.length = 0;
  // A stepid parameter opens that step directly; one absent from the metadata falls back and is reported.
  const direct = await renderComponent("webform", "Appeal", { request: { params: { stepid: "missing-step" } } }, options);
  assert.match(direct, /id="lastname"/);
  assert.ok(diagnostics.some((entry) => entry.code === "ADVANCEDFORM_STEP_UNRESOLVED" && entry.step === "missing-step" && entry.rendered === "s1"));
  // A session whose step is absent from the metadata falls back to the start step.
  diagnostics.length = 0;
  const webFormSessions = createWebFormSessions();
  webFormSessions.create("appeal", "visitor:stale").current = "missing-step";
  const fallback = await renderComponent("webform", "Appeal", { request: { params: {} } }, { ...options, webFormSessions, webFormOwner: () => "visitor:stale" });
  assert.match(fallback, /id="lastname"/);
  assert.ok(diagnostics.some((entry) => entry.code === "ADVANCEDFORM_STEP_UNRESOLVED" && entry.step === "missing-step" && entry.rendered === "s1"));
  // Without any exported step record there is nothing to render.
  await assert.rejects(
    renderComponent("webform", "Appeal", { request: { params: {} } }, { ...options, portal: { ...portal, records: [] } }),
    (error) => error.code === "COMPONENT_SCHEMA_REQUIRED" && error.status === 501,
  );
});

test("advanced forms follow a start step that another advanced form's export owns", async () => {
  const diagnostics = [];
  const portal = {
    pages: [],
    advancedForms: [
      { id: "organisation", name: "Organisation", metadata: { adx_startstep: "shared" } },
      { id: "person", name: "Person", metadata: { adx_startstep: "shared" } },
    ],
    records: [{ kind: "advancedformstep", id: "shared", name: "Identifier", adx_webform: "organisation", adx_type: 100000001, adx_targetentitylogicalname: "product", adx_formname: "Particulars", adx_mode: 100000000 }],
  };
  const metadata = { entities: { product: { primaryNameAttribute: "name", fields: { name: { name: "name", label: "Product name", dataverseType: "nvarchar", type: "text" } } } } };
  const html = await renderComponent("webform", "Person", { request: { params: {} } }, {
    portal,
    metadata,
    schemas: {},
    store: { resolveMapping: () => ({ entitySet: "products", idColumn: "productid", relationships: {} }) },
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.match(html, /<div id="WebFormControl_person" data-pp-native-form>/);
  assert.match(html, /<label for="name" id="name_label" class="field-label">Product name<\/label>/);
  assert.deepEqual(diagnostics.map((entry) => [entry.code, entry.step]), [["COMPONENT_SCHEMA_REQUIRED", "Identifier"]]);
});

test("list and grid labels use the request's website language, then the website default", async () => {
  const label = (english, french) => [{ LCID: 1033, Value: english }, { LCID: 1036, Value: french }];
  const settings = {
    LoadingMessage: label("Loading", "Chargement"),
    ErrorMessage: label("Error", "Erreur"),
    DeleteDialog: { Title: label("Delete", "Supprimer"), Confirmation: label("Delete this record?", "Supprimer cet enregistrement ?") },
  };
  const portal = {
    forms: [],
    lists: [{ id: "list", name: "Contacts", entityName: "contact", metadata: { adx_settings: JSON.stringify(settings) } }],
    records: [],
    website: { id: "site" },
    pages: [],
    websiteLanguages: [{ id: "en", code: "en-US", lcid: 1033, isDefault: true }, { id: "fr", code: "fr-FR", lcid: 1036 }],
  };
  const store = { resolveMapping: () => ({ entitySet: "contacts", idColumn: "contactid" }), query: async () => ({ value: [] }) };
  const render = (language) =>
    renderComponent("entitylist", "list", { user: { id: "current" }, request: { params: {} }, key: "list", __language: language }, { portal, store, schemas: { list: { entity: "contact", fields: [{ name: "fullname" }] } }, args: { key: "list" } });
  const configuration = (html) => JSON.parse(Buffer.from(/data-view-layouts="([^"]*)"/.exec(html)[1], "base64").toString("utf8"))[0].Configuration;
  const french = (await render({ id: "fr", code: "fr-FR", lcid: 1036 })).html;
  assert.equal(configuration(french).LoadingMessage, "Chargement");
  assert.equal(configuration(french).ErrorMessage, "Erreur");
  assert.match(french, /class="modal fade modal-delete"[^>]*>.*?<h1 class="modal-title" title="Supprimer">Supprimer<\/h1>.*?Supprimer cet enregistrement \?/s);
  // A language without labels falls back to the website default (here French), not to the first value.
  portal.websiteLanguages = [{ id: "en", code: "en-US", lcid: 1033 }, { id: "fr", code: "fr-FR", lcid: 1036, isDefault: true }];
  const german = (await render({ id: "de", code: "de-DE", lcid: 1031 })).html;
  assert.equal(configuration(german).LoadingMessage, "Chargement");
});
