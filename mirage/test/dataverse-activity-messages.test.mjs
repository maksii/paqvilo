// Activity, email and queue messages (dataverse-activity-messages.mjs) through the full Dataverse API: the Web API routes,
// the Basic User privilege denial and one SOAP call through the generic OrganizationRequest dispatch.
// Each message has a happy path (its effect read back from the store) and one refused call.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { hashSecret } from "../lib/dataverse-auth.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";
import { NS } from "../lib/dataverse-soap-xml.mjs";

const APP_ID = "22222222-2222-2222-2222-222222222222";
const PUBLIC_APP_ID = "44444444-4444-4444-4444-444444444444";
const REDIRECT = "http://localhost:1/cb";
const SECRET_VAR = "PAQVILO_ACTIVITY_MESSAGES_SECRET";
const PASSWORD = "Pass!23";
const BASIC_OID = "66666666-6666-6666-6666-666666666666";
const BASIC_DOMAIN = "basic@example.test";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const API = "/api/data/v9.2/";
const SOAP_PATH = "/XRMServices/2011/Organization.svc/web";
const DECL = Object.entries(NS).map(([p, uri]) => `xmlns:${p}="${uri}"`).join(" ");
const PENDING = 6;
const RECEIVED = 4;

const idIn = (response) => /\(([0-9a-f-]{36})\)/i.exec(response.headers.get("OData-EntityId") ?? "")?.[1];
const ref = (set, id) => ({ "@odata.id": `${set}(${id})` });

describe("activity, email and queue messages", () => {
  let api, store, origin, appToken, basicToken;
  let basicId, appUserId, accountId, queueId, emailId, pendingEmailId, faxId, templateId, queueItemId;

  async function userToken(username) {
    const response = await fetch(`${origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: PUBLIC_APP_ID, username, password: PASSWORD, scope: `${origin}/.default` }),
    });
    return (await response.json()).access_token;
  }

  async function clientToken() {
    const response = await fetch(`${origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${origin}/.default` }),
    });
    return (await response.json()).access_token;
  }

  async function request(method, path, token, body) {
    const response = await fetch(`${origin}${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, text, json, headers: response.headers };
  }
  // Unbound action (POST), bound action or function on a path, as the admin application unless a token is given.
  const act = (path, body, token = appToken) => request("POST", path, token, body);
  const fn = (path, token = appToken) => request("GET", path, token);
  const rows = (logical) => store.tableRows(logical);
  const rowOf = (logical, column, id) => rows(logical).find((r) => String(r[column]).toLowerCase() === String(id).toLowerCase());
  const refIdOf = (value) => (value && typeof value === "object" ? value.id : value);
  const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  const refused = (response, status, text) => {
    assert.equal(response.status, status, response.text);
    if (text) assert.match(response.text, text);
  };
  const draft = async (subject) => idIn(await act("emails", { subject, description: "Draft body" }));
  const queueItem = async () => (await act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddToQueue`, { Target: ref("accounts", accountId) })).json.QueueItemId;

  before(async () => {
    process.env[SECRET_VAR] = "activity-messages-secret";
    store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        { appId: APP_ID, displayName: "Activity app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] },
        { appId: PUBLIC_APP_ID, displayName: "Public app", publicClient: true, redirectUris: [REDIRECT] },
      ],
      users: [{ domainname: BASIC_DOMAIN, fullname: "Basic", objectId: BASIC_OID, roles: ["Basic User"] }],
    });
    api = await startDataverseApi({ store, settings, log: () => {} });
    origin = api.origin;
    basicId = uuidV5(api.organizationId, `systemuser:oid:${BASIC_OID}`);
    appUserId = uuidV5(api.organizationId, `systemuser:app:${APP_ID}`);
    await store.transact(() => {
      store.state.dataverse.passwords ??= {};
      store.state.dataverse.passwords[basicId] = hashSecret(PASSWORD);
      // The Basic user reports to the application user, so RemoveParent has a parent to clear.
      store.updateRecord("systemuser", basicId, { parentsystemuserid: { id: appUserId, logical_name: "systemuser", name: "" } }, { admin: true });
    });
    appToken = await clientToken();
    basicToken = await userToken(BASIC_DOMAIN);

    // Records the messages act on. The pending email and the queue item are made through the messages tested below, so
    // each test that reads them starts from the same state whatever runs first.
    accountId = idIn(await act("accounts", { name: "Contoso Ltd", emailaddress1: "ops@contoso.test" }));
    queueId = idIn(await act("queues", { name: "Contoso Support" }));
    emailId = await draft("Quarterly figures");
    pendingEmailId = await draft("Pending one");
    assert.equal((await act(`emails(${pendingEmailId})/Microsoft.Dynamics.CRM.SendEmail`, { IssueSend: true })).status, 200);
    faxId = idIn(await act("faxes", { subject: "Invoice fax" }));
    templateId = idIn(await act("templates", {
      title: "Welcome", subject: "Welcome {name}", body: "Dear {account.name}, thanks.", templatetypecode: "account",
    }));
    queueItemId = await queueItem();
    for (const id of [accountId, queueId, emailId, pendingEmailId, faxId, templateId, queueItemId]) assert.ok(id, "fixture record created");
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  // ---- Activities

  it("lists every message in $metadata", async () => {
    const metadata = await request("GET", "$metadata", appToken);
    assert.equal(metadata.status, 200);
    for (const name of ["AppendRelatedParty", "RemoveParent", "SendEmail", "CheckIncomingEmail", "RetrieveUserQueues", "RouteTo"]) {
      assert.match(metadata.text, new RegExp(`Name="${name}"`));
    }
  });

  it("AppendRelatedParty adds a Related activity party", async () => {
    const response = await act("AppendRelatedParty", { Activity: ref("emails", emailId), Party: ref("accounts", accountId) });
    assert.equal(response.status, 204, response.text);
    const party = rows("activityparty").find((r) => refIdOf(r.activityid) === emailId);
    assert.equal(party.participationtypemask, 13);
    assert.equal(refIdOf(party.partyid), accountId);
  });

  it("RemoveParent clears the systemuser's parent", async () => {
    const response = await act("RemoveParent", { Target: ref("systemusers", basicId) });
    assert.equal(response.status, 204, response.text);
    assert.equal(rowOf("systemuser", "systemuserid", basicId).parentsystemuserid, null);
  });

  // ---- Email

  it("SendEmail moves a draft to Pending Send and then answers with its subject", async () => {
    const id = await draft("Draft to send");
    const response = await act(`emails(${id})/Microsoft.Dynamics.CRM.SendEmail`, { IssueSend: true, TrackingToken: "CRM:1234" });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.Subject, "Draft to send");
    const row = rowOf("email", "activityid", id);
    assert.equal(row.statuscode, PENDING);
    assert.equal(row.trackingtoken, "CRM:1234");
  });

  it("BackgroundSendEmail returns the pending emails and changes none", async () => {
    const response = await act("BackgroundSendEmail", { Query: null });
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json.EntityCollection.some((row) => row.activityid === pendingEmailId));
    assert.ok(!response.json.EntityCollection.some((row) => row.activityid === emailId), "a draft is not pending");
    assert.equal(rowOf("email", "activityid", pendingEmailId).statuscode, PENDING);
  });

  it("BackgroundSendEmail runs a QueryExpression on email and returns only the matching pending emails", async () => {
    const response = await act("BackgroundSendEmail", {
      Query: {
        "@odata.type": "Microsoft.Dynamics.CRM.QueryExpression", EntityName: "email", ColumnSet: { AllColumns: true },
        Criteria: { FilterOperator: "Or", Conditions: [
          { AttributeName: "subject", Operator: "Equal", Values: ["Pending one"] },
          { AttributeName: "subject", Operator: "Equal", Values: ["Quarterly figures"] },
        ] },
      },
    });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.EntityCollection.map((row) => row.activityid), [pendingEmailId]);
  });

  it("BackgroundSendEmail filters stored status without adding it to a QueryExpression projection", async () => {
    const response = await act("BackgroundSendEmail", {
      Query: {
        "@odata.type": "Microsoft.Dynamics.CRM.QueryExpression", EntityName: "email", ColumnSet: { Columns: ["subject"] },
        Criteria: { FilterOperator: "Or", Conditions: [
          { AttributeName: "subject", Operator: "Equal", Values: ["Pending one"] },
          { AttributeName: "subject", Operator: "Equal", Values: ["Quarterly figures"] },
        ] },
      },
    });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.EntityCollection.map((row) => row.activityid), [pendingEmailId]);
    assert.equal(response.json.EntityCollection[0].subject, "Pending one");
    assert.equal(Object.hasOwn(response.json.EntityCollection[0], "statuscode"), false);
    assert.equal(rowOf("email", "activityid", pendingEmailId).statuscode, PENDING);
  });

  it("BackgroundSendEmail honours a FetchExpression projection that omits statuscode", async () => {
    const response = await act("BackgroundSendEmail", {
      Query: {
        "@odata.type": "Microsoft.Dynamics.CRM.FetchExpression",
        Query: '<fetch><entity name="email"><attribute name="subject"/><filter type="or"><condition attribute="subject" operator="eq" value="Pending one"/><condition attribute="subject" operator="eq" value="Quarterly figures"/></filter></entity></fetch>',
      },
    });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.EntityCollection.map((row) => row.activityid), [pendingEmailId]);
    assert.equal(Object.hasOwn(response.json.EntityCollection[0], "statuscode"), false);
    assert.deepEqual(response.json.HasAttachments, [false]);
  });

  it("CheckIncomingEmail reports a new message as deliverable", async () => {
    const response = await fn("CheckIncomingEmail(MessageId='msg-new')");
    assert.equal(response.status, 200, response.text);
    assert.deepEqual([response.json.ShouldDeliver, response.json.ReasonCode], [true, 0]);
  });

  it("DeliverIncomingEmail creates a received email, and CheckIncomingEmail then sees it", async () => {
    const response = await act("emails/Microsoft.Dynamics.CRM.DeliverIncomingEmail", {
      MessageId: "msg-1", From: "pat@fabrikam.test", To: "ops@contoso.test", Cc: "", Bcc: "", SubmittedBy: "pat@fabrikam.test",
      Importance: "1", Body: "Received body", Subject: "Incoming", ReceivedOn: "2026-10-19T10:00:00Z", ValidateBeforeCreate: true,
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.subject, "Incoming");
    assert.equal(rows("email").find((r) => r.messageid === "msg-1").statuscode, RECEIVED);
    const check = await fn("CheckIncomingEmail(MessageId='msg-1')");
    assert.equal(check.json.ShouldDeliver, false);
  });

  it("DeliverIncomingEmail stores its Attachments as activitymimeattachment rows of the email, and BackgroundSendEmail reports them", async () => {
    const response = await act("emails/Microsoft.Dynamics.CRM.DeliverIncomingEmail", {
      MessageId: "msg-att", From: "pat@fabrikam.test", To: "ops@contoso.test", Subject: "With files", Body: "See attached",
      ReceivedOn: "2026-10-19T11:00:00Z",
      Attachments: [
        { filename: "a.txt", mimetype: "text/plain", subject: "A", body: Buffer.from("hello").toString("base64") },
        { filename: "b.bin", mimetype: "application/octet-stream", body: null },
      ],
    });
    assert.equal(response.status, 200, response.text);
    const id = response.json.activityid;
    const attached = rows("activitymimeattachment").filter((a) => same(refIdOf(a.objectid), id)).sort((x, y) => x.attachmentnumber - y.attachmentnumber);
    assert.deepEqual(attached.map((a) => [a.attachmentnumber, a.filename, a.filesize]), [[0, "a.txt", 5], [1, "b.bin", 0]]);
    // A received email is sent by SendEmail, which leaves it Pending Send for the router.
    assert.equal((await act(`emails(${id})/Microsoft.Dynamics.CRM.SendEmail`, { IssueSend: true })).status, 200);
    const pending = await act("BackgroundSendEmail", { Query: null });
    const index = pending.json.EntityCollection.findIndex((row) => same(row.activityid, id));
    assert.ok(index >= 0, "the sent email is returned");
    assert.equal(pending.json.HasAttachments[index], true);
    assert.equal(pending.json.HasAttachments[pending.json.EntityCollection.findIndex((row) => same(row.activityid, pendingEmailId))], false);
  });

  it("CheckPromoteEmail reports a new message as promotable", async () => {
    const response = await fn("CheckPromoteEmail(MessageId='msg-2',DirectionCode=1)");
    assert.equal(response.status, 200, response.text);
    assert.deepEqual([response.json.ShouldPromote, response.json.ReasonCode], [true, 0]);
  });

  for (const [message, messageId] of [["DeliverPromoteEmail", "msg-3"], ["DeliverImmediatePromoteEmail", "msg-4"]]) {
    it(`${message} promotes the bound email as received`, async () => {
      const id = await draft(`To promote through ${message}`);
      const response = await act(`emails(${id})/Microsoft.Dynamics.CRM.${message}`, {
        MessageId: messageId, From: "pat@fabrikam.test", To: "ops@contoso.test", Body: "Promoted", Subject: "Promoted one",
      });
      assert.equal(response.status, 200, response.text);
      const row = rowOf("email", "activityid", id);
      assert.deepEqual([row.messageid, row.subject, row.statuscode], [messageId, "Promoted one", RECEIVED]);
    });
  }

  it("CreateAndSendNewEmail creates the email and leaves it Pending Send", async () => {
    const response = await act("CreateAndSendNewEmail", { Subject: "Hello", Body: "Hi there", To: "ops@contoso.test", Importance: 1 });
    assert.equal(response.status, 200, response.text);
    const row = rowOf("email", "activityid", response.json.EmailId);
    assert.deepEqual([row.subject, row.statuscode, row.statecode], ["Hello", PENDING, 1]);
  });

  it("GetTrackingTokenEmail answers the same CRM tracking token for the same subject", async () => {
    const token = async (Subject) => {
      const response = await act("GetTrackingTokenEmail", { Subject });
      assert.equal(response.status, 200, response.text);
      return response.json.TrackingToken;
    };
    const first = await token("Quarterly figures");
    assert.match(first, /^CRM:\d{4}$/);
    assert.equal(await token("Quarterly figures"), first);
  });

  it("InstantiateTemplate drafts an email for the record, filling the placeholders", async () => {
    const response = await act("InstantiateTemplate", { TemplateId: templateId, ObjectType: "account", ObjectId: accountId });
    assert.equal(response.status, 200, response.text);
    const [draftEmail] = response.json.value;
    assert.equal(draftEmail.subject, "Welcome Contoso Ltd");
    assert.equal(draftEmail.description, "Dear Contoso Ltd, thanks.");
    assert.equal(draftEmail.statuscode, 1);
  });

  it("RetrieveMailboxTrackingFolders answers the mappings of a mailbox", async () => {
    const response = await fn("RetrieveMailboxTrackingFolders(MailboxId='mbx-1')");
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.MailboxTrackingFolderMappings, []);
  });

  it("SendEmailFromTemplate drafts an email to the target's address and leaves it Pending Send", async () => {
    const response = await act("SendEmailFromTemplate", { TemplateId: templateId, Regarding: ref("accounts", accountId), Target: ref("accounts", accountId) });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.torecipients, "ops@contoso.test");
    assert.equal(response.json.statuscode, PENDING);
  });

  it("SendFax marks the fax Sent", async () => {
    const response = await act("SendFax", { FaxId: faxId, IssueSend: true });
    assert.equal(response.status, 204, response.text);
    assert.equal(rowOf("fax", "activityid", faxId).statuscode, 3);
  });

  it("SendTemplate drafts one Pending Send email per recipient", async () => {
    const before = rows("email").length;
    const response = await act("SendTemplate", {
      TemplateId: templateId, Sender: ref("systemusers", appUserId), Recipients: [ref("accounts", accountId)], Regarding: ref("accounts", accountId), DeliveryPriorityCode: 2,
    });
    assert.equal(response.status, 204, response.text);
    assert.equal(rows("email").length, before + 1);
    assert.deepEqual([rows("email").at(-1).torecipients, rows("email").at(-1).statuscode], ["ops@contoso.test", PENDING]);
  });

  // ---- Queues

  it("AddToQueue creates a queue item for the record, with the given title", async () => {
    const response = await act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddToQueue`, {
      Target: ref("accounts", accountId), QueueItemProperties: { title: "Renewal call" },
    });
    assert.equal(response.status, 200, response.text);
    const item = rowOf("queueitem", "queueitemid", response.json.QueueItemId);
    assert.equal(refIdOf(item.queueid), queueId);
    assert.equal(refIdOf(item.objectid), accountId);
    assert.equal(item.title, "Renewal call");
  });

  it("AddPrincipalToQueue adds a systemuser as a queuemembership row that RetrieveUserQueues and $expand then report", async () => {
    const memberQueue = idIn(await act("queues", { name: "Contoso Member Queue" }));
    const response = await act(`queues(${memberQueue})/Microsoft.Dynamics.CRM.AddPrincipalToQueue`, { Principal: ref("systemusers", basicId) });
    assert.equal(response.status, 204, response.text);
    assert.ok(rows("queuemembership").some((m) => same(refIdOf(m.queueid), memberQueue) && same(refIdOf(m.systemuserid), basicId)));
    assert.equal(store.state.dataverse?.queueMemberships, undefined);
    const queues = await fn(`systemusers(${basicId})/Microsoft.Dynamics.CRM.RetrieveUserQueues(IncludePublic=false)`);
    assert.equal(queues.status, 200, queues.text);
    assert.ok(queues.json.value.some((queue) => same(queue.queueid, memberQueue)));
    const expanded = await fn(`queues(${memberQueue})?$expand=queuemembership_association`);
    assert.equal(expanded.status, 200, expanded.text);
    assert.ok(expanded.json.queuemembership_association.some((user) => same(user.systemuserid, basicId)));
  });

  it("AddPrincipalToQueue with a team adds each team user to the queue, once", async () => {
    const teamQueue = idIn(await act("queues", { name: "Contoso Team Queue" }));
    const teamId = idIn(await act("teams", { name: "Contoso Team" }));
    await store.transact(() => store.createRecord("teammembership", {
      teammembershipid: uuidV5(teamId, `member:${basicId}`),
      teamid: { id: teamId, logical_name: "team", name: "" }, systemuserid: { id: basicId, logical_name: "systemuser", name: "" },
    }, { admin: true }));
    for (let i = 0; i < 2; i += 1) {
      const response = await act(`queues(${teamQueue})/Microsoft.Dynamics.CRM.AddPrincipalToQueue`, { Principal: ref("teams", teamId) });
      assert.equal(response.status, 204, response.text);
    }
    const members = rows("queuemembership").filter((m) => same(refIdOf(m.queueid), teamQueue));
    assert.equal(members.length, 1);
    assert.ok(same(refIdOf(members[0].systemuserid), basicId));
  });

  it("POST queues/queuemembership_association/$ref associates a user as a queuemembership row", async () => {
    const response = await act(`queues(${queueId})/queuemembership_association/$ref`, { "@odata.id": `systemusers(${appUserId})` });
    assert.equal(response.status, 204, response.text);
    assert.ok(rows("queuemembership").some((m) => same(refIdOf(m.queueid), queueId) && same(refIdOf(m.systemuserid), appUserId)));
  });

  it("PickFromQueue assigns the queue item to the user and ReleaseToQueue clears the worker", async () => {
    const id = await queueItem();
    const picked = await act(`queueitems(${id})/Microsoft.Dynamics.CRM.PickFromQueue`, { SystemUser: ref("systemusers", basicId), RemoveQueueItem: false });
    assert.equal(picked.status, 204, picked.text);
    const item = rowOf("queueitem", "queueitemid", id);
    assert.equal(refIdOf(item.workerid), basicId);
    assert.equal(item.workeridtype, "systemuser");
    const released = await act(`queueitems(${id})/Microsoft.Dynamics.CRM.ReleaseToQueue`, {});
    assert.equal(released.status, 204, released.text);
    assert.equal(rowOf("queueitem", "queueitemid", id).workerid, null);
  });

  it("RetrieveUserQueues returns the queues the application user owns", async () => {
    const response = await fn(`systemusers(${appUserId})/Microsoft.Dynamics.CRM.RetrieveUserQueues(IncludePublic=true)`);
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json.value.some((queue) => queue.queueid === queueId));
  });

  it("RouteTo sends a picked queue item to another queue, unassigned", async () => {
    const id = await queueItem();
    assert.equal((await act(`queueitems(${id})/Microsoft.Dynamics.CRM.PickFromQueue`, { SystemUser: ref("systemusers", basicId), RemoveQueueItem: false })).status, 204);
    const other = idIn(await act("queues", { name: "Contoso Escalations" }));
    const response = await act("RouteTo", { Target: ref("queues", other), QueueItem: ref("queueitems", id) });
    assert.equal(response.status, 204, response.text);
    const item = rowOf("queueitem", "queueitemid", id);
    assert.deepEqual([refIdOf(item.queueid), item.workerid], [other, null]);
  });

  it("RemoveFromQueue deletes the queue item", async () => {
    const id = await queueItem();
    const response = await act(`queueitems(${id})/Microsoft.Dynamics.CRM.RemoveFromQueue`, {});
    assert.equal(response.status, 204, response.text);
    assert.equal(rowOf("queueitem", "queueitemid", id), undefined);
  });

  it("a Basic User cannot delete a queue item: the write is refused with the standard 403", async () => {
    const id = await queueItem();
    const response = await act(`queueitems(${id})/Microsoft.Dynamics.CRM.RemoveFromQueue`, {}, basicToken);
    refused(response, 403, /0x80040220/);
    assert.ok(rowOf("queueitem", "queueitemid", id), "the queue item survives the refused delete");
  });

  // ---- Refused calls: the message names the parameter or record it refuses.

  const REFUSALS = [
    ["AppendRelatedParty refuses a non-activity Activity", () => act("AppendRelatedParty", { Activity: ref("accounts", accountId), Party: ref("accounts", accountId) }), 400, /activity record/],
    ["RemoveParent refuses a target that is not a systemuser", () => act("RemoveParent", { Target: ref("accounts", accountId) }), 400, /systemuser record/],
    ["SendEmail refuses a call without IssueSend", () => act(`emails(${emailId})/Microsoft.Dynamics.CRM.SendEmail`, {}), 400, /IssueSend/],
    ["BackgroundSendEmail refuses a Query that is not an object", () => act("BackgroundSendEmail", { Query: "text" }), 400, /QueryBase/],
    ["BackgroundSendEmail refuses a Query over another table", () => act("BackgroundSendEmail", { Query: { "@odata.type": "Microsoft.Dynamics.CRM.QueryExpression", EntityName: "account" } }), 400, /email table/],
    ["CheckIncomingEmail refuses a call without MessageId", () => fn("CheckIncomingEmail()"), 400, /MessageId/],
    ["DeliverIncomingEmail refuses a ReceivedOn that is not a date", () => act("emails/Microsoft.Dynamics.CRM.DeliverIncomingEmail", { MessageId: "msg-9", ReceivedOn: "not a date" }), 400, /ReceivedOn/],
    ["DeliverIncomingEmail refuses an Attachments value that is not a collection of attachment objects", () => act("emails/Microsoft.Dynamics.CRM.DeliverIncomingEmail", { MessageId: "msg-att-2", Attachments: "a.txt" }), 400, /attachment objects/],
    ["CheckPromoteEmail refuses a DirectionCode that is not an integer", () => fn("CheckPromoteEmail(MessageId='msg-2',DirectionCode='x')"), 400, /DirectionCode/],
    ["DeliverPromoteEmail refuses a call without MessageId", () => act(`emails(${emailId})/Microsoft.Dynamics.CRM.DeliverPromoteEmail`, { Body: "x" }), 400, /MessageId/],
    ["DeliverImmediatePromoteEmail refuses a call without MessageId", () => act(`emails(${emailId})/Microsoft.Dynamics.CRM.DeliverImmediatePromoteEmail`, { Body: "x" }), 400, /MessageId/],
    ["CreateAndSendNewEmail refuses a From that is no user or queue address", () => act("CreateAndSendNewEmail", { Subject: "Hello", From: "nobody@nowhere.test" }), 400, /From/],
    ["GetTrackingTokenEmail refuses a Subject that is not a string", () => act("GetTrackingTokenEmail", { Subject: 5 }), 400, /Subject/],
    ["InstantiateTemplate refuses a TemplateId that is not a GUID", () => act("InstantiateTemplate", { TemplateId: "not-a-guid", ObjectType: "account", ObjectId: accountId }), 400, /TemplateId/],
    ["RetrieveMailboxTrackingFolders refuses a call without MailboxId", () => fn("RetrieveMailboxTrackingFolders()"), 400, /MailboxId/],
    ["SendEmailFromTemplate refuses a call without Target", () => act("SendEmailFromTemplate", { TemplateId: templateId, Regarding: ref("accounts", accountId) }), 400, /Target/],
    ["SendFax refuses a call without IssueSend", () => act("SendFax", { FaxId: faxId }), 400, /IssueSend/],
    ["SendTemplate refuses an empty Recipients list", () => act("SendTemplate", { TemplateId: templateId, Sender: ref("systemusers", appUserId), Recipients: [], Regarding: ref("accounts", accountId) }), 400, /Recipients/],
    ["AddToQueue refuses a call without Target", () => act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddToQueue`, {}), 400, /Target/],
    ["AddPrincipalToQueue refuses a Principal that is neither a user nor a team", () => act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddPrincipalToQueue`, { Principal: ref("accounts", accountId) }), 400, /systemuser or team/],
    ["PickFromQueue refuses a call without RemoveQueueItem", () => act(`queueitems(${queueItemId})/Microsoft.Dynamics.CRM.PickFromQueue`, { SystemUser: ref("systemusers", basicId) }), 400, /RemoveQueueItem/],
    ["ReleaseToQueue answers 404 for a queue item that does not exist", () => act(`queueitems(${MISSING})/Microsoft.Dynamics.CRM.ReleaseToQueue`, {}), 404],
    ["RetrieveUserQueues refuses a call without IncludePublic", () => fn(`systemusers(${appUserId})/Microsoft.Dynamics.CRM.RetrieveUserQueues()`), 400, /IncludePublic/],
    ["RouteTo refuses a call without QueueItem", () => act("RouteTo", { Target: ref("queues", queueId) }), 400, /QueueItem/],
    ["RemoveFromQueue answers 404 for a queue item that does not exist", () => act(`queueitems(${MISSING})/Microsoft.Dynamics.CRM.RemoveFromQueue`, {}), 404],
  ];
  for (const [name, call, status, text] of REFUSALS) it(name, async () => refused(await call(), status, text));

  // ---- SOAP

  it("answers GetTrackingTokenEmail over SOAP through the generic OrganizationRequest dispatch", async () => {
    const body = `<s:Envelope ${DECL}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:OrganizationRequest">`
      + `<a:Parameters><a:KeyValuePairOfstringanyType><b:key>Subject</b:key><b:value i:type="c:string">Quarterly figures</b:value>`
      + `</a:KeyValuePairOfstringanyType></a:Parameters><a:RequestName>GetTrackingTokenEmail</a:RequestName></request></Execute></s:Body></s:Envelope>`;
    const response = await fetch(`${origin}${SOAP_PATH}`, {
      method: "POST", headers: { authorization: `Bearer ${appToken}`, "content-type": "text/xml; charset=utf-8" }, body,
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const webToken = (await act("GetTrackingTokenEmail", { Subject: "Quarterly figures" })).json.TrackingToken;
    assert.match(text, new RegExp(`<b:key>TrackingToken</b:key><b:value[^>]*>${webToken}<`));
  });
});
