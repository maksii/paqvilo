// Adapter for the dataverse-webapi surface: recorded Web API request on the invented specimen schema -> Mirage
// Dataverse Web API -> HTTP status and parsed JSON body. Only `input` drives the session; one session serves
// every case of a case file, as the native recording did.
import { specimenApi } from '../../support/specimen-api.mjs';

/**
 * Opens one invented-schema Web API session for a case file.
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<{ run: Function, close: Function }>} session whose run returns { status, body }
 */
export async function open(_context) {
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
