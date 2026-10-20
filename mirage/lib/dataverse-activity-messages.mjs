// Activity, email and queue messages of the simulated Dataverse Web API: AppendRelatedParty and RemoveParent (activities),
// the email messages (send, delivery, templates, tracking, mailbox folders) and the queue messages (queue items, members,
// routing). Registered as extension operations (dataverse-operations.mjs), so the unbound ones also answer over SOAP's
// generic OrganizationRequest dispatch; the bound ones are reached through the Web API routes only.
// No outbound mail: no SMTP, HTTP or DNS traffic. An email "send" moves the row's state only: IssueSend true leaves it
// Pending Send (6), for the email router to pick up with BackgroundSendEmail, and IssueSend false marks it Sent (3).
// Queue membership is the queuemembership intersect table (queue to systemuser), one row per member; a team is expanded to its
// users when it is added. Email attachments are activitymimeattachment rows of the email. Invented data only.
import { randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { parseEntityReference } from "./data.mjs";
import { objectTypeCode } from "./dataverse-metadata.mjs";
import { modelOf } from "./dataverse-misc-messages.mjs";
import { contextUrl, parseDataverseRoute, parsePrefer } from "./dataverse-odata.mjs";
import { ownerColumns, teamsOfUser, uuidV5 } from "./dataverse-security.mjs";
import { standardTableDef } from "./dataverse-standard.mjs";
import { toFetchXml } from "./dataverse-soap-query.mjs";

// Email statuscode values from the standard option set (Draft 1 ... Pending Send 6, Sent 3).
const DRAFT = 1, SENT = 3, RECEIVED = 4, PENDING_SEND = 6;
// activityparty.participationtypemask: "Related" (13) is the party type AppendRelatedParty adds.
const PARTICIPATION_RELATED = 13;
// unverified: live capture (the inner codes; Learn gives none for these messages, so 0x80040203 is the invalid-argument default).
const INVALID = "0x80040203";
const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const EDM_OBJECT = "EdmEntityObject passed should have the key property value set.";
// Columns a caller may not set through QueueItemProperties: the queue item's identity, owner and assignment.
const QUEUE_ITEM_PROTECTED = new Set(["queueitemid", "queueid", "objectid", "objecttypecode", "workerid", "workeridtype", "statecode", "statuscode", "enteredon"]);

const invalid = (message, innerCode = INVALID) => new DataError(message, 400, "InvalidRequest", { innerCode });
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { id, innerCode: "0x80040217" });
const idText = (value) => String(value ?? "").toLowerCase();
const refId = (value) => (value !== null && typeof value === "object" ? value.id : value) ?? null;
const ref = (logical, id) => (id == null ? null : { id, logical_name: logical, name: "" });
const logicalOf = (type) => /^#?Microsoft\.Dynamics\.CRM\.(\w+)$/.exec(String(type ?? ""))?.[1] ?? null;
const stripOrigin = (text) => text.trim().replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?api\/data\/v\d+\.\d+\//i, "");
const isActivity = (mapping) => standardTableDef(mapping.logicalName)?.isActivity === true;

// Arguments: an action's body (JSON, or the SOAP values) and a function's URL parameters, which the router passes as params.
const argsOf = (c) => ({ ...(typeof c.body === "string" ? JSON.parse(c.body || "{}") : (c.body ?? {})), ...(c.params ?? {}) });
const requiredOf = (args, name) => {
  const value = args[name];
  if (value === undefined || value === null || value === "") throw invalid(`The ${name} parameter is required.`);
  return value;
};
const textOf = (args, name) => {
  const value = args[name];
  if (value == null) return null;
  if (typeof value !== "string") throw invalid(`The ${name} parameter must be a string.`);
  return value;
};
const flagOf = (args, name) => {
  const value = requiredOf(args, name);
  if (typeof value !== "boolean") throw invalid(`The ${name} parameter must be a boolean.`);
  return value;
};
const intOf = (args, name) => {
  const raw = args[name];
  if (raw == null) return null;
  const value = raw !== null && typeof raw === "object" && "Value" in raw ? raw.Value : raw;
  if (!Number.isInteger(Number(value))) throw invalid(`The ${name} parameter must be an integer.`);
  return Number(value);
};
const guidOf = (args, name) => {
  const value = String(requiredOf(args, name));
  if (!GUID.test(value)) throw invalid(`The ${name} parameter is not a valid GUID.`);
  return value.replace(/^\{(.*)\}$/, "$1");
};
const dateOf = (args, name) => {
  if (args[name] == null) return null;
  const time = Date.parse(args[name]);
  if (Number.isNaN(time)) throw invalid(`The ${name} parameter is not a valid date.`);
  return new Date(time).toISOString();
};

// Entity reference argument: { "@odata.id": "<set>(<id>)" } as the Web API and SOAP send it, or a typed object with its key column.
function refOf(api, value, name, allowed = null) {
  let mapping;
  let id;
  if (value && typeof value === "object" && value["@odata.id"] !== undefined) {
    const parsed = parseEntityReference(stripOrigin(String(value["@odata.id"])));
    if (!parsed) throw invalid(`The ${name} parameter is not an entity reference.`, "0x80048d19");
    mapping = api.store.resolveMapping(parsed.set);
    id = parsed.id;
  } else if (value && typeof value === "object") {
    const logical = logicalOf(value["@odata.type"]);
    if (!logical) throw invalid(EDM_OBJECT);
    mapping = api.store.resolveMapping(logical);
    id = value[mapping.idColumn];
    if (id == null) throw invalid(EDM_OBJECT);
  } else {
    throw invalid(`The ${name} parameter is not an entity reference.`, "0x80048d19");
  }
  if (allowed && !allowed.has(mapping.logicalName)) throw invalid(`The ${name} parameter must be a ${[...allowed].join(" or ")} record.`);
  return { mapping, id: String(id) };
}

function rowOf(api, ctx, { mapping, id }) {
  const row = api.store.get(mapping.logicalName, id, ctx.identity);
  if (!row) throw notFound(mapping.logicalName, id);
  return row;
}

const authorize = (api, ctx, logical, operation, row = undefined) =>
  api.principals.authorize({ user: ctx.user, entity: logical, operation, row, mapping: api.store.resolveMapping(logical) });
const write = async (api, fn) => api.change(() => api.store.transact(fn, { isolated: true }));
const respond = (ctx, name, body) => ({ status: 200, body: { "@odata.context": contextUrl(ctx.origin, ctx.version, `Microsoft.Dynamics.CRM.${name}Response`), ...body } });
const bodyOf = (name, value, ctx) => ({ "@odata.context": contextUrl(ctx.origin, ctx.version, name), ...value });

// The rows of a table as a Web API GET returns them to the caller (its row privileges, field security and lookup formatting).
// fetchXml, when given, is the query the GET runs (the fetchXml parameter of the collection).
async function listed(api, ctx, logical, fetchXml = null) {
  const { entitySet } = api.store.resolveMapping(logical);
  const path = `/api/data/${ctx.version}/${entitySet}`;
  const url = new URL(`${ctx.origin}${path}`);
  if (fetchXml != null) url.searchParams.set("fetchXml", fetchXml);
  const result = await api.records.handle({
    method: "GET", route: parseDataverseRoute(path), url, origin: ctx.origin, version: ctx.version,
    prefer: parsePrefer(undefined), headers: {}, user: ctx.user, caller: ctx.caller, identity: ctx.identity, requestId: ctx.requestId,
  });
  return result.body?.value ?? [];
}

// One record as the caller reads it, through the same GET.
async function formatted(api, ctx, logical, id) {
  const { entitySet } = api.store.resolveMapping(logical);
  const path = `/api/data/${ctx.version}/${entitySet}(${id})`;
  const result = await api.records.handle({
    method: "GET", route: parseDataverseRoute(path), url: new URL(`${ctx.origin}${path}`), origin: ctx.origin, version: ctx.version,
    prefer: parsePrefer(undefined), headers: {}, user: ctx.user, caller: ctx.caller, identity: ctx.identity, requestId: ctx.requestId,
  });
  return result.body;
}

// Creates one email row owned by the caller and returns its id. Outgoing mail starts as a Draft; the caller sets the state
// that follows. The id is left to the store: an explicit activityid trips the activitypointer lookup in validateBindings.
function newEmail(api, ctx, fields) {
  const owner = ownerColumns(api.store, { id: ctx.user.systemuserid, logical_name: "systemuser" });
  return api.store.createRecord("email", { statecode: 0, statuscode: DRAFT, directioncode: true, ...owner, ...fields }, ctx.identity).activityid;
}

// The state a send writes. There is no transport: a pending send waits for the router, which marks it Sent.
// unverified: live capture (Learn gives no statecode or statuscode for a send; the values are the option set's).
const sendState = (issueSend) => (issueSend ? { statecode: 1, statuscode: PENDING_SEND } : { statecode: 1, statuscode: SENT });

// Placeholders {column} or {table.column}, filled from the record's stored columns; an unknown column stays as written.
// unverified: live capture (the placeholder syntax the template editor writes).
const PLACEHOLDER = /\{(?:([a-z_]+)\.)?([a-z_][a-z0-9_]*)\}/gi;
function fill(text, row, logical) {
  if (typeof text !== "string") return text ?? null;
  return text.replace(PLACEHOLDER, (whole, table, column) => {
    if ((table && table.toLowerCase() !== logical) || !Object.hasOwn(row, column)) return whole;
    const value = row[column];
    return value == null ? "" : typeof value === "object" ? String(value.name ?? value.id ?? "") : String(value);
  });
}

// The template row, which must be for the record's table (templatetypecode names it).
function templateOf(api, ctx, templateId, logical) {
  const template = rowOf(api, ctx, { mapping: api.store.resolveMapping("template"), id: templateId });
  if (template.templatetypecode && logical && String(template.templatetypecode).toLowerCase() !== logical) {
    throw invalid(`The template is not for the ${logical} table.`);
  }
  return template;
}

// Email columns drafted from a template for one record.
function templatedFields(template, regarding) {
  const { mapping, id, row } = regarding;
  return {
    subject: fill(template.subject, row, mapping.logicalName),
    description: fill(template.body, row, mapping.logicalName),
    templateid: ref("template", template.templateid),
    regardingobjectid: ref(mapping.logicalName, id),
  };
}

// The address a record receives mail at: a contact-style address, else a user's internal address.
const addressOf = (row) => row.emailaddress1 ?? row.internalemailaddress ?? row.emailaddress ?? null;

// From must be a user's or a queue's email address (the Learn page: resolvable to a user or queue record).
function senderOf(api, from) {
  const same = (table, column) => api.store.tableRows(table).find((r) => idText(r[column]) === idText(from));
  const user = same("systemuser", "internalemailaddress");
  if (user) return ref("systemuser", user.systemuserid);
  const queue = same("queue", "emailaddress");
  if (queue) return ref("queue", queue.queueid);
  throw invalid("The From parameter must be the email address of a user or queue.");
}

const hashOf = (text) => [...text].reduce((h, ch) => (h * 33 + ch.charCodeAt(0)) >>> 0, 5381);

// Shared by CheckIncomingEmail and CheckPromoteEmail: a message is new unless a stored email carries its MessageId.
// unverified: live capture (ReasonCode values; Learn names the field and gives no values).
async function checkEmail(api, ctx, name, flag) {
  const args = argsOf(ctx);
  const messageId = String(requiredOf(args, "MessageId"));
  if (name === "CheckPromoteEmail") intOf(args, "DirectionCode");
  authorize(api, ctx, "email", "create");
  const duplicate = api.store.tableRows("email").some((row) => idText(row.messageid) === idText(messageId));
  return respond(ctx, name, { ReasonCode: duplicate ? 1 : 0, [flag]: !duplicate });
}

// ---- Activities -------------------------------------------------------------------------------------------------------

// AppendRelatedParty: adds an activityparty row with the Related participation type. The Activity must be an activity table.
async function appendRelatedParty(api, ctx) {
  const args = argsOf(ctx);
  const activity = refOf(api, requiredOf(args, "Activity"), "Activity");
  const party = refOf(api, requiredOf(args, "Party"), "Party");
  if (!isActivity(activity.mapping)) throw invalid(`The Activity parameter must be an activity record, not ${activity.mapping.logicalName}.`);
  authorize(api, ctx, activity.mapping.logicalName, "append", rowOf(api, ctx, activity));
  authorize(api, ctx, party.mapping.logicalName, "appendto", rowOf(api, ctx, party));
  await write(api, () => api.store.createRecord("activityparty", {
    activitypartyid: randomUUID(),
    activityid: ref(activity.mapping.logicalName, activity.id),
    partyid: ref(party.mapping.logicalName, party.id),
    participationtypemask: PARTICIPATION_RELATED,
  }, ctx.identity));
  return { status: 204 };
}

// RemoveParent: clears the systemuser's parent (parentsystemuserid, the manager column).
// unverified: live capture (Learn does not name the column that is cleared).
async function removeParent(api, ctx) {
  const target = refOf(api, requiredOf(argsOf(ctx), "Target"), "Target", new Set(["systemuser"]));
  authorize(api, ctx, "systemuser", "write", rowOf(api, ctx, target));
  await write(api, () => api.store.updateRecord("systemuser", target.id, { parentsystemuserid: null }, ctx.identity));
  return { status: 204 };
}

// ---- Email --------------------------------------------------------------------------------------------------------------

// BackgroundSendEmail: the pending outgoing emails the caller can read. Query null: every visible email. A FetchExpression runs
// its FetchXML, and a QueryExpression on email runs as FetchXML (the async path's conversion). Either way only Pending Send (6)
// rows are returned, and none changes state. HasAttachments says, per returned email, whether it has attachment rows.
// unverified: whether the platform applies the Pending Send filter itself, and whether a sent row moves to Sending (LC-5).
async function backgroundSendEmail(api, ctx) {
  const query = argsOf(ctx).Query;
  if (query != null && typeof query !== "object") throw invalid("The Query parameter must be a QueryBase object.");
  authorize(api, ctx, "email", "read");
  authorize(api, ctx, "email", "write");
  let rows;
  if (query == null) {
    rows = await listed(api, ctx, "email");
  } else if (logicalOf(query["@odata.type"]) === "FetchExpression") {
    const xml = textOf(query, "Query");
    if (!xml) throw invalid("The Query parameter must hold a FetchXML query.");
    rows = await listed(api, ctx, "email", xml);
  } else {
    const model = modelOf(query);
    if (model.entityName.toLowerCase() !== "email") throw invalid("The Query must select the email table.");
    rows = await listed(api, ctx, "email", toFetchXml(model, { primaryIdOf: () => "activityid" }));
  }
  // A QueryBase may project only subject (or field security may hide statuscode).
  // Keep the caller's projection intact and decide eligibility from the stored row.
  const pendingIds = new Set(api.store.tableRows("email")
    .filter((row) => Number(row.statuscode) === PENDING_SEND)
    .map((row) => idText(row.activityid)));
  const pending = rows.filter((row) => pendingIds.has(idText(row.activityid)));
  const attachments = api.store.tableRows("activitymimeattachment");
  return respond(ctx, "BackgroundSendEmail", {
    HasAttachments: pending.map((row) => attachments.some((a) => idText(refId(a.objectid)) === idText(row.activityid))),
    EntityCollection: pending,
  });
}

const checkIncomingEmail = (api, ctx) => checkEmail(api, ctx, "CheckIncomingEmail", "ShouldDeliver");
const checkPromoteEmail = (api, ctx) => checkEmail(api, ctx, "CheckPromoteEmail", "ShouldPromote");

// CreateAndSendNewEmail: creates the email from the arguments and sends it, so it ends Pending Send. Returns its id.
async function createAndSendNewEmail(api, ctx) {
  const args = argsOf(ctx);
  const regarding = args.Regarding == null ? null : refOf(api, args.Regarding, "Regarding");
  const from = textOf(args, "From");
  if (from != null) senderOf(api, from);
  if (regarding) rowOf(api, ctx, regarding);
  authorize(api, ctx, "email", "create");
  let id;
  await write(api, () => {
    id = newEmail(api, ctx, {
      subject: textOf(args, "Subject"), description: textOf(args, "Body"), sender: from, torecipients: textOf(args, "To"),
      cc: textOf(args, "Cc"), bcc: textOf(args, "Bcc"), prioritycode: intOf(args, "Importance"),
      regardingobjectid: regarding ? ref(regarding.mapping.logicalName, regarding.id) : null, ...sendState(true),
    });
  });
  return respond(ctx, "CreateAndSendNewEmail", { EmailId: id });
}

// Attachments of a delivery: a collection of { filename, mimetype, subject, body } objects, body base64. Checked and authorized
// before the write; storeAttachments writes them inside it.
function attachmentsOf(api, ctx, value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((a) => a === null || typeof a !== "object" || (a.body != null && typeof a.body !== "string"))) {
    throw invalid("The Attachments parameter must be a collection of attachment objects.");
  }
  authorize(api, ctx, "activitymimeattachment", "create");
  return value;
}

// One activitymimeattachment row per attachment, numbered in order, with the columns the file upload path stores (dataverse-files.mjs).
function storeAttachments(api, emailId, list) {
  const rows = (api.store.state.tables.activitymimeattachment ??= []);
  list.forEach((a, i) => rows.push({
    activitymimeattachmentid: randomUUID(), objectid: emailId, objecttypecode: "email", activityid: emailId, attachmentnumber: i,
    filename: a.filename ?? null, mimetype: a.mimetype ?? null, subject: a.subject ?? null, body: a.body ?? null,
    filesize: a.body ? Buffer.from(a.body, "base64").length : 0,
  }));
}

// DeliverIncomingEmail (bound to the email collection): creates a received email row from the message parts, with its Attachments.
// unverified: live capture (the refusal when ValidateBeforeCreate finds the MessageId already stored).
async function deliverIncomingEmail(api, ctx) {
  const args = argsOf(ctx);
  const messageId = String(requiredOf(args, "MessageId"));
  const received = dateOf(args, "ReceivedOn");
  const validate = args.ValidateBeforeCreate === true;
  const attachments = attachmentsOf(api, ctx, args.Attachments);
  authorize(api, ctx, "email", "create");
  if (validate && api.store.tableRows("email").some((row) => idText(row.messageid) === idText(messageId))) {
    throw invalid(`An email with MessageId ${messageId} is already stored.`);
  }
  let id;
  await write(api, () => {
    id = newEmail(api, ctx, {
      messageid: messageId, subject: textOf(args, "Subject"), description: textOf(args, "Body"), sender: textOf(args, "From"),
      torecipients: textOf(args, "To"), cc: textOf(args, "Cc"), bcc: textOf(args, "Bcc"), actualstart: received,
      directioncode: false, statecode: 1, statuscode: RECEIVED,
    });
    storeAttachments(api, id, attachments);
  });
  return { status: 200, body: await formatted(api, ctx, "email", id) };
}

// DeliverPromoteEmail and DeliverImmediatePromoteEmail (bound to one email): the bound email takes the message parts and its
// Attachments, and is promoted as received. unverified: live capture (whether the bound row is updated or a new one is created;
// the two variants differ only in Learn's required markings, so they share this handler). ponytail: DeliverImmediatePromoteEmail's
// AttachmentIds, EWSUrl and AttachmentToken are accepted and ignored.
async function deliverPromoteEmail(api, ctx) {
  const args = argsOf(ctx);
  const messageId = String(requiredOf(args, "MessageId"));
  const row = ctx.target.row;
  const attachments = attachmentsOf(api, ctx, args.Attachments);
  authorize(api, ctx, "email", "write", row);
  await write(api, () => {
    api.store.updateRecord("email", ctx.target.id, {
      messageid: messageId, subject: textOf(args, "Subject"), description: textOf(args, "Body"), sender: textOf(args, "From"),
      torecipients: textOf(args, "To"), cc: textOf(args, "Cc"), bcc: textOf(args, "Bcc"), actualstart: dateOf(args, "ReceivedOn"),
      directioncode: false, statecode: 1, statuscode: RECEIVED,
    }, ctx.identity);
    storeAttachments(api, ctx.target.id, attachments);
  });
  return { status: 200, body: await formatted(api, ctx, "email", ctx.target.id) };
}

// GetTrackingTokenEmail: a token for the subject. unverified: live capture (the token format; Learn says only "a string").
async function getTrackingTokenEmail(api, ctx) {
  const subject = textOf(argsOf(ctx), "Subject") ?? "";
  const token = `CRM:${String(hashOf(subject) % 10000).padStart(4, "0")}`;
  return respond(ctx, "GetTrackingTokenEmail", { TrackingToken: token });
}

// InstantiateTemplate: creates a draft email from the template for the record (ObjectType, ObjectId). Returns the collection.
async function instantiateTemplate(api, ctx) {
  const args = argsOf(ctx);
  const templateId = guidOf(args, "TemplateId");
  const logical = String(requiredOf(args, "ObjectType"));
  const regarding = { mapping: api.store.resolveMapping(logical), id: guidOf(args, "ObjectId") };
  regarding.row = rowOf(api, ctx, regarding);
  authorize(api, ctx, regarding.mapping.logicalName, "read", regarding.row);
  const template = templateOf(api, ctx, templateId, regarding.mapping.logicalName);
  authorize(api, ctx, "email", "create");
  let id;
  await write(api, () => { id = newEmail(api, ctx, templatedFields(template, regarding)); });
  const email = await formatted(api, ctx, "email", id);
  return { status: 200, body: bodyOf("Collection(mscrm.crmbaseentity)", { value: [withoutContext(email)] }, ctx) };
}

const withoutContext = (body) => Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => !key.startsWith("@")));

// RetrieveMailboxTrackingFolders: the tracking folder mappings of one mailbox. unverified: live capture (the mapping shape).
async function retrieveMailboxTrackingFolders(api, ctx) {
  const mailboxId = String(requiredOf(argsOf(ctx), "MailboxId"));
  const folders = (await listed(api, ctx, "mailboxtrackingfolder")).filter((row) => idText(row.mailboxid) === idText(mailboxId));
  return respond(ctx, "RetrieveMailboxTrackingFolders", { MailboxTrackingFolderMappings: folders.map(withoutContext) });
}

// SendEmail (bound to one email): IssueSend moves it to Pending Send or to Sent; TrackingToken is stored when given.
async function sendEmail(api, ctx) {
  const args = argsOf(ctx);
  const issueSend = flagOf(args, "IssueSend");
  const trackingToken = textOf(args, "TrackingToken");
  authorize(api, ctx, "email", "write", ctx.target.row);
  await write(api, () => api.store.updateRecord("email", ctx.target.id, {
    ...sendState(issueSend), ...(trackingToken == null ? {} : { trackingtoken: trackingToken }),
  }, ctx.identity));
  return respond(ctx, "SendEmail", { Subject: ctx.target.row.subject ?? null });
}

// SendEmailFromTemplate: a draft from the template for Regarding, addressed to Target, then sent (Pending Send).
async function sendEmailFromTemplate(api, ctx) {
  const args = argsOf(ctx);
  const templateId = guidOf(args, "TemplateId");
  const regardingRef = refOf(api, requiredOf(args, "Regarding"), "Regarding");
  const targetRef = refOf(api, requiredOf(args, "Target"), "Target");
  const regarding = { ...regardingRef, row: rowOf(api, ctx, regardingRef) };
  const target = rowOf(api, ctx, targetRef);
  authorize(api, ctx, regarding.mapping.logicalName, "read", regarding.row);
  authorize(api, ctx, targetRef.mapping.logicalName, "read", target);
  const template = templateOf(api, ctx, templateId, regarding.mapping.logicalName);
  authorize(api, ctx, "email", "create");
  let id;
  await write(api, () => { id = newEmail(api, ctx, { ...templatedFields(template, regarding), torecipients: addressOf(target), ...sendState(true) }); });
  return { status: 200, body: await formatted(api, ctx, "email", id) };
}

// SendFax: marks the fax Sent. ponytail: there is no fax transport, so IssueSend is validated and both values record Sent.
async function sendFax(api, ctx) {
  const args = argsOf(ctx);
  const faxId = guidOf(args, "FaxId");
  flagOf(args, "IssueSend");
  const fax = { mapping: api.store.resolveMapping("fax"), id: faxId };
  authorize(api, ctx, "fax", "write", rowOf(api, ctx, fax));
  await write(api, () => api.store.updateRecord("fax", faxId, { statecode: 1, statuscode: SENT }, ctx.identity));
  return { status: 204 };
}

// SendTemplate: one Pending Send draft per recipient, from the template, for Regarding, from Sender.
async function sendTemplate(api, ctx) {
  const args = argsOf(ctx);
  const templateId = guidOf(args, "TemplateId");
  const sender = refOf(api, requiredOf(args, "Sender"), "Sender");
  const regardingRef = refOf(api, requiredOf(args, "Regarding"), "Regarding");
  const recipients = requiredOf(args, "Recipients");
  if (!Array.isArray(recipients) || recipients.length === 0) throw invalid("The Recipients parameter must be a non-empty collection.");
  const regarding = { ...regardingRef, row: rowOf(api, ctx, regardingRef) };
  const targets = recipients.map((item) => {
    const to = refOf(api, item, "Recipients");
    return { row: rowOf(api, ctx, to) };
  });
  const senderRow = rowOf(api, ctx, sender);
  authorize(api, ctx, regarding.mapping.logicalName, "read", regarding.row);
  const template = templateOf(api, ctx, templateId, regarding.mapping.logicalName);
  authorize(api, ctx, "email", "create");
  const priority = intOf(args, "DeliveryPriorityCode");
  await write(api, () => {
    for (const { row } of targets) {
      newEmail(api, ctx, {
        ...templatedFields(template, regarding), torecipients: addressOf(row), sender: addressOf(senderRow), prioritycode: priority, ...sendState(true),
      });
    }
  });
  return { status: 204 };
}

// ---- Queues -------------------------------------------------------------------------------------------------------------

// The queuemembership intersect table (queue to systemuser), read through the queue's queuemembership_association navigation.
// Insert-only, as the other dataverse-only stand-in tables are (dataverse-duplicates.mjs seedTables).
function seedQueueMembership(store) {
  store.state.mappings.queuemembership ??= {
    logicalName: "queuemembership", entitySet: "queuememberships", idColumn: "queuemembershipid", userConfigured: true, dataverseOnly: true,
    fields: {
      queuemembershipid: { dataverseType: "uniqueidentifier" }, queueid: { dataverseType: "uniqueidentifier" },
      systemuserid: { dataverseType: "uniqueidentifier" },
    },
    relationships: {},
  };
  store.state.tables.queuemembership ??= [];
}

// AddPrincipalToQueue (bound to one queue): adds a systemuser as a member, or each user of a team, once per user.
// ponytail: a user who joins the team after this call is not added.
async function addPrincipalToQueue(api, ctx) {
  const principal = refOf(api, requiredOf(argsOf(ctx), "Principal"), "Principal", new Set(["systemuser", "team"]));
  rowOf(api, ctx, principal);
  authorize(api, ctx, "queue", "write", ctx.target.row);
  const users = principal.mapping.logicalName === "team"
    ? api.store.tableRows("systemuser").filter((u) => teamsOfUser(api.store, u.systemuserid).includes(idText(principal.id))).map((u) => u.systemuserid)
    : [principal.id];
  await write(api, () => {
    const members = api.store.state.tables.queuemembership;
    for (const id of users) {
      const exists = members.some((m) => idText(refId(m.queueid)) === idText(ctx.target.id) && idText(refId(m.systemuserid)) === idText(id));
      if (!exists) members.push({ queuemembershipid: uuidV5(ctx.target.id, `member:${idText(id)}`), queueid: ctx.target.id, systemuserid: id });
    }
  });
  return { status: 204 };
}

// AddToQueue (bound to the destination queue): creates a queue item for Target, after removing it from SourceQueue when given.
async function addToQueue(api, ctx) {
  const args = argsOf(ctx);
  const target = refOf(api, requiredOf(args, "Target"), "Target");
  const targetRow = rowOf(api, ctx, target);
  const source = args.SourceQueue == null ? null : refOf(api, args.SourceQueue, "SourceQueue", new Set(["queue"]));
  const props = args.QueueItemProperties ?? {};
  if (typeof props !== "object" || Array.isArray(props)) throw invalid("The QueueItemProperties parameter must be a queueitem object.");
  const fields = api.store.resolveMapping("queueitem").fields ?? {};
  const extra = Object.fromEntries(Object.entries(props).filter(([name]) => fields[name] && !QUEUE_ITEM_PROTECTED.has(name)));
  authorize(api, ctx, target.mapping.logicalName, "read", targetRow);
  authorize(api, ctx, "queueitem", "create");
  const id = randomUUID();
  const now = new Date(api.clock ? api.clock() : Date.now()).toISOString();
  await write(api, () => {
    if (source) {
      const moved = api.store.tableRows("queueitem")
        .filter((item) => idText(refId(item.queueid)) === idText(source.id) && idText(refId(item.objectid)) === idText(target.id));
      for (const item of moved) api.store.removeRecord("queueitem", item.queueitemid, ctx.identity);
    }
    api.store.createRecord("queueitem", {
      queueitemid: id, queueid: ref("queue", ctx.target.id), objectid: ref(target.mapping.logicalName, target.id),
      objecttypecode: objectTypeCode(target.mapping.logicalName), title: targetRow[target.mapping.nameColumn] ?? target.id,
      enteredon: now, statecode: 0, ...extra,
    }, ctx.identity);
  });
  return respond(ctx, "AddToQueue", { QueueItemId: id });
}

// PickFromQueue (bound to one queue item): assigns it to SystemUser, or removes it from the queue when RemoveQueueItem is true.
async function pickFromQueue(api, ctx) {
  const args = argsOf(ctx);
  const user = refOf(api, requiredOf(args, "SystemUser"), "SystemUser", new Set(["systemuser"]));
  const remove = flagOf(args, "RemoveQueueItem");
  rowOf(api, ctx, user);
  authorize(api, ctx, "queueitem", "write", ctx.target.row);
  await write(api, () => {
    if (remove) api.store.removeRecord("queueitem", ctx.target.id, ctx.identity);
    else api.store.updateRecord("queueitem", ctx.target.id, { workerid: ref("systemuser", user.id), workeridtype: "systemuser" }, ctx.identity);
  });
  return { status: 204 };
}

// ReleaseToQueue (bound to one queue item): clears the worker, so any member can pick it.
async function releaseToQueue(api, ctx) {
  authorize(api, ctx, "queueitem", "write", ctx.target.row);
  await write(api, () => api.store.updateRecord("queueitem", ctx.target.id, { workerid: null, workeridtype: null }, ctx.identity));
  return { status: 204 };
}

// RemoveFromQueue (bound to one queue item): deletes the queue item.
async function removeFromQueue(api, ctx) {
  authorize(api, ctx, "queueitem", "delete", ctx.target.row);
  await write(api, () => api.store.removeRecord("queueitem", ctx.target.id, ctx.identity));
  return { status: 204 };
}

// RetrieveUserQueues (bound to one systemuser): the queues the user owns or is a member of (private: owned by a user),
// and with IncludePublic the queues owned by a team or business unit (public). Rows come back as the caller reads them.
// unverified: live capture (which owners make a queue public).
async function retrieveUserQueues(api, ctx) {
  const includePublic = flagOf(argsOf(ctx), "IncludePublic");
  const userId = ctx.target.id;
  const memberOf = new Set(api.store.tableRows("queuemembership")
    .filter((m) => idText(refId(m.systemuserid)) === idText(userId))
    .map((m) => idText(refId(m.queueid))));
  const queues = api.store.tableRows("queue");
  const ids = new Set(queues.filter((q) => {
    const owner = q.ownerid?.logical_name ?? null;
    const owned = idText(refId(q.ownerid)) === idText(userId);
    if (owned || memberOf.has(idText(q.queueid))) return true;
    return includePublic && owner !== "systemuser";
  }).map((q) => idText(q.queueid)));
  const value = (await listed(api, ctx, "queue")).filter((row) => ids.has(idText(row.queueid)));
  return respond(ctx, "RetrieveUserQueues", { value: value.map(withoutContext) });
}

// RouteTo: routes a queue item to a queue (unassigned) or to a systemuser or team (assigned to it).
// unverified: live capture (QueueItem is required here; Learn does not say what a null QueueItem does).
async function routeTo(api, ctx) {
  const args = argsOf(ctx);
  const target = refOf(api, requiredOf(args, "Target"), "Target", new Set(["queue", "systemuser", "team"]));
  const item = refOf(api, requiredOf(args, "QueueItem"), "QueueItem", new Set(["queueitem"]));
  rowOf(api, ctx, target);
  authorize(api, ctx, "queueitem", "write", rowOf(api, ctx, item));
  await write(api, () => {
    const fields = target.mapping.logicalName === "queue"
      ? { queueid: ref("queue", target.id), workerid: null, workeridtype: null }
      : { workerid: ref(target.mapping.logicalName, target.id), workeridtype: target.mapping.logicalName };
    api.store.updateRecord("queueitem", item.id, fields, ctx.identity);
  });
  return { status: 204 };
}

// ---- Registration ---------------------------------------------------------------------------------------------------------

// CSDL per operation: the bound parameter (entity, or the full collection type), parameters and return type. A response is a ComplexType.
function csdlOf(kind, name, { bound = null, params = [], returns = null, response = null }) {
  const tag = kind === "action" ? "Action" : "Function";
  const complex = response ? `<ComplexType Name="${name}Response">${response.map(([p, t]) => `<Property Name="${p}" Type="${t}" />`).join("")}</ComplexType>` : null;
  const parts = bound ? [`<Parameter Name="entity" Type="${bound.includes("(") ? bound : `mscrm.${bound}`}" Nullable="false" />`] : [];
  for (const [param, type] of params) parts.push(`<Parameter Name="${param}" Type="${type}" />`);
  if (response) returns = `mscrm.${name}Response`;
  if (returns) parts.push(`<ReturnType Type="${returns}" Nullable="false" />`);
  const head = `<${tag} Name="${name}"${bound ? ' IsBound="true"' : ""}>`;
  return [complex, `${head}\n  ${parts.join("\n  ")}\n</${tag}>`].filter(Boolean).join("\n");
}

// name, kind, binding (unbound, entity or collection), entity for the bound ones, handler, CSDL.
const OPERATIONS = [
  { name: "AppendRelatedParty", kind: "action", handle: appendRelatedParty, csdl: { params: [["Activity", "mscrm.crmbaseentity"], ["Party", "mscrm.crmbaseentity"]] } },
  { name: "RemoveParent", kind: "action", handle: removeParent, csdl: { params: [["Target", "mscrm.crmbaseentity"]] } },
  // unverified: the native Query is mscrm.QueryBase and Attachments is Collection(mscrm.attachment); neither complex type is declared here, so Edm.Untyped stands in (as misc-messages does for QueryExpression).
  { name: "BackgroundSendEmail", kind: "action", handle: backgroundSendEmail, csdl: { params: [["Query", "Edm.Untyped"]], response: [["HasAttachments", "Collection(Edm.Boolean)"], ["EntityCollection", "Collection(mscrm.email)"]] } },
  { name: "CheckIncomingEmail", kind: "function", handle: checkIncomingEmail, csdl: { params: [["MessageId", "Edm.String"], ["Subject", "Edm.String"], ["From", "Edm.String"], ["To", "Edm.String"], ["Cc", "Edm.String"], ["Bcc", "Edm.String"]], response: [["ReasonCode", "Edm.Int32"], ["ShouldDeliver", "Edm.Boolean"]] } },
  { name: "CheckPromoteEmail", kind: "function", handle: checkPromoteEmail, csdl: { params: [["MessageId", "Edm.String"], ["Subject", "Edm.String"], ["DirectionCode", "Edm.Int32"]], response: [["ReasonCode", "Edm.Int32"], ["ShouldPromote", "Edm.Boolean"]] } },
  { name: "CreateAndSendNewEmail", kind: "action", handle: createAndSendNewEmail, csdl: { params: [["Subject", "Edm.String"], ["Body", "Edm.String"], ["From", "Edm.String"], ["To", "Edm.String"], ["Cc", "Edm.String"], ["Bcc", "Edm.String"], ["Regarding", "mscrm.crmbaseentity"], ["Importance", "Edm.Int32"]], response: [["EmailId", "Edm.Guid"]] } },
  { name: "DeliverIncomingEmail", kind: "action", binding: "collection", entity: "email", handle: deliverIncomingEmail, csdl: { bound: "Collection(mscrm.email)", params: [["MessageId", "Edm.String"], ["From", "Edm.String"], ["To", "Edm.String"], ["Cc", "Edm.String"], ["Bcc", "Edm.String"], ["SubmittedBy", "Edm.String"], ["Importance", "Edm.String"], ["Body", "Edm.String"], ["Subject", "Edm.String"], ["ReceivedOn", "Edm.DateTimeOffset"], ["ValidateBeforeCreate", "Edm.Boolean"], ["Attachments", "Collection(Edm.Untyped)"], ["ExtraProperties", "mscrm.crmbaseentity"]], returns: "mscrm.email" } },
  { name: "DeliverPromoteEmail", kind: "action", binding: "entity", entity: "email", handle: deliverPromoteEmail, csdl: { bound: "email", params: [["MessageId", "Edm.String"], ["From", "Edm.String"], ["To", "Edm.String"], ["Cc", "Edm.String"], ["Bcc", "Edm.String"], ["SubmittedBy", "Edm.String"], ["Importance", "Edm.String"], ["Body", "Edm.String"], ["Subject", "Edm.String"], ["ReceivedOn", "Edm.DateTimeOffset"], ["Attachments", "Collection(Edm.Untyped)"], ["ExtraProperties", "mscrm.crmbaseentity"]], returns: "mscrm.email" } },
  { name: "DeliverImmediatePromoteEmail", kind: "action", binding: "entity", entity: "email", handle: deliverPromoteEmail, csdl: { bound: "email", params: [["MessageId", "Edm.String"], ["From", "Edm.String"], ["To", "Edm.String"], ["Cc", "Edm.String"], ["Bcc", "Edm.String"], ["SubmittedBy", "Edm.String"], ["Importance", "Edm.String"], ["Body", "Edm.String"], ["Subject", "Edm.String"], ["ReceivedOn", "Edm.DateTimeOffset"]], returns: "mscrm.email" } },
  { name: "GetTrackingTokenEmail", kind: "action", handle: getTrackingTokenEmail, csdl: { params: [["Subject", "Edm.String"]], response: [["TrackingToken", "Edm.String"]] } },
  { name: "InstantiateTemplate", kind: "action", handle: instantiateTemplate, csdl: { params: [["TemplateId", "Edm.Guid"], ["ObjectType", "Edm.String"], ["ObjectId", "Edm.Guid"]], returns: "Collection(mscrm.crmbaseentity)" } },
  { name: "RetrieveMailboxTrackingFolders", kind: "function", handle: retrieveMailboxTrackingFolders, csdl: { params: [["MailboxId", "Edm.String"]], response: [["MailboxTrackingFolderMappings", "Collection(mscrm.mailboxtrackingfolder)"]] } },
  { name: "SendEmail", kind: "action", binding: "entity", entity: "email", handle: sendEmail, csdl: { bound: "email", params: [["IssueSend", "Edm.Boolean"], ["TrackingToken", "Edm.String"]], response: [["Subject", "Edm.String"]] } },
  { name: "SendEmailFromTemplate", kind: "action", handle: sendEmailFromTemplate, csdl: { params: [["TemplateId", "Edm.Guid"], ["Regarding", "mscrm.crmbaseentity"], ["Target", "mscrm.crmbaseentity"]], returns: "mscrm.email" } },
  { name: "SendFax", kind: "action", handle: sendFax, csdl: { params: [["FaxId", "Edm.Guid"], ["IssueSend", "Edm.Boolean"]] } },
  { name: "SendTemplate", kind: "action", handle: sendTemplate, csdl: { params: [["TemplateId", "Edm.Guid"], ["Sender", "mscrm.crmbaseentity"], ["Recipients", "Collection(mscrm.crmbaseentity)"], ["Regarding", "mscrm.crmbaseentity"], ["DeliveryPriorityCode", "Edm.Int32"]] } },
  { name: "AddPrincipalToQueue", kind: "action", binding: "entity", entity: "queue", handle: addPrincipalToQueue, csdl: { bound: "queue", params: [["Principal", "mscrm.crmbaseentity"]] } },
  { name: "AddToQueue", kind: "action", binding: "entity", entity: "queue", handle: addToQueue, csdl: { bound: "queue", params: [["Target", "mscrm.crmbaseentity"], ["SourceQueue", "mscrm.queue"], ["QueueItemProperties", "mscrm.queueitem"]], response: [["QueueItemId", "Edm.Guid"]] } },
  { name: "PickFromQueue", kind: "action", binding: "entity", entity: "queueitem", handle: pickFromQueue, csdl: { bound: "queueitem", params: [["SystemUser", "mscrm.systemuser"], ["RemoveQueueItem", "Edm.Boolean"]] } },
  { name: "ReleaseToQueue", kind: "action", binding: "entity", entity: "queueitem", handle: releaseToQueue, csdl: { bound: "queueitem" } },
  { name: "RemoveFromQueue", kind: "action", binding: "entity", entity: "queueitem", handle: removeFromQueue, csdl: { bound: "queueitem" } },
  { name: "RetrieveUserQueues", kind: "function", binding: "entity", entity: "systemuser", handle: retrieveUserQueues, csdl: { bound: "systemuser", params: [["IncludePublic", "Edm.Boolean"]], returns: "Collection(mscrm.queue)" } },
  { name: "RouteTo", kind: "action", handle: routeTo, csdl: { params: [["Target", "mscrm.crmbaseentity"], ["QueueItem", "mscrm.queueitem"]] } },
];

export function install(api) {
  api.store.transact(() => seedQueueMembership(api.store));
  for (const op of OPERATIONS) {
    const { csdl, handle, binding = "unbound", entity, name, kind } = op;
    api.registry.register({
      name,
      kind,
      binding,
      ...(binding === "unbound" ? {} : { entity }),
      handle: (c) => handle(api, c),
      csdl: csdlOf(kind, name, csdl),
    });
  }
}

// reset runs on every reseed inside the change queue, so it writes through the store only.
export function reset(api) {
  return api.store.transact(() => seedQueueMembership(api.store));
}

export const EXTENSION = { name: "activity-messages", install, reset };
