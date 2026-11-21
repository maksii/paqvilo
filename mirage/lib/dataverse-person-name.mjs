// The composed full name of a person row (contact, lead): the platform computes fullname from firstname, middlename and
// lastname at the main operation, in the order the organization's fullnameconventioncode names, and a supplied fullname
// is replaced. yomifullname is composed the same way from yomifirstname, yomimiddlename and yomilastname, and is the
// fullname while the row has no phonetic part.
// Observed on a developer environment (convention 1): mirage/test/fixtures/dataverse-native-contact-fullname.json.
// The other conventions follow the option labels of organization.fullnameconventioncode on Microsoft Learn; lead follows
// the contact rule (the same documented columns), without a capture. A row with no name part at all was not captured:
// it keeps the fullname it is given or already holds.
import { organizationRecord } from './organization-context.mjs';

const PERSON_TABLES = new Set(['contact', 'lead']);
const PARTS = ['firstname', 'middlename', 'lastname'];
const YOMI_PARTS = ['yomifirstname', 'yomimiddlename', 'yomilastname'];
// The convention the observed environment reports; Learn lists 0 as the default form value only.
const DEFAULT_FULL_NAME_CONVENTION = 1;

const spaced = (...parts) => parts.filter(Boolean).join(' ');
const commaSeparated = (last, rest) => [last, rest].filter(Boolean).join(', ');
const initial = (middle) => (middle ? `${[...middle][0]}.` : '');
// fullnameconventioncode: 0 Last, First; 1 First Name (first last); 2 Last, First, Middle Initial; 3 First, Middle Initial,
// Last; 4 Last, First, Middle Name; 5 First, Middle Name, Last; 6 Last Name, space, First Name; 7 Last Name, no space, First.
const FORMATS = [
  (f, m, l) => commaSeparated(l, f),
  (f, m, l) => spaced(f, l),
  (f, m, l) => commaSeparated(l, spaced(f, initial(m))),
  (f, m, l) => spaced(f, initial(m), l),
  (f, m, l) => commaSeparated(l, spaced(f, m)),
  (f, m, l) => spaced(f, m, l),
  (f, m, l) => spaced(l, f),
  (f, m, l) => [l, f].filter(Boolean).join(''),
];

/** The full name the convention composes from the parts [first, middle, last]; null when every part is empty. */
function composeFullName(parts, convention = DEFAULT_FULL_NAME_CONVENTION) {
  const format = FORMATS[convention] ?? FORMATS[DEFAULT_FULL_NAME_CONVENTION];
  return format(...parts.map((part) => (typeof part === 'string' ? part : ''))) || null;
}

/** Sets fullname and yomifullname on the final row of a person table's create, or of an update that names a part. */
export function stampPersonName(store, mapping, operation, row, target) {
  if (!PERSON_TABLES.has(mapping.logicalName)) return;
  const named = (name) => Object.hasOwn(target ?? {}, name);
  if (operation !== 'create' && ![...PARTS, ...YOMI_PARTS, 'fullname', 'yomifullname'].some(named)) return;
  const convention = Number(organizationRecord(store)?.fullnameconventioncode ?? DEFAULT_FULL_NAME_CONVENTION);
  const composed = composeFullName(
    PARTS.map((name) => row[name]),
    convention,
  );
  if (composed !== null) row.fullname = composed;
  const yomi = YOMI_PARTS.map((name) => row[name]);
  const phonetic = yomi.some(Boolean) ? composeFullName(yomi, convention) : row.fullname;
  if (phonetic != null) row.yomifullname = phonetic;
}
