// The Dataverse reads a portal form sends, as hosted Power Pages sends them (hosted session F2, paqvilo-developer
// hosted-f2: runs a/b choices, choices-rte and subgrid, runs e/f steps; two agreeing runs per path). Each is a portal call
// of the signed-in contact at stage 10 and depth 1, so a read step registered on the table observes it:
// - a basic form edit page: Retrieve of the record, then RetrieveMultiple of the form's data (FetchXML, all attributes)
//   and a one-row RetrieveMultiple (QueryExpression, all columns); the postback re-render sends only the first two;
// - a multistep step page that edits a saved record: three FetchXML RetrieveMultiple reads of the record, no Retrieve;
// - an update save: a RetrieveMultiple naming only the record id before the Update; a multistep step update also
//   Retrieves the record before its Update;
// - a multistep page of a signed-in contact: RetrieveMultiple of the contact's latest active adx_webformsession of the
//   form, and before each session Update a RetrieveMultiple of that active session.
// The FetchXML texts are the captured ones, with the table, key column and ids of the request.
const xml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The platform writes a record id in braces in some reads; a local data id that is no GUID is written as it is.
const braced = (id) =>
  GUID.test(String(id).replace(/[{}]/g, '')) ? `{${String(id).replace(/[{}]/g, '')}}` : String(id);

/** The OData filter of the one-row read naming the record id (a GUID literal, else a quoted string). */
export const recordIdFilter = (idColumn, id) =>
  GUID.test(String(id)) ? `${idColumn} eq ${id}` : `${idColumn} eq '${String(id).replaceAll("'", "''")}'`;

/** The save's existence read: the record id only. */
export const recordExistsFetch = (entity, idColumn, id) =>
  `<fetch mapping="logical"><entity name="${xml(entity)}"><filter><condition attribute="${xml(idColumn)}" operator="eq" value="${xml(id)}" /></filter></entity></fetch>`;

/** The form's data read: every attribute of the record. */
export const formDataFetch = (entity, idColumn, id) =>
  `<fetch mapping="logical"><entity name="${xml(entity)}"><all-attributes /><filter type="and"><condition attribute="${xml(idColumn)}" operator="eq" value="${xml(braced(id))}" /></filter></entity></fetch>`;

/** The three reads of a multistep step page that edits a saved record, in the captured order. */
export const stepRecordFetches = (entity, idColumn, id) => [
  `<fetch mapping='logical'><entity name='${xml(entity)}'><all-attributes /><filter type='and'><condition attribute = '${xml(idColumn)}' operator='eq' value='${xml(braced(id))}'/></filter></entity></fetch>`,
  `<fetch mapping="logical"><entity name="${xml(entity)}"><all-attributes /><filter><condition attribute="${xml(idColumn)}" operator="eq" value="${xml(id)}" /></filter></entity></fetch>`,
  formDataFetch(entity, idColumn, id),
];

/** The contact's latest active session of a multistep form (enhanced data model: mspp_webformid). */
export const activeSessionFetch = (webformId, contactId) =>
  `<fetch mapping="logical"><entity name="adx_webformsession"><all-attributes /><order attribute="modifiedon" descending="true" /><filter><condition attribute="statecode" operator="eq" value="0" /><condition attribute="mspp_webformid" operator="eq" value="${xml(webformId)}" /><condition attribute="adx_contact" operator="eq" value="${xml(contactId)}" /></filter></entity></fetch>`;

/** The active session read before a session Update. */
export const sessionByIdFetch = (sessionId) =>
  `<fetch mapping="logical"><entity name="adx_webformsession"><filter><condition attribute="statecode" operator="eq" value="0" /><condition attribute="adx_webformsessionid" operator="eq" value="${xml(sessionId)}" /></filter></entity></fetch>`;
