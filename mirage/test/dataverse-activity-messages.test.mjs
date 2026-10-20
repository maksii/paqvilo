// Activity, email and queue messages (dataverse-activity-messages.mjs) through the full Dataverse API: the Web API routes,
// the Basic User privilege denial and one SOAP call through the generic OrganizationRequest dispatch. Invented data only;
// loopback. Each message has a happy path (its effect read back from the store) and one refused call.
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

    // Invented records the messages act on.
    accountId = idIn(await act("accounts", { name: "Contoso Ltd", emailaddress1: "ops@contoso.test" }));
    queueId = idIn(await act("queues", { name: "Contoso Support" }));
    emailId = idIn(await act("emails", { subject: "Quarterly figures", description: "Numbers attached" }));
    pendingEmailId = idIn(await act("emails", { subject: "Pending one", description: "Waiting" }));
    faxId = idIn(await act("faxes", { subject: "Invoice fax" }));
    templateId = idIn(await act("templates", {
      title: "Welcome", subject: "Welcome {name}", body: "Dear {account.name}, thanks.", templatetypecode: "account",
    }));
    for (const id of [accountId, queueId, emailId, pendingEmailId, faxId, templateId]) assert.ok(id, "fixture record created");
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  // ---- Activities ------------------------------------------------------------------------------------------------------

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

  it("AppendRelatedParty refuses a non-activity Activity", async () => {
    refused(await act("AppendRelatedParty", { Activity: ref("accounts", accountId), Party: ref("accounts", accountId) }), 400, /activity record/);
  });

  it("RemoveParent clears the systemuser's parent", async () => {
    const response = await act("RemoveParent", { Target: ref("systemusers", basicId) });
    assert.equal(response.status, 204, response.text);
    assert.equal(rowOf("systemuser", "systemuserid", basicId).parentsystemuserid, null);
  });

  it("RemoveParent refuses a target that is not a systemuser", async () => {
    refused(await act("RemoveParent", { Target: ref("accounts", accountId) }), 400, /systemuser record/);
  });

  // ---- Email -----------------------------------------------------------------------------------------------------------

  it("SendEmail moves a draft to Pending Send and then answers with its subject", async () => {
    const response = await act(`emails(${pendingEmailId})/Microsoft.Dynamics.CRM.SendEmail`, { IssueSend: true, TrackingToken: "CRM:1234" });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.Subject, "Pending one");
    const row = rowOf("email", "activityid", pendingEmailId);
    assert.equal(row.statuscode, 6);
    assert.equal(row.trackingtoken, "CRM:1234");
  });

  it("SendEmail refuses a call without IssueSend", async () => {
    refused(await act(`emails(${emailId})/Microsoft.Dynamics.CRM.SendEmail`, {}), 400, /IssueSend/);
  });

  it("BackgroundSendEmail returns the pending emails and changes none", async () => {
    const response = await act("BackgroundSendEmail", { Query: null });
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json.EntityCollection.some((row) => row.activityid === pendingEmailId));
    assert.equal(rowOf("email", "activityid", pendingEmailId).statuscode, 6);
  });

  it("BackgroundSendEmail refuses a Query that is not an object", async () => {
    refused(await act("BackgroundSendEmail", { Query: "text" }), 400, /QueryBase/);
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

  it("BackgroundSendEmail refuses a Query over another table", async () => {
    refused(await act("BackgroundSendEmail", { Query: { "@odata.type": "Microsoft.Dynamics.CRM.QueryExpression", EntityName: "account" } }), 400, /email table/);
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
    assert.equal(rowOf("email", "activityid", pendingEmailId).statuscode, 6);
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
    const response = await fn("CheckIncomingEmail(MessageId='msg-1')");
    assert.equal(response.status, 200, response.text);
    assert.deepEqual([response.json.ShouldDeliver, response.json.ReasonCode], [true, 0]);
  });

  it("CheckIncomingEmail refuses a call without MessageId", async () => {
    refused(await fn("CheckIncomingEmail()"), 400, /MessageId/);
  });

  it("DeliverIncomingEmail creates a received email, and CheckIncomingEmail then sees it", async () => {
    const response = await act("emails/Microsoft.Dynamics.CRM.DeliverIncomingEmail", {
      MessageId: "msg-1", From: "pat@fabrikam.test", To: "ops@contoso.test", Cc: "", Bcc: "", SubmittedBy: "pat@fabrikam.test",
      Importance: "1", Body: "Received body", Subject: "Incoming", ReceivedOn: "2026-10-19T10:00:00Z", ValidateBeforeCreate: true,
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.subject, "Incoming");
    assert.equal(rows("email").find((r) => r.messageid === "msg-1").statuscode, 4);
    const check = await fn("CheckIncomingEmail(MessageId='msg-1')");
    assert.equal(check.json.ShouldDeliver, false);
  });

  it("DeliverIncomingEmail refuses a ReceivedOn that is not a date", async () => {
    refused(await act("emails/Microsoft.Dynamics.CRM.DeliverIncomingEmail", { MessageId: "msg-9", ReceivedOn: "not a date" }), 400, /ReceivedOn/);
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

  it("DeliverIncomingEmail refuses an Attachments value that is not a collection of attachment objects", async () => {
    refused(await act("emails/Microsoft.Dynamics.CRM.DeliverIncomingEmail", { MessageId: "msg-att-2", Attachments: "a.txt" }), 400, /attachment objects/);
  });

  it("CheckPromoteEmail reports a new message as promotable", async () => {
    const response = await fn("CheckPromoteEmail(MessageId='msg-2',DirectionCode=1)");
    assert.equal(response.status, 200, response.text);
    assert.deepEqual([response.json.ShouldPromote, response.json.ReasonCode], [true, 0]);
  });

  it("CheckPromoteEmail refuses a DirectionCode that is not an integer", async () => {
    refused(await fn("CheckPromoteEmail(MessageId='msg-2',DirectionCode='x')"), 400, /DirectionCode/);
  });

  it("DeliverPromoteEmail promotes the bound email as received", async () => {
    const response = await act(`emails(${emailId})/Microsoft.Dynamics.CRM.DeliverPromoteEmail`, {
      MessageId: "msg-3", From: "pat@fabrikam.test", To: "ops@contoso.test", Body: "Promoted", Subject: "Promoted one",
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(rowOf("email", "activityid", emailId).messageid, "msg-3");
    assert.equal(rowOf("email", "activityid", emailId).statuscode, 4);
  });

  it("DeliverPromoteEmail refuses a call without MessageId", async () => {
    refused(await act(`emails(${emailId})/Microsoft.Dynamics.CRM.DeliverPromoteEmail`, { Body: "x" }), 400, /MessageId/);
  });

  it("DeliverImmediatePromoteEmail promotes the bound email as received", async () => {
    const response = await act(`emails(${pendingEmailId})/Microsoft.Dynamics.CRM.DeliverImmediatePromoteEmail`, { MessageId: "msg-4", Body: "Immediate" });
    assert.equal(response.status, 200, response.text);
    assert.equal(rowOf("email", "activityid", pendingEmailId).messageid, "msg-4");
  });

  it("DeliverImmediatePromoteEmail refuses a call without MessageId", async () => {
    refused(await act(`emails(${pendingEmailId})/Microsoft.Dynamics.CRM.DeliverImmediatePromoteEmail`, { Body: "x" }), 400, /MessageId/);
  });

  it("CreateAndSendNewEmail creates the email and leaves it Pending Send", async () => {
    const response = await act("CreateAndSendNewEmail", { Subject: "Hello", Body: "Hi there", To: "ops@contoso.test", Importance: 1 });
    assert.equal(response.status, 200, response.text);
    const row = rowOf("email", "activityid", response.json.EmailId);
    assert.deepEqual([row.subject, row.statuscode, row.statecode], ["Hello", 6, 1]);
  });

  it("CreateAndSendNewEmail refuses a From that is no user or queue address", async () => {
    refused(await act("CreateAndSendNewEmail", { Subject: "Hello", From: "nobody@nowhere.test" }), 400, /From/);
  });

  it("GetTrackingTokenEmail answers a CRM tracking token", async () => {
    const response = await act("GetTrackingTokenEmail", { Subject: "Quarterly figures" });
    assert.equal(response.status, 200, response.text);
    assert.match(response.json.TrackingToken, /^CRM:\d{4}$/);
  });

  it("GetTrackingTokenEmail refuses a Subject that is not a string", async () => {
    refused(await act("GetTrackingTokenEmail", { Subject: 5 }), 400, /Subject/);
  });

  it("InstantiateTemplate drafts an email for the record, filling the placeholders", async () => {
    const response = await act("InstantiateTemplate", { TemplateId: templateId, ObjectType: "account", ObjectId: accountId });
    assert.equal(response.status, 200, response.text);
    const [draft] = response.json.value;
    assert.equal(draft.subject, "Welcome Contoso Ltd");
    assert.equal(draft.description, "Dear Contoso Ltd, thanks.");
    assert.equal(draft.statuscode, 1);
  });

  it("InstantiateTemplate refuses a TemplateId that is not a GUID", async () => {
    refused(await act("InstantiateTemplate", { TemplateId: "not-a-guid", ObjectType: "account", ObjectId: accountId }), 400, /TemplateId/);
  });

  it("RetrieveMailboxTrackingFolders answers the mappings of a mailbox", async () => {
    const response = await fn("RetrieveMailboxTrackingFolders(MailboxId='mbx-1')");
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.MailboxTrackingFolderMappings, []);
  });

  it("RetrieveMailboxTrackingFolders refuses a call without MailboxId", async () => {
    refused(await fn("RetrieveMailboxTrackingFolders()"), 400, /MailboxId/);
  });

  it("SendEmailFromTemplate drafts an email to the target's address and leaves it Pending Send", async () => {
    const response = await act("SendEmailFromTemplate", { TemplateId: templateId, Regarding: ref("accounts", accountId), Target: ref("accounts", accountId) });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.torecipients, "ops@contoso.test");
    assert.equal(response.json.statuscode, 6);
  });

  it("SendEmailFromTemplate refuses a call without Target", async () => {
    refused(await act("SendEmailFromTemplate", { TemplateId: templateId, Regarding: ref("accounts", accountId) }), 400, /Target/);
  });

  it("SendFax marks the fax Sent", async () => {
    const response = await act("SendFax", { FaxId: faxId, IssueSend: true });
    assert.equal(response.status, 204, response.text);
    assert.equal(rowOf("fax", "activityid", faxId).statuscode, 3);
  });

  it("SendFax refuses a call without IssueSend", async () => {
    refused(await act("SendFax", { FaxId: faxId }), 400, /IssueSend/);
  });

  it("SendTemplate drafts one Pending Send email per recipient", async () => {
    const before = rows("email").length;
    const response = await act("SendTemplate", {
      TemplateId: templateId, Sender: ref("systemusers", appUserId), Recipients: [ref("accounts", accountId)], Regarding: ref("accounts", accountId), DeliveryPriorityCode: 2,
    });
    assert.equal(response.status, 204, response.text);
    assert.equal(rows("email").length, before + 1);
    assert.equal(rows("email").at(-1).torecipients, "ops@contoso.test");
  });

  it("SendTemplate refuses an empty Recipients list", async () => {
    refused(await act("SendTemplate", { TemplateId: templateId, Sender: ref("systemusers", appUserId), Recipients: [], Regarding: ref("accounts", accountId) }), 400, /Recipients/);
  });

  // ---- Queues ----------------------------------------------------------------------------------------------------------

  it("AddToQueue creates a queue item for the record, with the given title", async () => {
    const response = await act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddToQueue`, {
      Target: ref("accounts", accountId), QueueItemProperties: { title: "Renewal call" },
    });
    assert.equal(response.status, 200, response.text);
    queueItemId = response.json.QueueItemId;
    const item = rowOf("queueitem", "queueitemid", queueItemId);
    assert.equal(refIdOf(item.queueid), queueId);
    assert.equal(refIdOf(item.objectid), accountId);
    assert.equal(item.title, "Renewal call");
  });

  it("AddToQueue refuses a call without Target", async () => {
    refused(await act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddToQueue`, {}), 400, /Target/);
  });

  it("AddPrincipalToQueue adds a systemuser as a queuemembership row", async () => {
    const response = await act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddPrincipalToQueue`, { Principal: ref("systemusers", basicId) });
    assert.equal(response.status, 204, response.text);
    assert.ok(rows("queuemembership").some((m) => same(refIdOf(m.queueid), queueId) && same(refIdOf(m.systemuserid), basicId)));
    assert.equal(store.state.dataverse?.queueMemberships, undefined);
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

  it("RetrieveUserQueues returns a queue the user is a member of through queuemembership", async () => {
    const response = await fn(`systemusers(${basicId})/Microsoft.Dynamics.CRM.RetrieveUserQueues(IncludePublic=false)`);
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json.value.some((queue) => same(queue.queueid, queueId)));
  });

  it("GET queues with $expand=queuemembership_association lists the member users", async () => {
    const response = await fn(`queues(${queueId})?$expand=queuemembership_association`);
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json.queuemembership_association.some((user) => same(user.systemuserid, basicId)));
  });

  it("POST queues/queuemembership_association/$ref associates a user as a queuemembership row", async () => {
    const response = await act(`queues(${queueId})/queuemembership_association/$ref`, { "@odata.id": `systemusers(${appUserId})` });
    assert.equal(response.status, 204, response.text);
    assert.ok(rows("queuemembership").some((m) => same(refIdOf(m.queueid), queueId) && same(refIdOf(m.systemuserid), appUserId)));
  });

  it("AddPrincipalToQueue refuses a Principal that is neither a user nor a team", async () => {
    refused(await act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddPrincipalToQueue`, { Principal: ref("accounts", accountId) }), 400, /systemuser or team/);
  });

  it("PickFromQueue assigns the queue item to the user", async () => {
    const response = await act(`queueitems(${queueItemId})/Microsoft.Dynamics.CRM.PickFromQueue`, { SystemUser: ref("systemusers", basicId), RemoveQueueItem: false });
    assert.equal(response.status, 204, response.text);
    const item = rowOf("queueitem", "queueitemid", queueItemId);
    assert.equal(refIdOf(item.workerid), basicId);
    assert.equal(item.workeridtype, "systemuser");
  });

  it("PickFromQueue refuses a call without RemoveQueueItem", async () => {
    refused(await act(`queueitems(${queueItemId})/Microsoft.Dynamics.CRM.PickFromQueue`, { SystemUser: ref("systemusers", basicId) }), 400, /RemoveQueueItem/);
  });

  it("ReleaseToQueue clears the worker", async () => {
    const response = await act(`queueitems(${queueItemId})/Microsoft.Dynamics.CRM.ReleaseToQueue`, {});
    assert.equal(response.status, 204, response.text);
    assert.equal(rowOf("queueitem", "queueitemid", queueItemId).workerid, null);
  });

  it("ReleaseToQueue answers 404 for a queue item that does not exist", async () => {
    refused(await act(`queueitems(${MISSING})/Microsoft.Dynamics.CRM.ReleaseToQueue`, {}), 404);
  });

  it("RetrieveUserQueues returns the queues the application user owns", async () => {
    const response = await fn(`systemusers(${appUserId})/Microsoft.Dynamics.CRM.RetrieveUserQueues(IncludePublic=true)`);
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json.value.some((queue) => queue.queueid === queueId));
  });

  it("RetrieveUserQueues refuses a call without IncludePublic", async () => {
    refused(await fn(`systemusers(${appUserId})/Microsoft.Dynamics.CRM.RetrieveUserQueues()`), 400, /IncludePublic/);
  });

  it("RouteTo sends a queue item to another queue, unassigned", async () => {
    const other = idIn(await act("queues", { name: "Contoso Escalations" }));
    const response = await act("RouteTo", { Target: ref("queues", other), QueueItem: ref("queueitems", queueItemId) });
    assert.equal(response.status, 204, response.text);
    assert.equal(refIdOf(rowOf("queueitem", "queueitemid", queueItemId).queueid), other);
  });

  it("RouteTo refuses a call without QueueItem", async () => {
    refused(await act("RouteTo", { Target: ref("queues", queueId) }), 400, /QueueItem/);
  });

  it("RemoveFromQueue deletes the queue item", async () => {
    const created = await act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddToQueue`, { Target: ref("accounts", accountId) });
    const id = created.json.QueueItemId;
    const response = await act(`queueitems(${id})/Microsoft.Dynamics.CRM.RemoveFromQueue`, {});
    assert.equal(response.status, 204, response.text);
    assert.equal(rowOf("queueitem", "queueitemid", id), undefined);
  });

  it("RemoveFromQueue answers 404 for a queue item that does not exist", async () => {
    refused(await act(`queueitems(${MISSING})/Microsoft.Dynamics.CRM.RemoveFromQueue`, {}), 404);
  });

  it("a Basic User cannot delete a queue item: the write is refused with the standard 403", async () => {
    const created = await act(`queues(${queueId})/Microsoft.Dynamics.CRM.AddToQueue`, { Target: ref("accounts", accountId) });
    const id = created.json.QueueItemId;
    const response = await act(`queueitems(${id})/Microsoft.Dynamics.CRM.RemoveFromQueue`, {}, basicToken);
    refused(response, 403, /0x80040220|missing .* privilege/);
    assert.ok(rowOf("queueitem", "queueitemid", id), "the queue item survives the refused delete");
  });

  // ---- SOAP -----------------------------------------------------------------------------------------------------------

  it("answers GetTrackingTokenEmail over SOAP through the generic OrganizationRequest dispatch", async () => {
    const body = `<s:Envelope ${DECL}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:OrganizationRequest">`
      + `<a:Parameters><a:KeyValuePairOfstringanyType><b:key>Subject</b:key><b:value i:type="c:string">Quarterly figures</b:value>`
      + `</a:KeyValuePairOfstringanyType></a:Parameters><a:RequestName>GetTrackingTokenEmail</a:RequestName></request></Execute></s:Body></s:Envelope>`;
    const response = await fetch(`${origin}${SOAP_PATH}`, {
      method: "POST", headers: { authorization: `Bearer ${appToken}`, "content-type": "text/xml; charset=utf-8" }, body,
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /<b:key>TrackingToken<\/b:key>/);
    assert.match(text, /CRM:\d{4}/);
  });
});
