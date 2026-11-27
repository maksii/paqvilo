/**
 * Convert one run of hosted session F7's Dataverse Web API reads (paqvilo-developer hosted-f7, runs/<run>/dv-reads-<phase>.json:
 * { record, results: [{ id, path, output: { status, headers, body } }] }) to the raw input of scripts/parity-cases.mjs build
 * for the dataverse-webapi surface.
 * Usage: node mirage/test/parity/capture-dataverse-webapi.mjs --hosted-f7 SUITE FIRST_RUN_DIR SECOND_RUN_DIR FIRST_OUT SECOND_OUT
 * The session sent every read as its application user with Prefer: odata.include-annotations="*". A case's input is its
 * path, the read record as `{record}` (the recorded `<record>`); the output is the projection `hostedDataverseOutput`
 * gives. Only the sharepointdocument reads enter a suite: the location and site reads carry the tenant's SharePoint URLs.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isEntryPoint } from '../../../lense/entry-point.mjs';

const SUITES = {
  // The three phases answer every sharepointdocument read alike (integration off); S0 and S1-loc are the two ends.
  'hosted-f7-sharepoint-documents': { files: ['dv-reads-s0.json', 'dv-reads-s1-loc.json'], keep: /^documents-/ },
};
export const HOSTED_F7_DATAVERSE_SUITES = Object.keys(SUITES);

const DETAILS = 'Microsoft.PowerApps.CDS.ErrorDetails.';
// The error annotations a case keeps: the raising plug-in and the message name, category and status; the step and
// activity ids are the organization's and the request's own.
const KEPT_DETAILS = [
  'ApiExceptionSourceKey',
  'ApiExceptionMessageName',
  'ApiExceptionCategory',
  'ApiExceptionHttpStatusCode',
];

/**
 * A Dataverse Web API answer in the portable shape the adapter answers: the status, then the error code, message and kept
 * annotations; the text of a /$count; an EntityDefinitions answer without its MetadataId, its columns as sorted
 * `name:type:readable` entries; or the context (without the origin), the count annotations and the rows (without ETags).
 */
export function hostedDataverseOutput({ status, body }) {
  const out = { status };
  if (body?.error) {
    out.error = { code: body.error.code, message: body.error.message };
    for (const name of KEPT_DETAILS)
      if (Object.hasOwn(body.error, `@${DETAILS}${name}`)) out.error[name] = body.error[`@${DETAILS}${name}`];
    return out;
  }
  if (typeof body === 'number' || typeof body === 'string') return { ...out, text: String(body) };
  const context = String(body?.['@odata.context'] ?? '').replace(/^https?:\/\/[^/]+/, '');
  if (body?.LogicalName && /EntityDefinitions/.test(context)) {
    const { MetadataId: _id, Attributes, '@odata.context': _context, ...table } = body;
    return {
      ...out,
      table,
      attributes: (Attributes ?? [])
        .map((a) => `${a.LogicalName}:${a.AttributeType}:${a.IsValidForRead}`)
        .sort((left, right) => (left < right ? -1 : Number(left > right))),
    };
  }
  return {
    ...out,
    context,
    total: body?.['@Microsoft.Dynamics.CRM.totalrecordcount'] ?? null,
    totalLimitExceeded: body?.['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'] ?? null,
    rows: (body?.value ?? []).map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== '@odata.etag')),
    ),
  };
}

/** One run (`runDir` = runs/<run>) as build input for `suite`. */
export function prepareHostedF7DataverseCapture(runDir, suite) {
  const spec = SUITES[suite];
  assert.ok(spec, `unknown hosted-f7 dataverse suite ${suite}`);
  const hash = createHash('sha256');
  const results = [];
  const dates = [];
  for (const name of spec.files) {
    const raw = fs.readFileSync(path.join(runDir, name));
    hash.update(name).update('\0').update(raw);
    const run = JSON.parse(raw.toString('utf8'));
    dates.push(run.recordedAt.slice(0, 10));
    const phase = name.replace(/^dv-reads-|\.json$/g, '');
    for (const result of run.results.filter((item) => spec.keep.test(item.id))) {
      const output = hostedDataverseOutput(result.output);
      const text = JSON.stringify(output);
      for (const guid of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])
        if (guid !== '00000000-0000-0000-0000-000000000001')
          throw new Error(`A recorded identifier would enter a case: ${guid}.`);
      results.push({
        id: `${phase}:${result.id}`,
        input: { method: 'GET', path: result.path.replaceAll('<record>', '{record}') },
        output,
      });
    }
  }
  return {
    capture: {
      id: `hosted-f7-${path.basename(runDir)}-${suite}`,
      capturedAt: dates.sort().at(-1),
      sha256: hash.digest('hex'),
    },
    results,
  };
}

if (isEntryPoint(import.meta.url)) {
  const [flag, suite, firstDir, secondDir, firstOut, secondOut, ...extra] = process.argv.slice(2);
  if (flag !== '--hosted-f7' || !SUITES[suite] || !firstDir || !secondDir || !firstOut || !secondOut || extra.length)
    throw new Error(
      'Usage: node mirage/test/parity/capture-dataverse-webapi.mjs --hosted-f7 SUITE FIRST_RUN_DIR SECOND_RUN_DIR FIRST_OUT SECOND_OUT\n' +
        `  SUITE: ${HOSTED_F7_DATAVERSE_SUITES.join(', ')}`,
    );
  const first = prepareHostedF7DataverseCapture(firstDir, suite);
  const second = prepareHostedF7DataverseCapture(secondDir, suite);
  fs.writeFileSync(firstOut, JSON.stringify(first, null, 2) + '\n');
  fs.writeFileSync(secondOut, JSON.stringify(second, null, 2) + '\n');
  process.stdout.write(`${first.results.length} cases\n`);
}
