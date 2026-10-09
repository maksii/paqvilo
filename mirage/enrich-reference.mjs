import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DataStore, parseFetchXml } from './lib/data.mjs';
import { LiveBridge } from './lib/live.mjs';
import { collectFetchXmlPages, escapeXmlAttribute } from './lib/paging-validation.mjs';
import { assertOfflineState, stateFileFingerprint } from './lib/offline-state.mjs';

const serialize = node => `<${node.name}${Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`).join('')}>${escapeXmlAttribute(node.text ?? '')}${node.children.map(serialize).join('')}</${node.name}>`;

/** Read reference records, then persist every completed import in one state replacement. */
export async function enrichReference({ store, origin, cdpUrl, plan, bridge: suppliedBridge, beforeCommit }) {
  if (!Array.isArray(plan) || !plan.length || plan.length > 100) throw new Error('Supply 1–100 explicit table queries.');
  const entries = plan.map(entry => {
    const mapping = store.resolveMapping(entry.entity);
    const fetch = parseFetchXml(entry.fetchXml);
    const entity = fetch.children.find(node => node.name === 'entity');
    if (entity?.attrs.name !== mapping.logicalName || fetch.attrs.aggregate === 'true' || fetch.attrs.top) throw new Error('Enrichment requires a nonaggregate paged query for its mapped table.');
    const pageSize = entry.pageSize ?? 5000, maxPages = entry.maxPages ?? 10;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Enrichment page bounds are invalid.');
    if (entry.mode && !['merge', 'replace'].includes(entry.mode)) throw new Error('Enrichment mode must be merge or replace.');
    if (!entity.children.some(node => node.name === 'all-attributes' || (node.name === 'attribute' && node.attrs.name === mapping.idColumn))) entity.children.unshift({ name: 'attribute', attrs: { name: mapping.idColumn }, text: '', children: [] });
    return { entry, mapping, fetch, pageSize, maxPages };
  });
  if (new Set(entries.map(entry => entry.mapping.logicalName)).size !== entries.length) throw new Error('Each enrichment plan table may appear once.');
  const bridge = suppliedBridge ?? new LiveBridge({ origin, allowWrites: false });
  const baseline = JSON.stringify(store.snapshot());
  const observations = [];
  try {
    if (!suppliedBridge) await bridge.connect(cdpUrl);
    for (const { entry, mapping, fetch, pageSize, maxPages } of entries) {
      const collected = await collectFetchXmlPages({ idColumn: mapping.idColumn, pageSize, maxPages, readPage: async ({ page, cookie }) => {
        const query = structuredClone(fetch);
        query.attrs.count = String(pageSize); query.attrs.page = String(page);
        delete query.attrs['paging-cookie'];
        if (cookie) query.attrs['paging-cookie'] = cookie;
        return bridge.fetchXml(serialize(query), mapping);
      } });
      observations.push({ entry, mapping, ...collected });
    }
    if (JSON.stringify(store.snapshot()) !== baseline) throw new Error('Local state changed during reference reads; enrichment was not applied.');
    const state = store.snapshot();
    const provenance = [];
    for (const observation of observations) {
      const { entry, mapping, records, pages } = observation;
      const merged = new Map((entry.mode === 'replace' ? [] : state.tables[mapping.logicalName] ?? []).map(row => [String(row[mapping.idColumn]).toLowerCase(), row]));
      records.forEach(row => merged.set(row[mapping.idColumn].toLowerCase(), { ...merged.get(row[mapping.idColumn].toLowerCase()), ...row }));
      state.tables[mapping.logicalName] = [...merged.values()];
      provenance.push({ entity: mapping.logicalName, mode: entry.mode ?? 'merge', count: records.length, pages: pages.map(page => ({ page: page.page, count: page.count, moreRecords: page.moreRecords })), queryFingerprint: createHash('sha256').update(entry.fetchXml).digest('hex'), origin, complete: true });
    }
    state.simulator ??= {};
    state.simulator.referenceImports = [...(state.simulator.referenceImports ?? []), { time: new Date().toISOString(), tables: provenance }].slice(-100);
    if (beforeCommit) await beforeCommit();
    await store.replaceState(state, { expectedSnapshot: baseline });
    return { applied: true, complete: true, tables: provenance };
  } finally { if (!suppliedBridge) await bridge.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { state: { type: 'string' }, origin: { type: 'string' }, cdp: { type: 'string' }, plan: { type: 'string' } } });
    // Require an existing workspace; the command never fabricates source configuration.
    await assertOfflineState(values.state);
    const fingerprint = await stateFileFingerprint(values.state);
    const initial = JSON.parse(await fs.readFile(values.state, 'utf8'));
    const store = await new DataStore({ file: path.resolve(values.state), state: initial }).init();
    const report = await enrichReference({ store, origin: values.origin, cdpUrl: values.cdp, plan: JSON.parse(await fs.readFile(values.plan, 'utf8')), beforeCommit: async () => {
      await assertOfflineState(values.state);
      if (await stateFileFingerprint(values.state) !== fingerprint) throw new Error('State file changed during reference reads; enrichment was not applied.');
    } });
    console.log(JSON.stringify(report, null, 2));
  } catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
