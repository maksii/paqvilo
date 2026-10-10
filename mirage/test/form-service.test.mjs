import test from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../lib/data.mjs";
import { submitPortalForm, createWebFormSessions, webFormSessionOwner, formText, redirectTarget } from "../lib/form-service.mjs";

test('native redirects preserve configured and omitted record parameter names while appending exported query values', () => {
  const id = 'D6300000-0000-4000-8000-000000000001';
  const record = { title: 'A & B' };
  const settings = { adx_redirecturl: '/detail/?existing=1', adx_redirecturlappendentityidquerystring: true, adx_appendquerystring: true, adx_redirecturlcustomquerystring: 'custom=two+words', adx_redirecturlquerystringattributeparamname: 'label', adx_redirecturlquerystringattribute: 'title' };
  const args = { portal: {}, recordId: id, record, requestUrl: 'http://localhost/create/?from=page&from=other' };
  const before = JSON.stringify({ settings, record });
  assert.equal(redirectTarget(settings, args), `/detail/?existing=1&${id.toLowerCase()}&from=page&from=other&custom=two+words&label=A+%26+B`);
  assert.equal(redirectTarget({ ...settings, adx_redirecturlquerystringname: 'row' }, args), `/detail/?existing=1&row=${id.toLowerCase()}&from=page&from=other&custom=two+words&label=A+%26+B`);
  assert.equal(redirectTarget({ ...settings, adx_redirecturlquerystringname: '' }, args), redirectTarget(settings, args));
  assert.equal(JSON.stringify({ settings, record }), before, 'redirect composition does not mutate source configuration or saved records');
  assert.equal(redirectTarget({ adx_redirecturl: '/detail/', adx_redirecturlappendentityidquerystring: true }, args), `/detail/?${id.toLowerCase()}`);
  assert.equal(redirectTarget({ adx_redirecturl: '/detail/#record', adx_redirecturlappendentityidquerystring: true }, args), `/detail/?${id.toLowerCase()}#record`);
  assert.equal(redirectTarget({ ...settings, adx_redirecturlappendentityidquerystring: false }, args), '/detail/?existing=1&from=page&from=other&custom=two+words&label=A+%26+B');
});

async function setup() {
  const store = await new DataStore({
    state: {
      mappings: {
        contact: {
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
        },
        account: { entitySet: "accounts", idColumn: "accountid" },
      },
      tables: {
        contact: [],
        account: [{ accountid: "org", name: "Local organisation" }],
      },
      settings: { permissionMode: "enforce", "Webapi/contact/enabled": false },
      permissions: [
        {
          entity: "contact",
          scope: "global",
          roles: ["Editor"],
          operations: ["create", "read", "update"],
        },
        {
          entity: "account",
          scope: "global",
          roles: ["Editor"],
          operations: ["read"],
        },
      ],
      plugins: [
        {
          entity: "contact",
          operations: ["create", "update"],
          validate: [
            {
              field: "fullname",
              pattern: "^(?!Blocked$).+",
              message: "Blocked by backend validation",
            },
          ],
        },
      ],
    },
  }).init();
  const fields = [
    { name: "fullname", required: true },
    { name: "parentcustomerid", type: "lookup" },
    { name: "ownerid", type: "lookup" },
  ];
  const portal = {
    forms: [
      { id: "create", mode: 100000000 },
      { id: "edit", mode: 100000001 },
      { id: "readonly", mode: 100000002 },
    ],
    advancedForms: [{ id: "wizard" }],
  };
  const schemas = {
    create: { entity: "contact", fields },
    edit: { entity: "contact", fields },
    readonly: { entity: "contact", fields },
    wizard: {
      initialStepId: "first",
      steps: [
        { stepId: "first", entity: "contact", mode: 100000000, fields },
        { stepId: "second", entity: "contact", mode: 100000001, fields },
        { stepId: "redirect", type: "redirect" },
      ],
    },
  };
  return {
    portal,
    store,
    schemas,
    identity: { id: "editor", roles: ["Editor"] },
    sessions: createWebFormSessions(),
  };
}
test("native forms save bound fields through table permissions independently of Web API settings", async () => {
  const options = await setup();
  const saved = await submitPortalForm(
    "entityform",
    "create",
    {
      values: {
        fullname: "Local contact",
        "customer@odata.bind": "/accounts(org)",
      },
    },
    options,
  );
  assert.equal(saved.operation, "create");
  assert.ok(saved.recordId);
  assert.equal(saved.record.parentcustomerid.id, "org");
  const changed = await submitPortalForm(
    "entityform",
    "edit",
    {
      recordId: saved.recordId,
      values: { fullname: "Updated contact", "customer@odata.bind": null },
    },
    options,
  );
  assert.equal(changed.record.parentcustomerid, null);
  assert.equal(changed.record.fullname, "Updated contact");
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "edit",
      { recordId: saved.recordId, values: { fullname: "Forbidden" } },
      { ...options, identity: { id: "visitor", roles: [] } },
    ),
    (e) => e.code === "PermissionDenied",
  );
});

test('native create and unchanged edit submissions use their exported redirect name without assigning an id fallback', async () => {
  const options = await setup();
  const metadata = { adx_onsuccess: 756150001, adx_redirecturl: '/detail/', adx_redirecturlappendentityidquerystring: true };
  for (const form of options.portal.forms) form.metadata = { ...metadata };
  const created = await submitPortalForm('entityform', 'create', { values: { fullname: 'Native redirect record' } }, options);
  assert.equal(created.outcome.url, `/detail/?${created.recordId}`);
  const before = options.store.snapshot().tables.contact;
  options.portal.forms.find(form => form.id === 'edit').metadata.adx_redirecturlquerystringname = 'row';
  const edited = await submitPortalForm('entityform', 'edit', { recordId: created.recordId, values: { fullname: 'Native redirect record' } }, options);
  assert.equal(edited.outcome.url, `/detail/?row=${created.recordId}`);
  assert.equal(edited.recordId, created.recordId);
  assert.equal(options.store.snapshot().tables.contact.length, before.length);
  assert.equal(edited.record.fullname, created.record.fullname);
});

test("required rich text rejects markup-only values and preserves meaningful formatted HTML", async () => {
  const options = await setup();
  options.schemas.create.fields.push({
    name: "narrative",
    richText: { name: "MscrmControls.RichTextEditor.RichTextEditorControl" },
    required: true,
  });
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "create",
      {
        values: {
          fullname: "Local contact",
          narrative: "<div><br>&nbsp;</div>",
        },
      },
      options,
    ),
    (error) => error.code === "FormFieldRequired",
  );
  assert.equal(options.store.snapshot().tables.contact.length, 0);
  const html = "<div><strong>Meaningful application change</strong></div>";
  const result = await submitPortalForm(
    "entityform",
    "create",
    { values: { fullname: "Local contact", narrative: html } },
    options,
  );
  assert.equal(result.record.narrative, html);
});
test("native form submissions reject unbound, owner, read-only and invalid step payloads without partial writes", async () => {
  const options = await setup();
  const before = options.store.snapshot();
  for (const values of [
    { fullname: "Local", extra: "UI only" },
    { ownerid: "owner" },
    { "unknown@odata.bind": "/accounts(org)" },
  ])
    await assert.rejects(
      submitPortalForm("entityform", "create", { values }, options),
      (e) => e.code === "FormFieldNotBound",
    );
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "readonly",
      { recordId: "record", values: {} },
      options,
    ),
    (e) => e.code === "FormReadOnly",
  );
  await assert.rejects(
    submitPortalForm(
      "webform",
      "wizard",
      { stepId: "redirect", values: {} },
      options,
    ),
    (e) => e.code === "InvalidFormStep",
  );
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "create",
      { values: { fullname: "Blocked" } },
      options,
    ),
    /Blocked by backend validation/,
  );
  assert.deepEqual(options.store.snapshot(), before);
});
test("advanced forms accept the steps of their session and require the saved record for edits", async () => {
  const options = await setup();
  options.schemas.wizard.steps[0].nextStepId = "second";
  const saved = await submitPortalForm(
    "webform",
    "wizard",
    { stepId: "first", values: { fullname: "First step" } },
    options,
  );
  const changed = await submitPortalForm(
    "webform",
    "wizard",
    {
      stepId: "second",
      recordId: saved.recordId,
      values: { fullname: "Second step" },
    },
    options,
  );
  assert.equal(changed.recordId, saved.recordId);
  assert.equal(changed.stepId, "second");
  assert.equal(changed.record.fullname, "Second step");
  // The completed session accepts no further step, and a new session only its start step.
  await assert.rejects(
    submitPortalForm(
      "webform",
      "wizard",
      { stepId: "second", values: { fullname: "No session" } },
      options,
    ),
    (e) => e.code === "InvalidFormStep",
  );
  // An edit step needs its record.
  options.portal.advancedForms.push({ id: "editing" });
  options.schemas.editing = { initialStepId: "edit", steps: [{ stepId: "edit", entity: "contact", mode: 100000001, fields: options.schemas.edit.fields }] };
  await assert.rejects(
    submitPortalForm("webform", "editing", { values: { fullname: "No record" } }, options),
    (e) => e.code === "FormRecordRequired",
  );
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "create",
      { recordId: saved.recordId, values: { fullname: "Wrong operation" } },
      options,
    ),
    /create form/,
  );
});

test("required and read-only native controls are validated against the current server record", async () => {
  const options = await setup();
  await assert.rejects(
    submitPortalForm("entityform", "create", { values: {} }, options),
    (e) => e.code === "FormFieldRequired",
  );
  const saved = await submitPortalForm(
    "entityform",
    "create",
    { values: { fullname: "Original" } },
    options,
  );
  options.schemas.edit.fields[0].readOnly = true;
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "edit",
      { recordId: saved.recordId, values: { fullname: "Tampered" } },
      options,
    ),
    (e) => e.code === "FormFieldReadOnly",
  );
  const changed = await submitPortalForm(
    "entityform",
    "edit",
    { recordId: saved.recordId, values: { fullname: "Original" } },
    options,
  );
  assert.equal(changed.record.fullname, "Original");
  assert.equal(options.store.snapshot().tables.contact.length, 1);
});

test("Dataverse nonwritable column flags cannot be relaxed by form metadata", async () => {
  const options = await setup();
  options.schemas.create.fields[0].validForCreate = false;
  options.portal.records = [
    {
      kind: "basicformmetadata",
      adx_entityform: "create",
      adx_attributelogicalname: "fullname",
      adx_readonly: false,
    },
  ];
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "create",
      { values: { fullname: "Tampered audit column" } },
      options,
    ),
    (error) => error.code === "FormFieldReadOnly",
  );
  assert.equal(options.store.snapshot().tables.contact.length, 0);
  delete options.schemas.create.fields[0].validForCreate;
  const saved = await submitPortalForm(
    "entityform",
    "create",
    { values: { fullname: "Original" } },
    options,
  );
  options.schemas.edit.fields[0].validForUpdate = false;
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "edit",
      {
        recordId: saved.recordId,
        values: { fullname: "Tampered audit column" },
      },
      options,
    ),
    (error) => error.code === "FormFieldReadOnly",
  );
});

test("native on-save metadata derives current contact and typed constants for local and upstream providers", async () => {
  const options = await setup(),
    contactId = "11111111-1111-1111-1111-111111111111";
  const state = options.store.snapshot();
  state.tables.contact.push({
    contactid: contactId,
    fullname: "Server contact",
    emailaddress1: "server@example.invalid",
  });
  state.mappings.contact.relationships.modifiedbycontact = {
    entity: "contact",
    from: "modifiedbycontactid",
    to: "contactid",
    many: false,
  };
  await options.store.replaceState(state);
  options.identity = { ...options.identity, contactId };
  options.schemas.create.fields.push(
    { name: "modifiedbycontactid", type: "lookup", hidden: true },
    { name: "confirmed", type: "boolean", readOnly: true },
    { name: "statuscode", type: "number", dataverseType: "picklist" },
    { name: "savedat", type: "date" },
  );
  options.schemas.create.onSaveFields = [
    { name: "contactemail", type: "email" },
  ];
  const metadata = (name, type, value, attribute) => ({
    kind: "basicformmetadata",
    adx_entityform: "create",
    adx_attributelogicalname: name,
    adx_setvalueonsave: true,
    adx_onsavetype: type,
    adx_onsavevalue: value,
    adx_onsavefromattribute: attribute,
  });
  options.portal.records = [
    metadata("modifiedbycontactid", 100000002, undefined, "contactid"),
    metadata("confirmed", 100000000, "false"),
    metadata("statuscode", 100000000, "2"),
    metadata("savedat", 100000001),
    metadata("contactemail", 100000002, undefined, "emailaddress1"),
  ];
  options.now = () => new Date("2026-10-07T12:00:00Z");
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "create",
      {
        values: {
          fullname: "Client injection",
          contactemail: "forged@example.invalid",
        },
      },
      options,
    ),
    (e) => e.code === "FormFieldNotBound",
  );
  const saved = await submitPortalForm(
    "entityform",
    "create",
    {
      values: {
        fullname: "Local metadata",
        confirmed: true,
        modifiedbycontactid: "tampered",
      },
    },
    options,
  );
  assert.equal(saved.record.modifiedbycontactid.id, contactId);
  assert.equal(saved.record.confirmed, false);
  assert.equal(saved.record.statuscode, 2);
  assert.equal(saved.record.savedat, "2026-10-07T12:00:00.000Z");
  assert.equal(saved.record.contactemail, "server@example.invalid");
  let written;
  const before = options.store.snapshot();
  await submitPortalForm(
    "entityform",
    "create",
    { values: { fullname: "Upstream metadata" } },
    {
      ...options,
      writeProvider: {
        create: async (_entity, values) => {
          written = values;
          return { ...values, contactid: "upstream-created" };
        },
      },
    },
  );
  assert.equal(
    written["modifiedbycontact@odata.bind"],
    `/contacts(${contactId})`,
  );
  assert.equal(written.confirmed, false);
  assert.deepEqual(options.store.snapshot(), before);
  options.portal.records[0].adx_onsavetype = 999;
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "create",
      { values: { fullname: "Invalid metadata" } },
      options,
    ),
    (e) => e.code === "FormSaveTypeUnsupported" && e.status === 501,
  );
  assert.deepEqual(options.store.snapshot(), before);
});

test("basic and advanced native inserts associate the authenticated contact without a scenario plugin", async () => {
  const options = await setup(),
    first = "11111111-1111-1111-1111-111111111111",
    second = "22222222-2222-2222-2222-222222222222";
  const state = options.store.snapshot();
  state.tables.contact.push(
    { contactid: first, fullname: "First editor" },
    { contactid: second, fullname: "Second editor" },
  );
  state.mappings.contact.relationships.createdbycontact = {
    entity: "contact",
    from: "creatorid",
    to: "contactid",
    many: false,
  };
  await options.store.replaceState(state);
  options.identity = { ...options.identity, contactId: first };
  options.portal.forms[0].metadata = {
    adx_associatecurrentportaluser: true,
    adx_portaluserlookupattribute: "creatorid",
  };
  options.schemas.create.currentUserAssociationField = {
    name: "creatorid",
    type: "lookup",
  };
  options.schemas.wizard.steps[0].metadata = {
    adx_associatecurrentportaluser: true,
    adx_targetentityportaluserlookupattribute: "creatorid",
  };
  options.schemas.wizard.steps[0].currentUserAssociationField = {
    name: "creatorid",
    type: "lookup",
  };
  const basic = await submitPortalForm(
    "entityform",
    "create",
    { values: { fullname: "Basic associated" } },
    options,
  );
  const advanced = await submitPortalForm(
    "webform",
    "wizard",
    { stepId: "first", values: { fullname: "Advanced associated" } },
    options,
  );
  assert.equal(basic.record.creatorid.id, first);
  assert.equal(advanced.record.creatorid.id, first);
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "create",
      { values: { fullname: "Spoofed creator", creatorid: second } },
      options,
    ),
    (e) => e.code === "FormFieldNotBound",
  );
  options.schemas.edit.currentUserAssociationField = {
    name: "creatorid",
    type: "lookup",
  };
  options.portal.forms[1].metadata = options.portal.forms[0].metadata;
  const changed = await submitPortalForm(
    "entityform",
    "edit",
    { recordId: basic.recordId, values: { fullname: "Edited by second" } },
    { ...options, identity: { ...options.identity, contactId: second } },
  );
  assert.equal(changed.record.creatorid.id, first);
  let payload;
  const before = options.store.snapshot();
  await submitPortalForm(
    "entityform",
    "create",
    { values: { fullname: "Upstream associated" } },
    {
      ...options,
      writeProvider: {
        create: async (_entity, values) => {
          payload = values;
          return { contactid: "upstream", ...values };
        },
      },
    },
  );
  assert.equal(payload["createdbycontact@odata.bind"], `/contacts(${first})`);
  assert.deepEqual(options.store.snapshot(), before);
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "create",
      { values: { fullname: "Anonymous" } },
      { ...options, identity: { roles: ["Editor"] } },
    ),
    (e) => e.code === "FormSaveContactRequired",
  );
  options.portal.forms[0].metadata.adx_portaluserlookupattributeisactivityparty = true;
  await assert.rejects(
    submitPortalForm(
      "entityform",
      "create",
      { values: { fullname: "Unsupported activity" } },
      options,
    ),
    (e) => e.code === "FormUserAssociationUnsupported",
  );
  assert.deepEqual(options.store.snapshot(), before);
});

test("basic and advanced forms without a resolved systemform submit their approximated layout", async () => {
  const options = await setup();
  const metadata = {
    entities: {
      contact: {
        primaryNameAttribute: "fullname",
        fields: {
          fullname: { name: "fullname", label: "Full Name", dataverseType: "nvarchar", type: "text" },
          jobtitle: { name: "jobtitle", label: "Job Title", dataverseType: "nvarchar", type: "text", required: true, requiredLevel: "applicationrequired" },
        },
      },
    },
  };
  const portal = {
    ...options.portal,
    forms: [...options.portal.forms, { id: "profile", name: "Profile", entityName: "contact", formName: "Missing Form", mode: 100000000, metadata: {} }],
    advancedForms: [...options.portal.advancedForms, { id: "signup", name: "Sign up", metadata: { adx_startstep: "step1" } }],
    records: [{ kind: "advancedformstep", id: "step1", name: "Details", adx_webform: "signup", adx_type: 100000001, adx_targetentitylogicalname: "contact", adx_mode: 100000000 }],
    pages: [],
  };
  const saved = await submitPortalForm("entityform", "profile", { values: { fullname: "Approximated", jobtitle: "Analyst" } }, { ...options, portal, metadata });
  assert.equal(saved.operation, "create");
  const row = options.store.snapshot().tables.contact.find((item) => item.contactid === saved.recordId);
  assert.deepEqual([row.fullname, row.jobtitle], ["Approximated", "Analyst"]);
  // Columns outside the approximated layout stay unbound.
  await assert.rejects(
    submitPortalForm("entityform", "profile", { values: { fullname: "X", jobtitle: "Y", emailaddress1: "x@example.test" } }, { ...options, portal, metadata }),
    (error) => error.code === "FormFieldNotBound",
  );
  const step = await submitPortalForm("webform", "signup", { stepId: "step1", values: { fullname: "Step contact", jobtitle: "Lead" } }, { ...options, portal, metadata });
  assert.ok(step.recordId);
  // Without metadata, an export-only basic form still answers with the unresolved layout error.
  await assert.rejects(submitPortalForm("entityform", "profile", { values: {} }, { ...options, portal: { ...portal, forms: [{ id: "profile", name: "Profile", metadata: {} }] } }), (error) => error.status === 501);
});

test("Allow Create If Null creates only for a record associated to the current portal user, as the form renders", async () => {
  const options = await setup();
  const metadata = (sourceType) => ({ adx_entitysourcetype: sourceType, adx_recordsourceallowcreateonnull: true });
  options.portal.forms.push({ id: "querystring", mode: 100000001, metadata: metadata(756150001) }, { id: "associated", mode: 100000001, metadata: metadata(756150003) });
  options.schemas.querystring = { entity: "contact", fields: options.schemas.edit.fields };
  options.schemas.associated = { entity: "contact", fields: options.schemas.edit.fields };
  // A query-string Edit form without its record id renders "record not found"; it cannot create.
  await assert.rejects(
    submitPortalForm("entityform", "querystring", { values: { fullname: "No record" } }, options),
    (error) => error.code === "FormRecordRequired",
  );
  const created = await submitPortalForm("entityform", "associated", { values: { fullname: "First save" } }, options);
  assert.equal(created.operation, "create");
  assert.equal(options.store.snapshot().tables.contact.length, 1);
});

// ---------------------------------------------------------------------------
// Atomic units, sessions, form-level access and request languages .

async function setupUnits() {
  const options = await setup();
  const state = options.store.snapshot();
  state.mappings.annotation = { entitySet: "annotations", idColumn: "annotationid" };
  state.tables.annotation = [];
  // Anonymous visitors may create contacts in these synthetic forms.
  state.permissions.push({ entity: "contact", scope: "global", roles: ["Anonymous Users"], operations: ["create", "read", "update"] });
  await options.store.replaceState(state);
  options.schemas.wizard.steps[0].nextStepId = "second";
  return options;
}
const anonymous = { id: null, contactId: null, roles: ["Anonymous Users"] };
const file = (name, bytes, type = "text/plain") => ({ name, type, content: Buffer.alloc(bytes, 65).toString("base64") });

test("a submission's record and notes are one unit: a refused note or a rejected file saves nothing", async () => {
  const options = await setupUnits();
  options.portal.forms.push({ id: "notes", mode: 100000000, metadata: { adx_attachfile: true, adx_attachfileallowmultiple: true, adx_attachfilemaxsize: 1 } });
  options.schemas.notes = { entity: "contact", fields: options.schemas.create.fields };
  const before = options.store.snapshot();
  // Files are checked before any write: an oversized file leaves no contact behind.
  await assert.rejects(
    submitPortalForm("entityform", "notes", { values: { fullname: "Too large" }, attachments: [file("a.txt", 10), file("b.txt", 2048)] }, options),
    (e) => e.code === "FormAttachmentTooLarge",
  );
  assert.deepEqual(options.store.snapshot().tables, before.tables);
  // The editor may create contacts but not notes: the refused note rolls the contact back.
  await assert.rejects(
    submitPortalForm("entityform", "notes", { values: { fullname: "Refused note" }, attachments: [file("a.txt", 10)] }, options),
    (e) => e.code === "PermissionDenied",
  );
  assert.deepEqual(options.store.snapshot().tables, before.tables);
  // With the note granted, the contact and its note are saved together.
  const state = options.store.snapshot();
  state.permissions.push({ entity: "annotation", scope: "global", roles: ["Editor"], operations: ["create", "read"] });
  await options.store.replaceState(state);
  const saved = await submitPortalForm("entityform", "notes", { values: { fullname: "With note" }, attachments: [file("a.txt", 10)] }, options);
  const tables = options.store.snapshot().tables;
  assert.deepEqual(tables.contact.map((row) => row.fullname), ["With note"]);
  assert.equal(tables.annotation.length, 1);
  assert.equal(tables.annotation[0].filename, "a.txt");
  assert.equal(String(tables.annotation[0].objectid?.id ?? tables.annotation[0].objectid), saved.recordId);
});

test("a failing association rolls back the record a provider transaction created", async () => {
  const options = await setupUnits();
  const writes = [];
  let committed = false;
  // A provider with its own unit (as the runtime supplies): nothing commits when the work fails.
  options.writeProvider = {
    transaction: async (work) => {
      const staged = [];
      const result = await work({
        create: async (entity, values) => (staged.push(["create", entity]), { contactid: "staged", ...values }),
        update: async () => {
          throw new Error("unused");
        },
        associate: async () => {
          throw Object.assign(new Error("Association refused"), { code: "PermissionDenied", status: 403 });
        },
      });
      writes.push(...staged);
      committed = true;
      return result;
    },
  };
  await assert.rejects(
    submitPortalForm("entityform", "create", { values: { fullname: "Child" }, query: { refentity: "account", refid: "org", refrel: "account_contacts" } }, {
      ...options,
      store: {
        ...options.store,
        resolveMapping: (entity) => {
          const mapping = options.store.resolveMapping(entity);
          return entity === "account" ? { ...mapping, relationships: { account_contacts: { entity: "contact", many: true, intersect: "account_contact", schemaName: "account_contacts" } } } : mapping;
        },
      },
    }),
    /Association refused/,
  );
  assert.equal(committed, false);
  assert.deepEqual(writes, []);
});

test("advanced form sessions belong to the runtime and to the browser visitor; a signed-in contact resumes", async () => {
  const options = await setupUnits();
  const visitorOne = webFormSessionOwner(anonymous, "11111111-1111-4111-8111-111111111111");
  const visitorTwo = webFormSessionOwner(anonymous, "22222222-2222-4222-8222-222222222222");
  assert.equal(visitorOne, "visitor:11111111-1111-4111-8111-111111111111");
  assert.equal(webFormSessionOwner({ contactId: "{ABC}" }, "ignored"), "contact:abc");
  assert.equal(webFormSessionOwner(anonymous, null), null);
  const asVisitor = (owner) => ({ ...options, identity: anonymous, owner });
  const first = await submitPortalForm("webform", "wizard", { stepId: "first", values: { fullname: "Visitor one" } }, asVisitor(visitorOne));
  assert.equal(first.outcome.type, "step");
  // Another anonymous visitor does not share that progress.
  await assert.rejects(
    submitPortalForm("webform", "wizard", { stepId: "second", recordId: first.recordId, values: { fullname: "Taken over" } }, asVisitor(visitorTwo)),
    (e) => e.code === "InvalidFormStep",
  );
  // Neither does another runtime.
  await assert.rejects(
    submitPortalForm("webform", "wizard", { stepId: "second", recordId: first.recordId, values: { fullname: "Other runtime" } }, { ...asVisitor(visitorOne), sessions: createWebFormSessions() }),
    (e) => e.code === "InvalidFormStep",
  );
  const second = await submitPortalForm("webform", "wizard", { stepId: "second", recordId: first.recordId, values: { fullname: "Visitor one done" } }, asVisitor(visitorOne));
  assert.equal(second.recordId, first.recordId);
  // A signed-in contact owns its session in every browser session.
  const started = await submitPortalForm("webform", "wizard", { stepId: "first", values: { fullname: "Contact" } }, options);
  const resumed = await submitPortalForm("webform", "wizard", { stepId: "second", recordId: started.recordId, values: { fullname: "Contact done" } }, { ...options, owner: webFormSessionOwner(options.identity, "33333333-3333-4333-8333-333333333333") });
  assert.equal(resumed.recordId, started.recordId);
});

test("submitted steps follow the session or the page's stepid: saved steps reopen, other paths and condition steps are refused", async () => {
  const options = await setupUnits();
  options.schemas.wizard.steps.push({ stepId: "check", type: "condition" });
  const first = await submitPortalForm("webform", "wizard", { stepId: "first", values: { fullname: "Step one" } }, options);
  for (const stepId of ["check", "redirect", "unknown"])
    await assert.rejects(submitPortalForm("webform", "wizard", { stepId, values: {} }, options), (e) => e.code === "InvalidFormStep");
  // Previous returns to a saved step, which accepts a submission again.
  const back = await submitPortalForm("webform", "wizard", { stepId: "second", action: "previous", values: {} }, options);
  assert.equal(back.outcome.url, "/?stepid=first");
  const again = await submitPortalForm("webform", "wizard", { stepId: "first", values: { fullname: "Step one again" } }, options);
  assert.equal(again.recordId, first.recordId);
  // A page opened directly on a step (its URL's stepid, as platform step URLs and portal links
  // carry) submits that step even without session progress; a different step stays refused.
  const direct = { ...options, sessions: createWebFormSessions() };
  const opened = await submitPortalForm("webform", "wizard", { stepId: "second", recordId: first.recordId, query: { stepid: "second" }, values: { fullname: "Opened directly" } }, direct);
  assert.equal(opened.recordId, first.recordId);
  await assert.rejects(
    submitPortalForm("webform", "wizard", { stepId: "second", query: { stepid: "first" }, values: { fullname: "Mismatch" } }, { ...options, sessions: createWebFormSessions() }),
    (e) => e.code === "InvalidFormStep",
  );
  await assert.rejects(
    submitPortalForm("webform", "wizard", { stepId: "check", query: { stepid: "check" }, values: {} }, { ...options, sessions: createWebFormSessions() }),
    (e) => e.code === "InvalidFormStep",
  );
});

test("Authentication Required refuses an anonymous submission before any write", async () => {
  const options = await setupUnits();
  options.portal.advancedForms.push({ id: "secure", metadata: { adx_authenticationrequired: true } });
  options.schemas.secure = { initialStepId: "first", steps: [options.schemas.wizard.steps[0]] };
  const before = options.store.snapshot();
  await assert.rejects(
    submitPortalForm("webform", "secure", { values: { fullname: "Anonymous" } }, { ...options, identity: anonymous, owner: "visitor:44444444-4444-4444-8444-444444444444" }),
    (e) => e.code === "FormAuthenticationRequired" && e.status === 401,
  );
  assert.deepEqual(options.store.snapshot().tables, before.tables);
  const signedIn = await submitPortalForm("webform", "secure", { values: { fullname: "Signed in" } }, options);
  assert.equal(signedIn.operation, "create");
});

test("Multiple Records Per User Permitted = No edits the completed submission, unless editing is not permitted or expired", async () => {
  const options = await setupUnits();
  const single = { initialStepId: "only", steps: [{ stepId: "only", entity: "contact", mode: 100000000, fields: options.schemas.create.fields }] };
  options.portal.advancedForms.push(
    { id: "once", metadata: { adx_multiplerecordsperuserpermitted: false } },
    { id: "locked", metadata: { adx_multiplerecordsperuserpermitted: false, adx_editexistingrecordpermitted: false, adx_editnotpermittedmessage: JSON.stringify([{ LCID: 1033, Value: "Already submitted" }, { LCID: 1036, Value: "Déjà envoyé" }]) } },
    { id: "expiring", metadata: { adx_multiplerecordsperuserpermitted: false, adx_editexpiredstatecode: 1, adx_editexpiredstatuscode: 2 } },
  );
  Object.assign(options.schemas, { once: single, locked: single, expiring: single });
  const created = await submitPortalForm("webform", "once", { values: { fullname: "First submission" } }, options);
  const edited = await submitPortalForm("webform", "once", { values: { fullname: "Edited submission" } }, options);
  assert.equal(edited.operation, "update");
  assert.equal(edited.recordId, created.recordId);
  assert.deepEqual(options.store.snapshot().tables.contact.map((row) => row.fullname), ["Edited submission"]);
  // Edit Existing Record Permitted = No: the form's message, in the request's language.
  await submitPortalForm("webform", "locked", { values: { fullname: "Locked" } }, options);
  await assert.rejects(
    submitPortalForm("webform", "locked", { values: { fullname: "Locked again" } }, { ...options, language: { lcid: 1036, defaultLcid: 1033 } }),
    (e) => e.code === "FormEditNotPermitted" && e.status === 403 && e.message === "Déjà envoyé",
  );
  // A record in the Edit Expired state and status shows the documented completion message.
  const expiring = await submitPortalForm("webform", "expiring", { values: { fullname: "Expiring" } }, options);
  await options.store.update("contact", expiring.recordId, { statecode: 1, statuscode: 2 }, { roles: ["Editor"] });
  await assert.rejects(
    submitPortalForm("webform", "expiring", { values: { fullname: "Expired" } }, options),
    (e) => e.code === "FormEditExpired" && e.message === "You have already completed a submission. Thank you!",
  );
  // Anonymous visitors may submit again (the setting applies to signed-in users).
  const visitor = { ...options, identity: anonymous, owner: "visitor:55555555-5555-4555-8555-555555555555" };
  await submitPortalForm("webform", "once", { values: { fullname: "Visitor first" } }, visitor);
  const repeated = await submitPortalForm("webform", "once", { values: { fullname: "Visitor second" } }, visitor);
  assert.equal(repeated.operation, "create");
});

test("labels and messages use the request's website language, then the default language, then the first value", async () => {
  const options = await setupUnits();
  const label = JSON.stringify([{ LCID: 1033, Value: "Name" }, { LCID: 1036, Value: "Nom" }]);
  assert.equal(formText(label, "", { lcid: 1036, defaultLcid: 1033 }), "Nom");
  assert.equal(formText(label, "", { lcid: 3082, defaultLcid: 1036 }), "Nom");
  assert.equal(formText(label, "", {}), "Name");
  assert.equal(formText("Plain", "", { lcid: 1036 }), "Plain");
  assert.equal(formText("", "Fallback", { lcid: 1036 }), "Fallback");
  options.portal.forms.push({ id: "localized", mode: 100000000 });
  options.schemas.localized = { entity: "contact", fields: options.schemas.create.fields };
  options.portal.records = [{ kind: "basicformmetadata", adx_entityform: "localized", adx_type: 100000000, adx_attributelogicalname: "fullname", adx_label: label }];
  await assert.rejects(
    submitPortalForm("entityform", "localized", { values: { fullname: "" } }, { ...options, language: { lcid: 1036, defaultLcid: 1033 } }),
    (e) => e.code === "FormFieldRequired" && e.message === "Nom is a required field.",
  );
});
