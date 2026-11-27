// Adapter for the dataverse-webapi surface: recorded Web API request on the invented specimen schema -> Mirage
// Dataverse Web API -> HTTP status and parsed JSON body. Only `input` drives the session; one session serves
// every case of a case file, as the native recording did.
// The hosted-f7-* suites (hosted session F7, 2026-11-27) run on an invented organization with the session's case table
// (pqf7_case) and no SharePoint storage (the session's integration was off), as an application user with
// Prefer: odata.include-annotations="*"; `{record}` names one invented case and the answer is projected as the converter
// (capture-dataverse-webapi.mjs hostedDataverseOutput) projected the recorded one.
import { specimenApi } from '../../support/specimen-api.mjs';
import { contractModuleFixture } from '../../contract-module-fixture.mjs';
import { EXTENSION as SHAREPOINT_DOCUMENTS } from '../../../lib/sharepoint-documents.mjs';
import { hostedDataverseOutput } from '../capture-dataverse-webapi.mjs';

const F7_RECORD = 'f7f7f7f7-0000-4000-8000-000000001001';

async function openHostedF7() {
  const cleanups = [];
  const { request } = await contractModuleFixture(
    { after: (fn) => cleanups.push(fn) },
    {
      mappings: {
        pqf7_case: {
          logicalName: 'pqf7_case',
          entitySet: 'pqf7_cases',
          idColumn: 'pqf7_caseid',
          nameColumn: 'pqf7_name',
          fields: { pqf7_name: { dataverseType: 'nvarchar' } },
        },
      },
      tables: { pqf7_case: [{ pqf7_caseid: F7_RECORD, pqf7_name: 'f7 a view first', statecode: 0, statuscode: 1 }] },
      extension: SHAREPOINT_DOCUMENTS,
      options: {},
    },
  );
  return {
    async run(input) {
      const response = await request(input.method, `/${input.path.replaceAll('{record}', F7_RECORD)}`, undefined, {
        prefer: 'odata.include-annotations="*"',
      });
      const text = await response.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        // A /$count answers text.
      }
      return hostedDataverseOutput({ status: response.status, body });
    },
    async close() {
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
}

/**
 * Opens one invented-schema Web API session for a case file.
 * @param {{ surface: string, suite: string }} context frozen names of the case file
 * @returns {Promise<{ run: Function, close: Function }>} session whose run returns { status, body }
 */
export async function open(context) {
  if (context?.suite?.startsWith('hosted-f7-')) return openHostedF7();
  const cleanups = [];
  const { request } = await specimenApi({ after: (fn) => cleanups.push(fn) });
  return {
    async run(input, _context) {
      const response = await request(`${input.collection}?${new URLSearchParams({ [input.key]: input.value })}`);
      return { status: response.status, body: await response.json() };
    },
    async close() {
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
}
