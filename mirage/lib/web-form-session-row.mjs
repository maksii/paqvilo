// The adx_webformsession row of a signed-in contact's multistep form session, as hosted Power Pages writes it (hosted
// session F2, paqvilo-developer hosted-f2 runs e and f, two agreeing runs, Enhanced data model): the first saved step
// creates the row after the step's record (Create adx_webformsession with the saved step current), the same request
// moves it to the next step (Update), every later step updates it after its record, and the last step's Update is
// followed by the deactivation (statecode 1) whose Update has no PreValidation stage, as the SetState message's own
// Update. Each message is a portal call of the contact (IsPortalsClientCall, PortalsContactId) at depth 1. The row
// carries the contact, the user identity name, the visitor's address, the current step index, the step history JSON,
// the primary record and, in the enhanced data model, the form and current step components; adx_name and
// adx_anonymousidentification stay empty. No cleanup removes rows (oldest row ~19 h, no bulk-delete job).
// An anonymous visitor's session (hosted session F4, paqvilo-developer hosted-f4 multistep-private runs a and b) has a
// row too, from its first saved step: a 36-character GUID in adx_anonymousidentification, the visitor's address, the
// step index, the step history and the record, without a contact or a user identity name; the last step deactivates it.
// The browser keeps the identification it already has, so creating the session sets no cookie: Mirage derives the GUID
// from the anonymous visitor cookie (visitor-session.mjs) the browser's first page load received, one-way, so the row
// never holds the cookie's value.
// Mirage keeps routing in its own session bookkeeping (form-service.mjs createWebFormSessions); the row is the
// Dataverse record the platform keeps for it.
import { createHash } from 'node:crypto';
import { portalRecordWrites } from './form-service.mjs';
import { sessionByIdFetch } from './form-read-messages.mjs';

const WEB_FORM_SESSION = 'adx_webformsession';
const ZERO = '00000000-0000-0000-0000-000000000000';
const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const same = (a, b) => canonical(a) === canonical(b);

const lookup = (entity, to) => (from) => ({ entity, from, to, many: false, type: 'many-to-one' });

/** The adx_anonymousidentification GUID of an anonymous visitor id (a one-way derivation, shaped as a version 4 GUID). */
function anonymousIdentification(visitorId) {
  const hex = createHash('sha256').update('adx_anonymousidentification\0').update(canonical(visitorId)).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The table mapping (the entity set the hosted Web API names), added when the data does not define the table. */
function ensureSessionTable(store, contactMapping) {
  const mappings = (store.state.mappings ??= {});
  if (!mappings[WEB_FORM_SESSION]) {
    const contact = lookup('contact', contactMapping?.idColumn ?? 'contactid');
    mappings[WEB_FORM_SESSION] = {
      logicalName: WEB_FORM_SESSION,
      entitySet: 'adx_webformsessions',
      entitySetSource: 'dataverse-reference',
      idColumn: 'adx_webformsessionid',
      idColumnSource: 'dataverse-reference',
      nameColumn: 'adx_name',
      // The form and step lookups (mspp_webformid, mspp_webformstepid) name the site's components, which are its
      // read-only source rows rather than store records, so they are lookup values without a declared relationship.
      relationships: { adx_contact: contact('adx_contact') },
      inferred: true,
    };
  }
  store.state.tables ??= {};
  store.state.tables[WEB_FORM_SESSION] ??= [];
  return store.resolveMapping(WEB_FORM_SESSION);
}

const mappingOf = (store, entity) => {
  try {
    return store.resolveMapping(entity) ?? null;
  } catch {
    return null;
  }
};
const idColumnOf = (store, entity) => mappingOf(store, entity)?.idColumn ?? null;

/** The step history entries of a session state: its saved steps, then its current step when it has not saved it. */
function historyEntries(state, stepEntity) {
  const entries = state.history.map((entry) => ({
    stepId: entry.stepId,
    recordId: entry.recordId,
    entity: entry.entity,
  }));
  if (state.current && !entries.some((entry) => same(entry.stepId, state.current)))
    entries.push({ stepId: state.current, recordId: null, entity: stepEntity(state.current) });
  return entries;
}

/** The captured row attributes of a session state (the Create target shape; the Update adds state and id). */
function sessionAttributes(store, state, facts) {
  const entries = historyEntries(state, facts.stepEntity);
  const history = entries.map((entry, index) => ({
    ID: canonical(entry.stepId),
    Index: index,
    IsActive: true,
    PaymentTableEntity: null,
    PreviousStepID: index ? canonical(entries[index - 1].stepId) : ZERO,
    ReferenceEntity: {
      ID: entry.recordId ? canonical(entry.recordId) : ZERO,
      LogicalName: entry.entity ?? null,
      PrimaryKeyLogicalName: entry.entity ? idColumnOf(store, entry.entity) : null,
    },
  }));
  const current = Math.max(
    0,
    entries.findIndex((entry) => same(entry.stepId, state.current ?? entries.at(-1)?.stepId)),
  );
  const primary = entries.find((entry) => entry.recordId) ?? null;
  const component = (id, name) => ({ id: canonical(id), logical_name: 'powerpagecomponent', name: name ?? null });
  return {
    ...(facts.enhanced ? { mspp_webformid: component(facts.webform.id, facts.webform.name) } : {}),
    adx_primaryrecordid: primary ? canonical(primary.recordId) : null,
    ...(facts.enhanced && entries[current]
      ? { mspp_webformstepid: component(entries[current].stepId, facts.stepName(entries[current].stepId)) }
      : {}),
    adx_primaryrecordentitylogicalname: primary?.entity ?? null,
    adx_primaryrecordentitykeyname: primary?.entity ? idColumnOf(store, primary.entity) : null,
    adx_currentstepindex: current,
    adx_contact: facts.contactId
      ? { id: facts.contactId, logical_name: 'contact', name: facts.contactName ?? null }
      : null,
    ...(facts.anonymousIdentification ? { adx_anonymousidentification: facts.anonymousIdentification } : {}),
    adx_stephistory: JSON.stringify(history),
    adx_userhostaddress: facts.userHostAddress ?? null,
    adx_useridentityname: facts.userIdentityName ?? null,
  };
}

/**
 * The row facts of the session's owner: its contact, or its anonymous identification; null when it has no row. An
 * anonymous owner has a row only when its visitor came from the browser's own cookie (facts.anonymousIdentified): a
 * cookieless request, which starts a new visitor each time, writes no row.
 */
function sessionOwnerFacts(store, progress, facts) {
  const owner = String(progress.owner ?? '');
  const contactId = canonical(facts.identity?.contactId ?? facts.identity?.id);
  if (!contactId && owner.startsWith('visitor:'))
    return facts.anonymousIdentified
      ? { ...facts, contactId: null, anonymousIdentification: anonymousIdentification(owner.slice(8)) }
      : null;
  if (!contactId || !owner.startsWith('contact:')) return null;
  const contactMapping = mappingOf(store, 'contact');
  const contact = contactMapping
    ? store.tableRows('contact').find((row) => same(row[contactMapping.idColumn], contactId))
    : null;
  // The row names its contact; a visitor identity without a contact row has no row.
  if (!contact) return null;
  const nameColumn = contactMapping.nameColumn ?? 'fullname';
  // The user identity name as the portal user object reports it (portal-client-object.mjs userName).
  return {
    ...facts,
    contactId,
    contactName: contact?.[nameColumn] ?? null,
    userIdentityName: String(contact?.adx_identity_username ?? contactId),
  };
}

/**
 * Write the adx_webformsession row for one staged session change, inside the caller's store transaction: `previous` is
 * the session before the change (revision 0: the row does not exist yet), `progress` after it. `facts` describe the form
 * ({ webform: { id, name }, stepEntity(stepId), stepName(stepId), enhanced, userHostAddress, identity,
 * anonymousIdentified }); a signed-in contact's session and an identified anonymous visitor's session have a row.
 * Answers whether the session is backed by its row and so kept without bound (form-service.mjs stage): a contact's row
 * only. An anonymous session's row is written, but its session stays bounded like every other session, so visitors
 * that keep presenting new identifications cannot grow the session store.
 */
export async function writeWebFormSessionRow(store, previous, progress, facts) {
  const described = sessionOwnerFacts(store, progress, facts);
  if (!described) return false;
  const mapping = ensureSessionTable(store, mappingOf(store, 'contact'));
  const writes = portalRecordWrites(store, { portalRequest: true });
  // The platform's row is the visitor's portal call written without the visitor's table permissions
  // (plugin-portal-caller.mjs portalPlatformWrite).
  const writer = { ...facts.identity, admin: true, portalPlatformWrite: true };
  const id = canonical(progress.id);
  const exists = store.tableRows(WEB_FORM_SESSION).some((row) => same(row[mapping.idColumn], id));
  if (!exists) {
    // The row starts at the step the request saved.
    const saved = progress.history.at(-1)?.stepId ?? progress.current;
    await writes.create(
      WEB_FORM_SESSION,
      { [mapping.idColumn]: id, ...sessionAttributes(store, { ...progress, current: saved }, described) },
      writer,
    );
  }
  // The platform reads the active session before it updates it (form-read-messages.mjs).
  await store.fetchXml(sessionByIdFetch(id), writer, { portalRequest: true });
  await writes.update(
    WEB_FORM_SESSION,
    id,
    { ...sessionAttributes(store, progress, described), statecode: 0, statuscode: 1 },
    writer,
  );
  if (progress.completed && !previous.completed)
    // The deactivation is the SetState message's own Update: no PreValidation stage, no ConcurrencyBehavior and no
    // nested state message (plugin-platform-messages.mjs). Inactive's default status reason is 2.
    await portalRecordWrites(store, {
      portalRequest: true,
      skipPreValidation: true,
      omitConcurrencyBehavior: true,
      stateMessage: false,
    }).update(WEB_FORM_SESSION, id, { statecode: 1, statuscode: 2 }, writer);
  return Boolean(described.contactId);
}
