const queryReference = 'https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/overview';
const pageReference = 'https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results';
const queryRule = (id, title, severity, message, remediation, reference = queryReference) => ({
  id,
  domain: 'dataverse',
  title,
  severity,
  category: 'performance',
  confidence: 'medium',
  message,
  remediation,
  references: [reference],
});
export const dataverseQueryRules = [
  queryRule(
    'DV-QUERY-002',
    'Literal Dataverse query has no projection',
    'hint',
    'A literal Dataverse collection query has no explicit column projection.',
    'Select the required logical columns, including lookup value properties and required keys; verify dynamic wrappers and response consumers.',
  ),
  queryRule(
    'DV-QUERY-003',
    'Unsupported Dataverse OData query option',
    'warning',
    'A literal Dataverse OData request uses an unsupported skip, search or format query option.',
    'Use returned nextLink or skipToken for OData paging; Dataverse search uses its separate documented endpoint.',
    pageReference,
  ),
  queryRule(
    'DV-QUERY-004',
    'Annotation selected as a property',
    'warning',
    'A literal Dataverse query selects a formatted-value annotation as a property.',
    'Select the actual logical or lookup value property and request formatted-value annotations through Prefer; do not invent shadow name columns.',
  ),
  queryRule(
    'DV-QUERY-005',
    'Result cap combined with continuation',
    'warning',
    'A literal Dataverse request combines a top result cap with a continuation token.',
    'Follow the returned continuation URL unchanged and use the documented page-size header for paging; top is a result cap.',
    pageReference,
  ),
];

function quotedEnd(text, start) {
  const quote = text[start];
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') cursor += 2;
    else if (text[cursor++] === quote) return cursor;
  }
  return text.length;
}

function decodedLiteral(raw) {
  if (/\$\{|@\{|{{/.test(raw)) return null;
  let text = '';
  for (let cursor = 0; cursor < raw.length; cursor++) {
    if (raw[cursor] !== '\\') {
      text += raw[cursor];
      continue;
    }
    const next = raw[++cursor];
    if (!['\\', '/', '"', "'", '`'].includes(next)) return null;
    text += next;
  }
  return text;
}

function commentEnd(text, cursor) {
  let marker;
  if (text.startsWith('//', cursor)) marker = '\n';
  else if (text.startsWith('/*', cursor)) marker = '*/';
  else return undefined;
  const end = text.indexOf(marker, cursor + 2);
  return end < 0 ? text.length : end + marker.length;
}

function* stringLiterals(text) {
  for (let cursor = 0; cursor < text.length;) {
    const endComment = commentEnd(text, cursor);
    if (endComment !== undefined) {
      cursor = endComment;
      continue;
    }
    if (!['"', "'", '`'].includes(text[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor,
      end = quotedEnd(text, cursor);
    cursor = end;
    if (text[end - 1] !== text[start]) continue;
    const value = decodedLiteral(text.slice(start + 1, end - 1));
    if (value !== null) yield { value, start };
  }
}

function xrmOptions(text, literal) {
  if (!literal.value.startsWith('?')) return false;
  const before = text.slice(Math.max(0, literal.start - 256), literal.start).trimEnd();
  if (!before.endsWith(',')) return false;
  const call = before.slice(0, -1).trimEnd(),
    start = call.lastIndexOf('Xrm.WebApi');
  if (start < 0) return false;
  const segment = call.slice(start),
    open = segment.indexOf('(');
  const method = segment.slice(0, open).trim();
  if (!['Xrm.WebApi.retrieveMultipleRecords', 'Xrm.WebApi.online.retrieveMultipleRecords'].includes(method))
    return false;
  const argument = segment.slice(open + 1).trim();
  const quoted = ['"', "'"].includes(argument[0]) && argument.at(-1) === argument[0];
  return quoted || /^[A-Za-z_$][\w$]*$/.test(argument);
}

function requestQuery(value, options) {
  let url;
  try {
    url = new URL(
      options ? `https://analysis.invalid/api/data/v9.2/collection${value}` : value,
      'https://analysis.invalid',
    );
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !/\/api\/data\/v\d+\.\d+\/[^/()]+$/i.test(url.pathname)) return null;
  const query = url.searchParams;
  if (![...query.keys()].some((key) => key.startsWith('$'))) return null;
  return query;
}

function inspectQuery(entry, literal, emit, options = false) {
  if (!options && !literal.value.toLowerCase().includes('/api/data/v')) return false;
  const query = requestQuery(literal.value, options);
  if (!query) return false;
  if (!query.has('$select') && !query.has('fetchXml') && !query.has('$skiptoken'))
    emit('DV-QUERY-002', entry, undefined, literal.start);
  if (['$skip', '$search', '$format'].some((key) => query.has(key)))
    emit('DV-QUERY-003', entry, undefined, literal.start);
  if ((query.get('$select') ?? '').split(',').some((column) => column.includes('@')))
    emit('DV-QUERY-004', entry, undefined, literal.start);
  if (query.has('$top') && query.has('$skiptoken')) emit('DV-QUERY-005', entry, undefined, literal.start);
  return true;
}

function inspectHttpQueries(entry, emit) {
  let queries = 0;
  for (const match of entry.text.matchAll(/^(?:GET|HEAD)[ \t]+([^\s]+)[ \t]*\r?$/gim))
    if (inspectQuery(entry, { value: match[1], start: match.index }, emit)) queries++;
  return { queries, truncated: false };
}

// Only a literal that starts with '?' can be an Xrm.WebApi options string, so only those pay the per-literal context lookup;
// the budget counts them alone and every other literal is bounded by the 2 MiB file limit.
const OPTION_LITERAL_LIMIT = 100000;
function inspectScriptQueries(entry, emit) {
  let queries = 0,
    optionLiterals = 0;
  for (const literal of stringLiterals(entry.text)) {
    if (literal.value.startsWith('?') && ++optionLiterals > OPTION_LITERAL_LIMIT) return { queries, truncated: true };
    if (inspectQuery(entry, literal, emit, xrmOptions(entry.text, literal))) queries++;
  }
  return { queries, truncated: false };
}

export function analyzeDataverseQueries(entries, emit) {
  let queries = 0;
  const skipped = [],
    fileNames = [];
  for (const entry of entries) {
    let result;
    if (/\.(?:http|rest)$/i.test(entry.file)) result = inspectHttpQueries(entry, emit);
    else if (/\.(?:[cm]?js|jsx|tsx?|json)$/i.test(entry.file)) result = inspectScriptQueries(entry, emit);
    else continue;
    if (result.queries) fileNames.push(entry.file);
    queries += result.queries;
    if (result.truncated) skipped.push({ file: entry.file, reason: 'dataverse-query-literal-limit' });
  }
  return { files: fileNames.length, queries, skipped, fileNames };
}
