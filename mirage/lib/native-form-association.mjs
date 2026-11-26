import { AsyncLocalStorage } from 'node:async_hooks';
import { DataError } from './data.mjs';

// Only the configured form submission establishes this scope. Consume it at
// the root create before plugins or deep inserts can perform another write.
const associations = new AsyncLocalStorage();
export function withNativeFormContactAssociation(association, work) {
  return association ? associations.run({ ...association, consumed: false }, work) : work();
}
export function takeNativeFormContactAssociation(entity, identity) {
  const association = associations.getStore();
  if (!association || association.consumed) return null;
  association.consumed = true;
  const contactId = String(identity?.contactId ?? identity?.id ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
  return association.entity === entity && contactId && association.contactId === contactId
    ? { column: association.column, contactId }
    : null;
}

// The participation type each party list column records, from the Learn table "Activity party types available for each
// activity" (https://learn.microsoft.com/power-apps/developer/data-platform/activityparty-entity) and the values of
// ActivityParty.ParticipationTypeMask on the same page. The system creates every party list column; makers cannot add one
// (https://learn.microsoft.com/power-apps/maker/data-platform/types-of-fields#different-types-of-lookups), so the column
// logical names are the platform's own. Partners and Partner are listed without a party type of their own, so they stay
// unresolved rather than guessed.
const PARTY_LIST_TYPES = Object.freeze({
  from: 1, // Sender
  to: 2, // ToRecipient
  cc: 3, // CCRecipient
  bcc: 4, // BccRecipient
  requiredattendees: 5, // RequiredAttendee
  optionalattendees: 6, // OptionalAttendee
  organizer: 7, // Organizer
  resources: 10, // Resource
  customers: 11, // Customer (ServiceAppointment.Customers)
  customer: 11, // Customer (CampaignResponse.Customer)
  related: 13, // Related (Email.Related)
});

const fail = (message, status, code) => {
  throw new DataError(message, status, code);
};
const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();

/**
 * "Associate Current Portal User" with "Is Activity Party": the configured column must be a party list column of the
 * form's table (its metadata type), accept a contact (its metadata targets, when known) and record a documented
 * participation type. Returns the activityparty row the submission writes with the record, or fails before any write.
 * `definition` is the column's imported metadata; `participationTypes` the activityparty.participationtypemask column
 * metadata, when the model has it.
 */
export function currentContactParty({ entity, column, definition, participationTypes, identity }) {
  const contactId = canonical(identity?.contactId ?? identity?.id);
  if (!contactId) fail('Current-user association requires a signed-in contact', 401, 'FormSaveContactRequired');
  if (!definition)
    fail(
      `Current-user activity party column '${column}' has no imported metadata`,
      501,
      'FormUserAssociationUnresolved',
    );
  if (canonical(definition.dataverseType ?? definition.type) !== 'partylist')
    fail(
      `Current-user activity party column '${column}' is not a party list column`,
      501,
      'FormUserAssociationUnsupported',
    );
  if (Array.isArray(definition.targets) && !definition.targets.some((target) => canonical(target) === 'contact'))
    fail(`Party list column '${column}' does not accept a contact party`, 400, 'FormUserAssociationInvalid');
  const mask = Object.hasOwn(PARTY_LIST_TYPES, column) ? PARTY_LIST_TYPES[column] : undefined;
  if (mask === undefined)
    fail(`Party list column '${column}' has no documented participation type`, 501, 'FormUserAssociationUnresolved');
  const options = participationTypes?.options ?? participationTypes?.optionSet?.options;
  if (Array.isArray(options) && !options.some((option) => Number(option?.value) === mask))
    fail(
      `Participation type ${mask} of '${column}' is not an option of activityparty.participationtypemask`,
      501,
      'FormUserAssociationUnresolved',
    );
  return { entity: canonical(entity), column, contactId, participationtypemask: mask };
}

/**
 * The activityparty row of one saved record, as the store keeps party rows (dataverse-activity-messages.mjs): lookup
 * bindings when the activityparty mapping names the navigations, else entity references.
 */
export function currentContactPartyRow(party, recordId, { activityMapping, partyMapping, contactMapping } = {}) {
  const relationships = Object.entries(partyMapping?.relationships ?? {});
  const navigation = (from, entity) =>
    relationships.find(
      ([, relation]) =>
        relation?.many === false && canonical(relation.from) === from && canonical(relation.entity) === entity,
    )?.[0];
  const activity = activityMapping?.entitySet ? navigation('activityid', party.entity) : null,
    contact = contactMapping?.entitySet ? navigation('partyid', 'contact') : null;
  return {
    ...(activity
      ? { [`${activity}@odata.bind`]: `/${activityMapping.entitySet}(${encodeURIComponent(recordId)})` }
      : { activityid: { id: recordId, logical_name: party.entity } }),
    ...(contact
      ? { [`${contact}@odata.bind`]: `/${contactMapping.entitySet}(${encodeURIComponent(party.contactId)})` }
      : { partyid: { id: party.contactId, logical_name: 'contact' } }),
    participationtypemask: party.participationtypemask,
  };
}

/**
 * The party as a Web API deep insert of the activity create, for a provider that writes through the Web API (the live
 * bridge): the activity's collection-valued navigation to activityparty (`<activity>_activity_parties`) holds one new
 * activityparty that binds the contact through its single-valued navigation (`partyid_contact`). Learn: "Create related
 * table rows in one operation" (webapi/create-table-row) and the activityparty relationships
 * (reference/entities/activityparty). Both navigations come from the mappings; an unmapped one fails before any write.
 */
export function currentContactPartyDeepInsert(party, { activityMapping, partyMapping, contactMapping } = {}) {
  const collection = Object.entries(activityMapping?.relationships ?? {}).find(
    ([, relation]) =>
      relation?.many === true &&
      !relation.intersect &&
      canonical(relation.entity) === 'activityparty' &&
      canonical(relation.to) === 'activityid',
  )?.[0];
  const contact = Object.entries(partyMapping?.relationships ?? {}).find(
    ([, relation]) =>
      relation?.many === false && canonical(relation.from) === 'partyid' && canonical(relation.entity) === 'contact',
  )?.[0];
  if (!collection || !contact || !contactMapping?.entitySet)
    fail(
      `The activityparty navigations of '${party.entity}' are not mapped for a Web API deep insert`,
      501,
      'FormUserAssociationUnresolved',
    );
  return {
    [collection]: [
      {
        [`${contact}@odata.bind`]: `/${contactMapping.entitySet}(${encodeURIComponent(party.contactId)})`,
        participationtypemask: party.participationtypemask,
      },
    ],
  };
}
