import {
  guid,
  stable,
  sha256,
  encodeArtifact,
  decodeArtifact,
  authoredQuery,
  odataRequest,
  canonicalRows,
  compareResults,
  diffRows,
  diffObservation,
  assessScenario,
  pageComplete,
  parseLiquid,
  splitPayload,
} from './core.mjs';

// Async plugin commits arrive after the initiating HTTP response. Keep the owned
// probe until the operation's checksummed packets settle, without claiming durability.
export async function reconcileBackendArtifact({
  read,
  artifactType,
  stopped = () => false,
  timeoutMs = 120000,
  intervalMs = 1000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > timeoutMs
  )
    throw new Error('Invalid backend reconciliation bound.');
  const started = now();
  let events = [],
    attempts = 0,
    previous = null;
  const finish = (state, extra = {}) => ({ state, attempts, elapsedMs: now() - started, events, ...extra });
  while (now() - started < timeoutMs) {
    if (stopped()) return finish('stopped');
    const controller = new AbortController();
    let timer, response;
    try {
      response = await Promise.race([
        read({ signal: controller.signal }),
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error('Backend reconciliation deadline exceeded.'));
            },
            Math.max(1, timeoutMs - (now() - started)),
          );
        }),
      ]);
    } catch (error) {
      return finish(controller.signal.aborted ? 'timeout' : 'read-failed', { error: error.message });
    } finally {
      clearTimeout(timer);
    }
    attempts++;
    if (!response.ok) return finish('read-failed', { httpStatus: response.status, error: response.text });
    if (!Array.isArray(response.data?.value))
      return finish('read-failed', { error: 'Backend event envelope missing.' });
    events = response.data.value;
    if (
      response.data['@odata.nextLink'] ||
      response.data['@Microsoft.Dynamics.CRM.morerecords'] === true ||
      events.length >= 200
    )
      return finish('paging-incomplete');
    const groups = new Map();
    let valid = true;
    for (const event of events) {
      if (
        typeof event.pqvd_payloadtext !== 'string' ||
        (await sha256(event.pqvd_payloadtext)) !== event.pqvd_payloadhash
      )
        return finish('checksum-failed');
      if (
        !event.pqvd_spanid ||
        !event.pqvd_artifacttype ||
        !Number.isSafeInteger(event.pqvd_partcount) ||
        event.pqvd_partcount < 1 ||
        event.pqvd_partcount > 100 ||
        !Number.isSafeInteger(event.pqvd_partnumber) ||
        event.pqvd_partnumber < 1 ||
        event.pqvd_partnumber > event.pqvd_partcount
      )
        return finish('invalid-parts');
      const key = event.pqvd_spanid + ':' + event.pqvd_artifacttype;
      groups.set(key, [...(groups.get(key) || []), event]);
    }
    for (const group of groups.values())
      if (
        group.length !== group[0].pqvd_partcount ||
        new Set(group.map((e) => e.pqvd_partnumber)).size !== group.length ||
        group.some((e) => e.pqvd_partcount !== group[0].pqvd_partcount)
      )
        valid = false;
    const fingerprint = stable(
      events
        .map((e) => [e.pqvd_plugineventid, e.pqvd_payloadhash, e.pqvd_partnumber, e.pqvd_partcount])
        .sort((a, b) => stable(a).localeCompare(stable(b))),
    );
    if (valid && events.some((e) => e.pqvd_artifacttype === artifactType) && fingerprint === previous)
      return finish('observed');
    previous = valid ? fingerprint : null;
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (now() - started))));
  }
  return finish('timeout');
}

// `clock` ({ now, sleep }) replaces the wall clock of backend reconciliation; tests pass a virtual one.
export function createRunner({ manifest, context, request, notify = () => {}, stopped = () => false, clock = {} }) {
  const originalRequest = request;
  request = (args) => {
    if (!args.body) return originalRequest(args);
    const entitySet = args.url.match(/^\/_api\/(\w+)/)?.[1],
      body = {};
    for (const [key, value] of Object.entries(args.body)) {
      if (!key.endsWith('@odata.bind')) {
        body[key] = value;
        continue;
      }
      const field = key.slice(0, -11),
        nav = manifest.navigation?.[entitySet]?.[field];
      if (manifest.navigation && !nav) throw new Error(`Verified binding metadata unavailable: ${entitySet}.${field}`);
      body[(nav || field) + '@odata.bind'] = value;
    }
    return originalRequest({ ...args, body });
  };
  const choice = (name, label) => {
    const value = manifest.choices[name]?.[label];
    if (value === undefined) throw new Error(`Unknown choice ${name}/${label}`);
    return value;
  };
  const bind = (table, id) => `/${table}(${guid(id)})`;
  let runId,
    evidence = [],
    residuals = [],
    running = false;
  const artifactTransportBudgetBytes = manifest.artifactTransportBudgetBytes ?? 20 * 1024 * 1024;
  if (!Number.isSafeInteger(artifactTransportBudgetBytes) || artifactTransportBudgetBytes <= 0)
    throw new Error('Invalid artifact transport budget.');
  let artifactTransportBytes = 0;
  async function backendEvents(operationId, signal, fresh = false) {
    const fields = [
      'pqvd_plugineventid',
      'pqvd_stage',
      'pqvd_executionorder',
      'pqvd_depth',
      'pqvd_querytype',
      'pqvd_artifacttype',
      'pqvd_payloadtext',
      'pqvd_payloadhash',
      'pqvd_spanid',
      'pqvd_parentspanid',
      'pqvd_partnumber',
      'pqvd_partcount',
      'pqvd_message',
    ];
    // Power Pages can retain an earlier query response even with cache:no-store.
    // A nonnull primary key always satisfies EQ OR NE; only the cache key varies.
    const nonce = fresh ? crypto.randomUUID() : null,
      freshness = nonce
        ? `<filter type="or"><condition attribute="pqvd_plugineventid" operator="eq" value="${nonce}"></condition><condition attribute="pqvd_plugineventid" operator="ne" value="${nonce}"></condition></filter>`
        : '';
    const xml = `<fetch count="200"><entity name="pqvd_pluginevent">${fields.map((f) => `<attribute name="${f}"></attribute>`).join('')}<filter><condition attribute="pqvd_operationid" operator="eq" value="${guid(operationId)}"></condition>${freshness}</filter><order attribute="pqvd_plugineventid"></order></entity></fetch>`;
    return request({ url: `/_api/pqvd_pluginevents?fetchXml=${encodeURIComponent(xml)}`, signal });
  }
  const actor = () => sha256({ contactId: context.contactId, roles: [...context.roles].sort() });
  async function create(table, body) {
    const response = await request({ url: `/_api/${table}`, method: 'POST', body });
    if (!response.ok) throw Object.assign(new Error(`Recorder ${table}: HTTP ${response.status}`), { response });
    const id = response.entityId || response.data?.[table.slice(0, -1) + 'id'];
    if (!id) throw new Error(`Create ${table} succeeded without returned entityid; commit cannot be inferred.`);
    return guid(id);
  }
  async function record(plan, operationId, engine, artifacts, meta = {}) {
    const observationKey = await sha256(`${operationId}:${meta.page || 1}:${meta.kind || 'read'}`);
    const fingerprint = await actor();
    for (const [kind, payload] of Object.entries(artifacts)) {
      const text = typeof payload === 'string' ? payload : stable(payload),
        parts = splitPayload(await encodeArtifact(text, kind.includes('Xml') ? 'application/xml' : 'application/json'));
      // Include encoding overhead and a conservative per-row metadata allowance before any part writes.
      const transportBytes = parts.reduce((n, p) => n + new TextEncoder().encode(p).length + 2048, 0);
      if (artifactTransportBytes + transportBytes > artifactTransportBudgetBytes) {
        const error = {
          kind: 'persistence-error',
          caseId: plan.id,
          operationId,
          artifact: kind,
          error: 'Client artifact transport budget exceeded.',
          limitBytes: artifactTransportBudgetBytes,
          estimatedUsedBytes: artifactTransportBytes,
          rejectedBytes: transportBytes,
        };
        evidence.push(error);
        notify(error);
        continue;
      }
      artifactTransportBytes += transportBytes;
      for (let i = 0; i < parts.length; i++) {
        try {
          await create('pqvd_testresults', {
            pqvd_name: `${plan.id} ${engine} ${kind} ${i + 1}`,
            'pqvd_runid@odata.bind': bind('pqvd_testruns', runId),
            'pqvd_operationid@odata.bind': bind('pqvd_testoperations', operationId),
            pqvd_observationkey: observationKey,
            pqvd_caseid: plan.id,
            pqvd_variant: plan.variant || 'fetchxml',
            pqvd_engine: choice('pqvd_engine', engine === 'liquid' ? 'Liquid' : 'WebAPI'),
            pqvd_phase: choice('pqvd_phase', meta.phase || 'Baseline'),
            pqvd_operation: choice('pqvd_operation', meta.operation || 'Read'),
            pqvd_artifactkind: choice('pqvd_artifactkind', kind),
            pqvd_attempt: 1,
            pqvd_pagenumber: meta.page || 1,
            pqvd_partnumber: i + 1,
            pqvd_partcount: parts.length,
            pqvd_httpstatus: meta.httpStatus ?? 0,
            pqvd_verdict: choice('pqvd_verdict', 'Incomplete'),
            pqvd_recordcount: meta.count || 0,
            pqvd_durationms: Math.round(meta.duration || 0),
            pqvd_capturetime: new Date().toISOString(),
            pqvd_contenttype: 'application/vnd.paqvilo.artifact+json',
            pqvd_payloadtext: parts[i],
            pqvd_payloadhash: await sha256(parts[i]),
            pqvd_actorfingerprint: fingerprint,
          });
        } catch (error) {
          evidence.push({
            kind: 'persistence-error',
            caseId: plan.id,
            operationId,
            artifact: kind,
            part: i + 1,
            error: error.message,
            httpStatus: error.response?.status,
            rawResponse: error.response?.text,
          });
          notify(evidence.at(-1));
        }
      }
    }
  }
  async function operation(
    plan,
    engine,
    pairId,
    page = 1,
    { phase = 'Baseline', message = 'RetrieveMultiple', variant = plan.variant || 'fetchxml' } = {},
  ) {
    const id = await create('pqvd_testoperations', {
      pqvd_name: `${plan.id} ${engine} page ${page}`,
      'pqvd_runid@odata.bind': bind('pqvd_testruns', runId),
      pqvd_pairkey: pairId,
      pqvd_caseid: plan.id,
      pqvd_lane: choice('pqvd_testlane', engine === 'liquid' ? 'Liquid' : 'WebAPI'),
      pqvd_variant: variant,
      pqvd_phase: choice('pqvd_phase', phase),
      pqvd_attempt: 1,
      pqvd_pagenumber: page,
      pqvd_expectedmessage: message,
      pqvd_roottable: plan.table,
    });
    const response = await request({
      url: `/_api/pqvd_testoperations(${id})?$select=pqvd_testoperationid,pqvd_markerutc,pqvd_markeroperation,pqvd_markertime`,
    });
    if (!response.ok) throw new Error(`Operation ${id} stamp read failed HTTP ${response.status}`);
    return { ...response.data, pqvd_testoperationid: id, runId };
  }
  async function lane(plan, engine, pairId) {
    if (!plan.fragments) return laneOne(plan, engine, pairId);
    const fragments = [];
    for (const fragment of plan.fragments) {
      fragments.push(await laneOne(fragment, engine, pairId));
      if (stopped() || fragments.at(-1).outcome !== 'success') break;
    }
    const rows = fragments.flatMap((f) => f.rows).sort((a, b) => stable(a).localeCompare(stable(b))),
      ids = [...new Set(rows.map((r) => r[plan.primaryId]).filter(Boolean))].sort();
    return {
      caseId: plan.id,
      engine,
      variant: plan.variant,
      logicalQueryHash: plan.logicalQueryHash,
      outcome: fragments.every((f) => f.outcome === 'success') ? 'success' : 'error',
      error:
        fragments
          .filter((f) => f.error)
          .map((f) => f.error)
          .join('; ') || null,
      complete: fragments.length === plan.fragments.length && fragments.every((f) => f.complete),
      rows,
      ids,
      returnedCount: rows.length,
      uniqueIdCount: ids.length,
      pages: fragments.flatMap((f) => f.pages.map((p) => ({ ...p, fragment: f.variant }))),
      fragments: fragments.map((f) => ({ variant: f.variant, outcome: f.outcome, complete: f.complete })),
      pagingDuplicates: fragments.flatMap((f) => f.pagingDuplicates),
      canonicalHash: await sha256(rows),
    };
  }
  async function laneOne(plan, engine, pairId) {
    const rows = [],
      pages = [],
      seenPages = new Map(),
      pagingDuplicates = [];
    let complete = false,
      outcome = 'success',
      error = null;
    for (let page = 1; page <= 20; page++) {
      if (stopped()) {
        outcome = 'stopped';
        break;
      }
      let op, xml, response;
      const start = performance.now();
      try {
        op = await operation(plan, engine, pairId, page);
        xml = plan.queryType === 'odata' ? odataRequest(plan, op) : authoredQuery(plan, op, page);
        const intent = await request({
          method: 'PATCH',
          url: `/_api/pqvd_testoperations(${op.pqvd_testoperationid})`,
          body: {
            pqvd_authoredquery: xml,
            pqvd_logicalqueryhash: plan.logicalQueryHash,
            pqvd_physicalqueryhash: await sha256(xml),
          },
        });
        if (!intent.ok) throw new Error('Authored intent persistence failed.');
        response = await request({
          url:
            engine === 'liquid'
              ? `/permission-lab/liquid/?suiteVersion=${encodeURIComponent(manifest.suiteVersion)}&operationId=${op.pqvd_testoperationid}`
              : plan.queryType === 'odata'
                ? xml
                : `/_api/${plan.entitySet}?fetchXml=${encodeURIComponent(xml)}`,
        });
        if (!response.ok) throw Object.assign(new Error(`${engine} HTTP ${response.status}`), { response });
        const parsed =
          engine === 'liquid'
            ? parseLiquid(response.text, plan)
            : {
                rows: response.data?.value,
                more: response.data?.['@Microsoft.Dynamics.CRM.morerecords'],
                cookie: response.data?.['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'],
                nextLink: response.data?.['@odata.nextLink'],
                effectiveFetchXml: null,
              };
        if (!Array.isArray(parsed.rows))
          throw new Error('Missing records collection; response is not an empty success.');
        if (
          engine === 'liquid' &&
          (parsed.contactId !== guid(context.contactId) ||
            stable([...parsed.roles].sort()) !== stable([...context.roles].sort()) ||
            parsed.operationId !== op.pqvd_testoperationid ||
            parsed.caseId !== plan.id ||
            parsed.datasetVersion !== manifest.datasetVersion)
        )
          throw new Error('Identity/dataset/intent drift between shell and Liquid response.');
        if (engine === 'liquid' && parsed.authoredFetchXml.trim() !== xml.trim())
          throw new Error('Liquid authored query differs from shared manifest intent.');
        const canonical = canonicalRows(parsed.rows, plan);
        for (const row of canonical) {
          const key = stable(row);
          if (seenPages.has(key) && seenPages.get(key) !== page)
            pagingDuplicates.push({ firstPage: seenPages.get(key), page, row });
          else seenPages.set(key, page);
        }
        rows.push(...canonical);
        const pageEvidence = {
          page,
          operationId: op.pqvd_testoperationid,
          physicalQueryHash: await sha256(xml),
          authoredFetchXml: plan.queryType === 'odata' ? null : xml,
          authoredRequest: plan.queryType === 'odata' ? xml : null,
          authoredJoinCount: plan.queryType === 'odata' ? null : (xml.match(/<link-entity\b/g) || []).length,
          effectiveJoinCount: parsed.effectiveFetchXml
            ? (parsed.effectiveFetchXml.match(/<link-entity\b/g) || []).length
            : null,
          httpStatus: response.status,
          count: canonical.length,
          more: parsed.more ?? null,
          cookie: parsed.cookie || null,
          urlLength: response.url?.length || 0,
          duration: performance.now() - start,
          effectiveFetchXml: parsed.effectiveFetchXml || null,
          effectiveXmlAvailability: engine === 'liquid' ? 'exposed' : 'not-exposed',
          backendCaptureState: manifest.readiness.durableCollector ? 'pending' : 'transaction-bound-lab-only',
        };
        pages.push(pageEvidence);
        await record(
          plan,
          op.pqvd_testoperationid,
          engine,
          {
            Summary: pageEvidence,
            [plan.queryType === 'odata' ? 'Request' : 'AuthoredXml']: xml,
            RawResponse: response.text,
            CanonicalResult: canonical,
            ...(engine === 'liquid' ? { EffectiveXml: parsed.effectiveFetchXml || '' } : {}),
          },
          { page, httpStatus: response.status, count: canonical.length, duration: pageEvidence.duration },
        );
        if (plan.queryType === 'odata') {
          complete = !parsed.nextLink && response.data['@odata.count'] === canonical.length;
          if (!complete) pageEvidence.continuationState = 'native-paging-contract-not-qualified';
          break;
        }
        if (
          pageComplete({
            more: parsed.more,
            rowCount: canonical.length,
            pageSize: plan.pageSize,
            nextLink: parsed.nextLink,
          })
        ) {
          complete = true;
          break;
        }
        // Number paging retains deterministic ordering. A full terminal page without MORE requires an empty next-page proof.
      } catch (e) {
        outcome = 'error';
        error = e.message;
        const failedResponse = e.response || response;
        const failure = {
          page,
          error,
          httpStatus: failedResponse?.status || null,
          body: failedResponse?.text || e.rawLiquidResponse || null,
          effectiveFetchXml: e.effectiveFetchXml || null,
          urlLength: failedResponse?.url?.length || null,
          operationId: op?.pqvd_testoperationid || null,
        };
        pages.push(failure);
        if (op)
          await record(
            plan,
            op.pqvd_testoperationid,
            engine,
            {
              Summary: failure,
              RawResponse: failedResponse?.text || e.rawLiquidResponse || '',
              ...(e.effectiveFetchXml ? { EffectiveXml: e.effectiveFetchXml } : {}),
              ...(xml ? { [plan.queryType === 'odata' ? 'Request' : 'AuthoredXml']: xml } : {}),
            },
            { page, httpStatus: failedResponse?.status || 0 },
          );
        break;
      }
    }
    rows.sort((a, b) => stable(a).localeCompare(stable(b)));
    const ids = [...new Set(rows.map((r) => r[plan.primaryId]).filter(Boolean))].sort();
    if (pagingDuplicates.length) complete = false;
    return {
      caseId: plan.id,
      engine,
      variant: plan.variant,
      logicalQueryHash: plan.logicalQueryHash,
      outcome,
      error,
      complete,
      pagingDuplicates,
      rows,
      ids,
      returnedCount: rows.length,
      uniqueIdCount: ids.length,
      pages,
      canonicalHash: await sha256(rows),
    };
  }
  async function run(options = {}) {
    if (running) throw new Error('A run is already in progress on this runner.');
    running = true;
    runId = undefined;
    evidence = [];
    residuals = [];
    artifactTransportBytes = 0;
    try {
      return await runInner(options);
    } finally {
      running = false;
    }
  }
  async function runInner({
    crud = false,
    crudMode = 'all',
    selectedCases = manifest.cases.map((c) => c.id),
    baselineId = null,
    pluginProfile = null,
  } = {}) {
    if (!context.contactId || !context.roles.includes('CO Test Runner'))
      throw new Error('Sign in with a Contact assigned CO Test Runner.');
    if (!manifest.readiness.operationGuard)
      throw new Error('OperationIntentGuard not qualified: recording/query correlation is blocked.');
    const key = crypto.randomUUID();
    runId = await create('pqvd_testruns', {
      pqvd_name: `CO Lab ${new Date().toISOString()}`,
      pqvd_runkey: key,
      'pqvd_runnercontactid@odata.bind': bind('contacts', context.contactId),
      ...(baselineId ? { 'pqvd_baselinerunid@odata.bind': bind('pqvd_testruns', baselineId) } : {}),
      pqvd_suiteversion: manifest.suiteVersion,
      pqvd_manifesthash: manifest.manifestHash,
      pqvd_datasetversion: manifest.datasetVersion,
      pqvd_sourcehash: manifest.sourceHash || null,
      pqvd_environment: 'Company Operations Demo',
      pqvd_startedat: new Date().toISOString(),
      pqvd_runstate: choice('pqvd_runstate', 'Running'),
      pqvd_rolesnapshot: stable(context.roles),
    });
    notify({
      kind: 'run-started',
      runId,
      contactId: context.contactId,
      roles: context.roles,
      datasetVersion: manifest.datasetVersion,
      manifestHash: manifest.manifestHash,
      sourceHash: manifest.sourceHash,
    });
    const pairs = [];
    try {
      for (const plan of [...manifest.cases, ...(manifest.stressCases || [])].filter((c) =>
        selectedCases.includes(c.id),
      )) {
        if (stopped()) break;
        const pairId = crypto.randomUUID();
        const liquid = await lane(plan, 'liquid', pairId),
          webapi = await lane(plan, 'webapi', pairId);
        const verdict = compareResults(liquid, webapi);
        const pair = { caseId: plan.id, pairId, liquid, webapi, verdict };
        pairs.push(pair);
        notify(pair);
      }
      const variants = [];
      for (const plan of (manifest.odataVariants || []).filter((p) => selectedCases.includes(p.baseCaseId))) {
        if (stopped()) break;
        const result = await lane(plan, 'webapi', crypto.randomUUID());
        variants.push(result);
        notify({ caseId: plan.id, kind: 'API-only OData variant', ...result });
      }
      const observations = pairs.map((p) => p.webapi);
      const oracle = manifest.scenarios
        .filter((s) => guid(s.contactId) === guid(context.contactId))
        .map((s) => ({ scenario: s.id, assertions: assessScenario(s, observations, manifest) }));
      if (crud) await runCrud(crudMode);
      if (pluginProfile) await runPluginProfile(pluginProfile);
      for (const pair of pairs)
        for (const laneResult of [pair.liquid, pair.webapi])
          for (const page of laneResult.pages) {
            if (!page.operationId) continue;
            try {
              const result = await backendEvents(page.operationId);
              page.backendEvents = result.ok ? result.data.value : [];
              page.backendCaptureState =
                result.ok && page.backendEvents.length
                  ? 'transaction-bound-observed'
                  : result.ok
                    ? 'no-backend-invocation-observed'
                    : 'backend-evidence-read-failed';
              if (!result.ok) page.backendError = { status: result.status, body: result.text };
            } catch (error) {
              page.backendCaptureState = 'backend-evidence-read-failed';
              page.backendError = error.message;
            }
          }
      const fixtureOracle = manifest.visibilityOracle?.find((o) => guid(o.contactId) === guid(context.contactId));
      const visibilityAssertions =
        fixtureOracle?.cases.map((expected) => {
          const pair = pairs.find((p) => p.caseId === expected.caseId);
          return {
            caseId: expected.caseId,
            expectedIds: expected.expectedIds,
            kind: fixtureOracle.kind,
            runtimeAttested: false,
            lanes: pair
              ? [pair.liquid, pair.webapi].map((result) => ({
                  engine: result.engine,
                  verdict:
                    !result.complete || result.outcome !== 'success'
                      ? 'incomplete'
                      : stable(result.ids) === stable(expected.expectedIds) &&
                          result.rows.length === expected.expectedIds.length
                        ? 'pass'
                        : 'fail',
                  actualIds: result.ids,
                  actualRowCount: result.rows.length,
                  expectedRowCount: expected.expectedIds.length,
                }))
              : [],
          };
        }) || [];
      const linkedAssertions = [];
      for (const [prefix, field, allowedCase] of [
        ['R25', 'engagementid', 'R05'],
        ['R26', 'scopedaccountid', 'R01'],
        ['R30', 'financeid', 'R11'],
      ]) {
        const allowed = fixtureOracle?.cases.find((c) => c.caseId === allowedCase)?.expectedIds;
        for (const pair of pairs.filter((p) => p.caseId.startsWith(prefix)))
          for (const result of [pair.liquid, pair.webapi]) {
            const disclosed = [...new Set(result.rows.map((r) => r[field]).filter(Boolean))],
              outside = allowed ? disclosed.filter((id) => !allowed.includes(id)) : [];
            linkedAssertions.push({
              caseId: pair.caseId,
              engine: result.engine,
              field,
              kind: 'independent-linked-record-eligibility',
              verdict:
                !allowed || !result.complete || result.outcome !== 'success'
                  ? 'incomplete'
                  : outside.length
                    ? 'fail'
                    : 'pass',
              outsideScopeIds: outside,
            });
          }
      }
      const baseline = baselineId ? await compareBaseline(baselineId, pairs) : null;
      const summary = {
        artifactTransport: {
          limitBytes: artifactTransportBudgetBytes,
          estimatedUsedBytesBeforeSummary: artifactTransportBytes,
          accounting:
            'Encoded payload plus conservative 2048-byte per-row metadata allowance; combined client/server quota requires external collector qualification.',
        },
        runId,
        datasetVersion: manifest.datasetVersion,
        manifestHash: manifest.manifestHash,
        sourceHash: manifest.sourceHash,
        configuration: {
          kind: 'Desired portable configuration; independent native readback required',
          permissionBlueprintHash: manifest.configuredPermissionBlueprintHash,
        },
        contactId: context.contactId,
        roles: context.roles,
        pairs,
        variants,
        oracle,
        visibilityAssertions,
        linkedAssertions,
        baseline,
        coverage: {
          strictPaired: pairs.length,
          durableBackend: manifest.readiness.durableCollector,
          businessCrud: crud && manifest.readiness.businessMutation,
        },
        evidence,
        residuals,
      };
      const summaryPlan = { id: 'RUN-SUMMARY', table: 'pqvd_testrun', variant: 'run-summary' };
      const summaryOperation = await operation(summaryPlan, 'webapi', crypto.randomUUID(), 1, {
        phase: 'Comparison',
        message: 'Update',
      });
      await record(
        summaryPlan,
        summaryOperation.pqvd_testoperationid,
        'webapi',
        { Summary: summary },
        { phase: 'Comparison', operation: 'Compare' },
      );
      const state = stopped()
        ? 'Interrupted'
        : !manifest.readiness.durableCollector ||
            evidence.some((e) => /(error|incomplete)/.test(e.kind || '') || e.kind === 'blocked') ||
            pairs.some((p) => p.verdict === 'incomplete')
          ? 'Incomplete'
          : 'Completed';
      const compact = {
        runId,
        datasetVersion: manifest.datasetVersion,
        contactId: context.contactId,
        roles: context.roles,
        summaryOperationId: summaryOperation.pqvd_testoperationid,
        pairs: pairs.map((p) => ({
          caseId: p.caseId,
          verdict: p.verdict,
          liquidCount: p.liquid.returnedCount,
          webApiCount: p.webapi.returnedCount,
        })),
        variants: variants.map((v) => ({ caseId: v.caseId, outcome: v.outcome, complete: v.complete, error: v.error })),
        oracle,
        visibilityAssertions: visibilityAssertions.map((a) => ({
          caseId: a.caseId,
          kind: a.kind,
          lanes: a.lanes.map((l) => ({ engine: l.engine, verdict: l.verdict })),
        })),
        baseline,
        evidenceCounts: {
          total: evidence.length,
          persistenceErrors: evidence.filter((e) => e.kind === 'persistence-error').length,
          blocked: evidence.filter((e) => e.kind === 'blocked').length,
        },
        residuals,
      };
      const compactText = stable(compact);
      if (compactText.length > 60000)
        throw new Error('Run index exceeds safe summary bound; full summary parts have been saved separately.');
      const response = await request({
        method: 'PATCH',
        url: `/_api/pqvd_testruns(${runId})`,
        body: {
          pqvd_finishedat: new Date().toISOString(),
          pqvd_runstate: choice('pqvd_runstate', state),
          pqvd_summaryjson: compactText,
        },
      });
      if (!response.ok) {
        summary.persistenceError = `Final history PATCH HTTP ${response.status}`;
        summary.completeness = 'incomplete';
        evidence.push({ kind: 'persistence-error', phase: 'RunIndex', status: response.status, body: response.text });
        notify(summary);
      }
      return summary;
    } catch (error) {
      const summary = { runId, error: error.message, pairs, evidence, residuals };
      try {
        const plan = { id: 'RUN-FAILURE', table: 'pqvd_testrun', variant: 'run-failure' },
          op = await operation(plan, 'webapi', crypto.randomUUID(), 1, { phase: 'Comparison', message: 'Update' });
        await record(
          plan,
          op.pqvd_testoperationid,
          'webapi',
          { Summary: summary },
          { phase: 'Comparison', operation: 'Compare' },
        );
        summary.failureOperationId = op.pqvd_testoperationid;
      } catch (persistenceError) {
        summary.failurePartsError = persistenceError.message;
      }
      const index = {
        runId,
        error: String(error.message).slice(0, 2000),
        failureOperationId: summary.failureOperationId || null,
        failurePartsError: summary.failurePartsError || null,
        pairedCaseCount: pairs.length,
        evidenceCount: evidence.length,
        residuals: residuals.slice(0, 100),
      };
      try {
        const response = await request({
          method: 'PATCH',
          url: `/_api/pqvd_testruns(${runId})`,
          body: {
            pqvd_finishedat: new Date().toISOString(),
            pqvd_runstate: choice('pqvd_runstate', 'Incomplete'),
            pqvd_summaryjson: stable(index),
          },
        });
        if (!response.ok) summary.persistenceError = { status: response.status, body: response.text };
      } catch (persistenceError) {
        summary.persistenceError = persistenceError.message;
      }
      notify(summary);
      return summary;
    }
  }
  async function runPluginProfile(profile) {
    if (!manifest.pluginProfiles?.some((p) => p.id === profile)) throw new Error('Unknown plugin profile.');
    if (!manifest.readiness.pipelineProfiles?.includes(profile)) {
      evidence.push({ kind: 'blocked', profile, reason: 'Profile/dependencies not live-qualified.' });
      return;
    }
    const plan = { id: profile, table: 'pqvd_crudprobe', variant: 'pipeline-profile' };
    let probeId;
    try {
      const op = await operation(plan, 'webapi', crypto.randomUUID(), 1, { phase: 'CRUD', message: 'Update' });
      probeId = await create('pqvd_crudprobes', {
        pqvd_name: `CO ${profile} Probe`,
        pqvd_token: crypto.randomUUID(),
        'pqvd_ownercontactid@odata.bind': bind('contacts', context.contactId),
        'pqvd_runid@odata.bind': bind('pqvd_testruns', runId),
        pqvd_value: 'pipeline',
        pqvd_counter: 0,
      });
      residuals.push(probeId);
      const body = {
        'pqvd_activeoperationid@odata.bind': bind('pqvd_testoperations', op.pqvd_testoperationid),
        pqvd_triggernonce: crypto.randomUUID(),
        pqvd_pluginscenario: profile,
        pqvd_hopbudget: profile === 'P09' ? 9 : 3,
      };
      const response = await request({ method: 'PATCH', url: `/_api/pqvd_crudprobes(${probeId})`, body });
      const result = {
        profile,
        operationId: op.pqvd_testoperationid,
        probeId,
        status: response.status,
        response: response.text,
        rollbackEvidenceMode: 'transaction-bound; failure may remove backend logs',
      };
      evidence.push(result);
      if (profile === 'P10' && response.ok) {
        const reconciled = await reconcileBackendArtifact({
          read: ({ signal }) => backendEvents(op.pqvd_testoperationid, signal, true),
          artifactType: 'AsyncContext',
          stopped,
          ...clock,
        });
        const { events, ...state } = reconciled;
        result.backendEvents = events;
        result.backendReconciliation = state;
        if (state.state !== 'observed')
          evidence.push({
            kind: 'profile-backend-incomplete',
            profile,
            operationId: op.pqvd_testoperationid,
            ...state,
          });
      } else {
        const events = await backendEvents(op.pqvd_testoperationid);
        result.backendEvents = events.ok ? events.data.value : [];
      }
      await record(
        plan,
        op.pqvd_testoperationid,
        'webapi',
        { Summary: result, Request: body, RawResponse: response.text },
        { phase: 'CRUD', operation: 'Update', httpStatus: response.status },
      );
      // Chain rows retain Restrict links to their root operation. The disposable probe alone is safe to clean.
      notify(result);
    } catch (error) {
      evidence.push({
        kind: 'profile-error',
        profile,
        probeId,
        error: error.message,
        httpStatus: error.response?.status,
        rawResponse: error.response?.text,
      });
    } finally {
      if (probeId && residuals.includes(probeId)) {
        try {
          const cleanupPlan = { ...plan, id: `${profile}-cleanup` },
            cleanupOp = await operation(cleanupPlan, 'webapi', crypto.randomUUID(), 1, {
              phase: 'Cleanup',
              message: 'Delete',
            }),
            url = `/_api/pqvd_crudprobes(${probeId})`;
          await record(
            cleanupPlan,
            cleanupOp.pqvd_testoperationid,
            'webapi',
            { Request: { method: 'DELETE', url, probeId } },
            { phase: 'Cleanup', operation: 'Delete' },
          );
          const cleanup = await request({ method: 'DELETE', url }),
            result = {
              kind: cleanup.ok ? 'profile-cleanup' : 'profile-cleanup-error',
              profile,
              probeId,
              operationId: cleanupOp.pqvd_testoperationid,
              status: cleanup.status,
              rawResponse: cleanup.text,
            };
          evidence.push(result);
          await record(
            cleanupPlan,
            cleanupOp.pqvd_testoperationid,
            'webapi',
            { Cleanup: result, RawResponse: cleanup.text },
            { phase: 'Cleanup', operation: 'Delete', httpStatus: cleanup.status },
          );
          if (cleanup.ok) residuals.splice(residuals.indexOf(probeId), 1);
        } catch (error) {
          evidence.push({ kind: 'profile-cleanup-error', profile, probeId, error: error.message });
        }
      }
    }
  }
  async function compareBaseline(baselineId, pairs) {
    try {
      const previous = await request({
        url: `/_api/pqvd_testruns(${guid(baselineId)})?$select=pqvd_datasetversion,pqvd_rolesnapshot,pqvd_manifesthash`,
      });
      if (!previous.ok) throw new Error(`Baseline read HTTP ${previous.status}`);
      if (
        previous.data.pqvd_datasetversion !== manifest.datasetVersion ||
        previous.data.pqvd_rolesnapshot !== stable(context.roles) ||
        previous.data.pqvd_manifesthash !== manifest.manifestHash
      )
        return { baselineId, verdict: 'identity/dataset-drift' };
      const verified = await loadRecordedRun(baselineId);
      if (!verified.summary?.pairs)
        throw new Error(
          'Complete verified baseline summary unavailable; outcome comparison cannot be inferred from missing canonical parts.',
        );
      const selected = [
        'pqvd_testresultid',
        'pqvd_caseid',
        'pqvd_engine',
        'pqvd_observationkey',
        'pqvd_partnumber',
        'pqvd_partcount',
        'pqvd_payloadtext',
        'pqvd_payloadhash',
      ];
      const parts = [];
      let complete = false;
      for (let page = 1; page <= 30; page++) {
        const xml = `<fetch count="100" page="${page}"><entity name="pqvd_testresult">${selected.map((f) => `<attribute name="${f}"></attribute>`).join('')}<filter><condition attribute="pqvd_runid" operator="eq" value="${guid(baselineId)}"></condition><condition attribute="pqvd_artifactkind" operator="eq" value="${choice('pqvd_artifactkind', 'CanonicalResult')}"></condition></filter><order attribute="pqvd_testresultid"></order></entity></fetch>`,
          response = await request({ url: `/_api/pqvd_testresults?fetchXml=${encodeURIComponent(xml)}` });
        if (!response.ok) throw new Error(`Baseline artifacts HTTP ${response.status}: ${response.text}`);
        if (!Array.isArray(response.data?.value)) throw new Error('Baseline artifact envelope missing.');
        parts.push(...response.data.value);
        if (
          pageComplete({
            more: response.data['@Microsoft.Dynamics.CRM.morerecords'],
            rowCount: response.data.value.length,
            pageSize: 100,
            nextLink: response.data['@odata.nextLink'],
          })
        ) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new Error('Baseline paging incomplete.');
      const groups = new Map();
      for (const part of parts) {
        if ((await sha256(part.pqvd_payloadtext)) !== part.pqvd_payloadhash)
          throw new Error('Baseline part checksum mismatch.');
        const key = part.pqvd_observationkey;
        groups.set(key, [...(groups.get(key) || []), part]);
      }
      const oldRows = new Map();
      for (const group of groups.values()) {
        group.sort((a, b) => a.pqvd_partnumber - b.pqvd_partnumber);
        if (
          group.length !== group[0].pqvd_partcount ||
          group.some(
            (p, i) =>
              p.pqvd_partnumber !== i + 1 ||
              p.pqvd_partcount !== group.length ||
              p.pqvd_caseid !== group[0].pqvd_caseid ||
              p.pqvd_engine !== group[0].pqvd_engine,
          )
        )
          throw new Error('Missing, duplicated or mixed baseline payload part.');
        const payload = JSON.parse(await decodeArtifact(group.map((p) => p.pqvd_payloadtext).join('')));
        if (!Array.isArray(payload)) throw new Error('Baseline canonical payload must be an array.');
        const key = group[0].pqvd_caseid + ':' + group[0].pqvd_engine;
        oldRows.set(key, [...(oldRows.get(key) || []), ...payload]);
      }
      const differences = pairs.flatMap((pair) =>
        [pair.liquid, pair.webapi].map((result) => {
          const prior = oldRows.get(
              result.caseId + ':' + choice('pqvd_engine', result.engine === 'liquid' ? 'Liquid' : 'WebAPI'),
            ),
            plan = [...manifest.cases, ...(manifest.stressCases || [])].find((c) => c.id === result.caseId);
          const previousLane = verified.summary.pairs.find((p) => p.caseId === result.caseId)?.[
            result.engine === 'liquid' ? 'liquid' : 'webapi'
          ];
          return {
            caseId: result.caseId,
            engine: result.engine,
            ...(previousLane && plan
              ? diffObservation(previousLane, result, plan)
              : { outcomeVerdict: 'missing-baseline-lane' }),
            verdict: !prior
              ? 'missing-baseline'
              : !result.complete
                ? 'incomplete'
                : stable(prior.sort((a, b) => stable(a).localeCompare(stable(b)))) === stable(result.rows)
                  ? 'equal'
                  : 'different',
            priorCount: prior?.length,
            currentCount: result.rows.length,
            ...(prior && plan ? diffRows(prior, result.rows, plan) : {}),
          };
        }),
      );
      return { baselineId, differences };
    } catch (error) {
      return { baselineId, verdict: 'incomplete', error: error.message };
    }
  }
  async function runCrud(mode = 'all') {
    // Probe CRUD validates the recorder/session without mutating the business baseline.
    let probeId;
    const plan = { id: 'CRUD-probe', table: 'pqvd_crudprobe', variant: 'positive-control' };
    if (['all', 'probe'].includes(mode))
      try {
        const createOp = await operation(plan, 'webapi', crypto.randomUUID(), 1, { phase: 'CRUD', message: 'Create' });
        await record(
          plan,
          createOp.pqvd_testoperationid,
          'webapi',
          {
            Request: {
              table: 'pqvd_crudprobe',
              purpose: 'Create disposable positive-control probe',
              runId,
              ownerContactId: context.contactId,
            },
          },
          { phase: 'CRUD', operation: 'Create' },
        );
        probeId = await create('pqvd_crudprobes', {
          pqvd_name: 'CO Disposable Probe',
          pqvd_token: crypto.randomUUID(),
          'pqvd_ownercontactid@odata.bind': bind('contacts', context.contactId),
          'pqvd_runid@odata.bind': bind('pqvd_testruns', runId),
          pqvd_value: 'before',
          pqvd_counter: 0,
        });
        residuals.push(probeId);
        await record(
          plan,
          createOp.pqvd_testoperationid,
          'webapi',
          { Summary: { table: plan.table, method: 'POST', probeId } },
          { phase: 'CRUD', operation: 'Create' },
        );
        for (const [method, body] of [
          ['GET', undefined],
          ['PATCH', { pqvd_value: 'after', pqvd_counter: 1 }],
          ['GET', undefined],
          ['DELETE', undefined],
        ]) {
          if (stopped()) break;
          const op = await operation(plan, 'webapi', crypto.randomUUID(), 1, {
            phase: 'CRUD',
            message: { GET: 'Retrieve', PATCH: 'Update', DELETE: 'Delete' }[method],
          });
          const response = await request({
            method,
            url: `/_api/pqvd_crudprobes(${probeId})${method === 'GET' ? '?$select=pqvd_crudprobeid,pqvd_name,pqvd_value,pqvd_counter' : ''}`,
            body,
          });
          const result = { table: plan.table, method, status: response.status, body: response.text };
          evidence.push(result);
          await record(
            plan,
            op.pqvd_testoperationid,
            'webapi',
            { Summary: result, RawResponse: response.text },
            {
              phase: 'CRUD',
              operation: method === 'GET' ? 'Read' : method === 'PATCH' ? 'Update' : 'Delete',
              httpStatus: response.status,
            },
          );
          if (!response.ok) break;
          if (method === 'DELETE') residuals.splice(residuals.indexOf(probeId), 1);
        }
      } catch (error) {
        evidence.push({
          kind: 'probe-error',
          error: error.message,
          httpStatus: error.response?.status,
          rawResponse: error.response?.text,
          probeId,
        });
      } finally {
        if (probeId && residuals.includes(probeId)) {
          try {
            const cleanupOp = await operation(plan, 'webapi', crypto.randomUUID(), 1, {
                phase: 'Cleanup',
                message: 'Delete',
              }),
              response = await request({ method: 'DELETE', url: `/_api/pqvd_crudprobes(${probeId})` });
            await record(
              plan,
              cleanupOp.pqvd_testoperationid,
              'webapi',
              { Cleanup: { probeId, status: response.status }, RawResponse: response.text },
              { phase: 'Cleanup', operation: 'Delete', httpStatus: response.status },
            );
            if (response.ok) residuals.splice(residuals.indexOf(probeId), 1);
            else
              evidence.push({
                kind: 'probe-cleanup-error',
                probeId,
                status: response.status,
                rawResponse: response.text,
              });
          } catch (error) {
            evidence.push({ kind: 'probe-cleanup-error', probeId, error: error.message });
          }
        }
      }
    for (const fixture of manifest.crudFixtures) {
      if (stopped()) break;
      if (mode === 'probe' || (mode === 'equipment' && fixture.table !== 'pqvd_equipment')) continue;
      if (fixture.targets && manifest.readiness.businessScalarUpdates) await scalarCanaries(fixture);
      else
        evidence.push({
          kind: 'blocked',
          table: fixture.table,
          operations: ['Update'],
          reason: fixture.targets
            ? 'Scalar mutation guards not qualified.'
            : 'Reference/grant mutation requires a prepared negative payload; baseline rows are protected.',
        });
      if (fixture.table === 'pqvd_equipment' && manifest.readiness.equipmentCanaryCreateDelete)
        await equipmentCanary(fixture);
      else
        evidence.push({
          kind: 'blocked',
          table: fixture.table,
          operations: ['Create', 'Delete'],
          reason: 'Maintained scope projections and valid disposable parent/singleton dependencies not qualified.',
        });
    }
  }
  async function scalarCanaries(fixture) {
    const entitySet = manifest.cases.find((c) => c.table === fixture.table).entitySet;
    for (const side of ['A', 'B']) {
      if (stopped()) break;
      const plan = manifest.crudReadCases.find((c) => c.id === `CRUD-${fixture.table}-${side}`);
      const before = fixture.originals[side],
        after = (before + ` [CO ${runId.slice(0, 8)}]`).slice(0, 150);
      let changed = false;
      const result = {
        kind: 'business-scalar-canary',
        table: fixture.table,
        side,
        targetId: fixture.targets[side],
        field: fixture.scalarField,
        steps: [],
      };
      try {
        const op = await operation(plan, 'webapi', crypto.randomUUID(), 1, { phase: 'CRUD', message: 'Update' }),
          body = { [fixture.scalarField]: after };
        await record(
          plan,
          op.pqvd_testoperationid,
          'webapi',
          { Request: body },
          { phase: 'CRUD', operation: 'Update' },
        );
        const response = await request({ method: 'PATCH', url: `/_api/${entitySet}(${fixture.targets[side]})`, body });
        changed = response.ok;
        result.steps.push({ method: 'PATCH', status: response.status, body: response.text });
        const expected = manifest.visibilityOracle
          ?.find((o) => guid(o.contactId) === guid(context.contactId))
          ?.canaryWrites.find((w) => w.table === fixture.table && w.side === side);
        result.permissionAssertion = {
          expectedAllowed: expected?.expectedAllowed ?? null,
          kind: 'configured-graph-canary-write',
          provenance: expected?.provenance || [],
          actualAccepted: response.ok,
          portalErrorCode: response.data?.error?.code || null,
          denialLayer:
            response.status === 403 && response.data?.error?.code === '90040102' ? 'table-write-permission' : null,
          verdict: !expected
            ? 'incomplete'
            : response.ok
              ? expected.expectedAllowed
                ? 'pass'
                : 'fail'
              : expected.expectedAllowed
                ? 'fail'
                : response.status === 403 && response.data?.error?.code === '90040102'
                  ? 'pass'
                  : 'rejected-with-layer-unqualified',
        };
        await record(
          plan,
          op.pqvd_testoperationid,
          'webapi',
          { Summary: result.steps.at(-1), RawResponse: response.text },
          { phase: 'CRUD', operation: 'Update', httpStatus: response.status },
        );
        const pairId = crypto.randomUUID(),
          liquid = await lane(plan, 'liquid', pairId),
          webapi = await lane(plan, 'webapi', pairId);
        result.verification = { liquid, webapi, parity: compareResults(liquid, webapi), requestedValue: after };
      } catch (error) {
        result.error = error.message;
      } finally {
        if (changed) {
          try {
            const cleanupOp = await operation(plan, 'webapi', crypto.randomUUID(), 1, {
                phase: 'Cleanup',
                message: 'Update',
              }),
              body = { [fixture.scalarField]: before },
              response = await request({ method: 'PATCH', url: `/_api/${entitySet}(${fixture.targets[side]})`, body });
            result.restore = { status: response.status, body: response.text };
            await record(
              plan,
              cleanupOp.pqvd_testoperationid,
              'webapi',
              { Cleanup: result.restore, Request: body },
              { phase: 'Cleanup', operation: 'Update', httpStatus: response.status },
            );
            if (!response.ok) residuals.push({ table: fixture.table, id: fixture.targets[side], restore: body });
          } catch (error) {
            residuals.push({
              table: fixture.table,
              id: fixture.targets[side],
              restore: { [fixture.scalarField]: before },
              error: error.message,
            });
          }
        }
      }
      evidence.push(result);
      notify(result);
    }
  }
  async function equipmentCanary(fixture) {
    const plan = { id: 'CRUD-equipment-create', table: 'pqvd_equipment', variant: 'disposable-stock' },
      token = crypto.randomUUID().slice(0, 8);
    let id;
    const body = {
      pqvd_name: `CO New Stock ${token}`,
      pqvd_assettag: `CO-CANARY-${token}`,
      pqvd_equipmentkind: fixture.createTemplate.fields.pqvd_equipmentkind,
      pqvd_condition: fixture.createTemplate.fields.pqvd_condition,
      pqvd_equipmentstate: 183270000,
      'pqvd_canaryrunid@odata.bind': bind('pqvd_testruns', runId),
      'pqvd_accountid@odata.bind': bind('accounts', manifest.fixtures[fixture.createTemplate.refs.pqvd_accountid]),
      'pqvd_roomid@odata.bind': bind('pqvd_rooms', manifest.fixtures[fixture.createTemplate.refs.pqvd_roomid]),
    };
    const result = { kind: 'business-equipment-canary', table: plan.table, steps: [] };
    try {
      const negativeOp = await operation(
          { ...plan, id: 'CRUD-equipment-ordinary-delete' },
          'webapi',
          crypto.randomUUID(),
          1,
          { phase: 'CRUD', message: 'Delete' },
        ),
        negativeUrl = `/_api/pqvd_equipments(${fixture.targets.A})`;
      await record(
        plan,
        negativeOp.pqvd_testoperationid,
        'webapi',
        {
          Request: {
            method: 'DELETE',
            url: negativeUrl,
            expected: 'denied: ordinary IT has no Delete, guard rejects absent canaryRun',
          },
        },
        { phase: 'CRUD', operation: 'Delete' },
      );
      const negative = await request({ method: 'DELETE', url: negativeUrl });
      result.ordinaryDelete = {
        status: negative.status,
        body: negative.text,
        accepted: negative.ok,
        verdict: negative.ok
          ? 'fail'
          : negative.status === 403 && negative.data?.error?.code === '90040104'
            ? 'expected-permission-denied'
            : 'rejected-other-layer',
      };
      await record(
        plan,
        negativeOp.pqvd_testoperationid,
        'webapi',
        { Summary: result.ordinaryDelete, RawResponse: negative.text },
        { phase: 'CRUD', operation: 'Delete', httpStatus: negative.status },
      );
      if (negative.ok) throw new Error('Protected ordinary equipment Delete unexpectedly accepted.');
      const op = await operation(plan, 'webapi', crypto.randomUUID(), 1, { phase: 'CRUD', message: 'Create' });
      await record(plan, op.pqvd_testoperationid, 'webapi', { Request: body }, { phase: 'CRUD', operation: 'Create' });
      const response = await request({ method: 'POST', url: '/_api/pqvd_equipments', body });
      id = response.entityId;
      result.steps.push({ method: 'POST', status: response.status, body: response.text, id });
      await record(
        plan,
        op.pqvd_testoperationid,
        'webapi',
        { Summary: result.steps.at(-1), RawResponse: response.text },
        { phase: 'CRUD', operation: 'Create', httpStatus: response.status },
      );
      if (response.ok && id) {
        id = guid(id);
        residuals.push({ table: 'pqvd_equipment', id });
        const readPlan = manifest.crudReadCases.find((p) => p.id === 'CRUD-equipment-created-read'),
          pairId = crypto.randomUUID(),
          liquid = await lane(readPlan, 'liquid', pairId),
          webapi = await lane(readPlan, 'webapi', pairId);
        result.verification = {
          liquid,
          webapi,
          parity: compareResults(liquid, webapi),
          createdId: id,
          createdRecordFound: liquid.ids.includes(id) && webapi.ids.includes(id),
        };
        result.steps.push({
          method: 'GET FetchXML paired',
          status: webapi.pages[0]?.httpStatus || 0,
          verdict: result.verification.parity,
        });
      } else if (response.ok) result.commitState = 'unknown: successful create without entityid';
    } catch (error) {
      result.error = error.message;
    } finally {
      if (id) {
        try {
          const op = await operation(plan, 'webapi', crypto.randomUUID(), 1, { phase: 'Cleanup', message: 'Delete' }),
            response = await request({ method: 'DELETE', url: `/_api/pqvd_equipments(${id})` });
          result.steps.push({ method: 'DELETE', status: response.status, body: response.text });
          await record(
            plan,
            op.pqvd_testoperationid,
            'webapi',
            { Cleanup: result.steps.at(-1), RawResponse: response.text },
            { phase: 'Cleanup', operation: 'Delete', httpStatus: response.status },
          );
          if (response.ok) {
            const index = residuals.findIndex((r) => r?.table === 'pqvd_equipment' && r.id === id);
            if (index >= 0) residuals.splice(index, 1);
          }
        } catch (error) {
          result.cleanupError = error.message;
        }
      }
    }
    evidence.push(result);
    notify(result);
  }
  async function loadRecordedRun(id) {
    const response = await request({
      url: `/_api/pqvd_testruns(${guid(id)})?$select=pqvd_testrunid,pqvd_summaryjson,pqvd_runstate,pqvd_datasetversion,pqvd_rolesnapshot`,
    });
    if (!response.ok) throw new Error(`Saved run HTTP ${response.status}`);
    const index = JSON.parse(response.data.pqvd_summaryjson || 'null');
    if (!index) throw new Error('Saved run has no finished index.');
    const operationId = index.summaryOperationId || index.failureOperationId;
    if (!operationId) return { legacy: true, index };
    const xml = `<fetch count="100"><entity name="pqvd_testresult"><attribute name="pqvd_partnumber"></attribute><attribute name="pqvd_partcount"></attribute><attribute name="pqvd_payloadtext"></attribute><attribute name="pqvd_payloadhash"></attribute><filter><condition attribute="pqvd_runid" operator="eq" value="${guid(id)}"></condition><condition attribute="pqvd_operationid" operator="eq" value="${guid(operationId)}"></condition><condition attribute="pqvd_artifactkind" operator="eq" value="${choice('pqvd_artifactkind', 'Summary')}"></condition></filter><order attribute="pqvd_partnumber"></order></entity></fetch>`;
    const partsResponse = await request({ url: `/_api/pqvd_testresults?fetchXml=${encodeURIComponent(xml)}` });
    if (!partsResponse.ok) throw new Error(`Saved summary parts HTTP ${partsResponse.status}`);
    const parts = partsResponse.data?.value || [];
    if (!parts.length || parts.length !== parts[0].pqvd_partcount || parts.length >= 100)
      throw new Error('Saved summary parts missing or paging bound reached.');
    for (let i = 0; i < parts.length; i++)
      if (parts[i].pqvd_partnumber !== i + 1 || (await sha256(parts[i].pqvd_payloadtext)) !== parts[i].pqvd_payloadhash)
        throw new Error('Saved summary sequence/checksum mismatch.');
    return {
      index,
      summary: JSON.parse(await decodeArtifact(parts.map((p) => p.pqvd_payloadtext).join(''))),
      verifiedParts: parts.length,
    };
  }
  return { run, lane, record, loadRecordedRun };
}

export async function portalRequest({ url, method = 'GET', body, signal }) {
  const target = new URL(url, location.origin);
  if (
    target.origin !== location.origin ||
    (!target.pathname.startsWith('/_api/') && target.pathname !== '/permission-lab/liquid/')
  )
    throw new Error('Request escaped portal test endpoints.');
  const token = await new Promise((resolve, reject) => window.shell.getTokenDeferred().done(resolve).fail(reject));
  const response = await fetch(target, {
    method,
    headers: {
      Accept: target.pathname.startsWith('/_api/') ? 'application/json' : 'application/xml',
      'Content-Type': 'application/json',
      __RequestVerificationToken: token,
      Prefer: 'odata.include-annotations="*"',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  const text = await response.text();
  let data = null;
  if (text && response.headers.get('content-type')?.includes('json')) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('API returned malformed JSON.');
    }
  }
  if (response.ok && target.pathname.startsWith('/_api/') && method === 'GET' && !data)
    throw new Error('API read returned no JSON; session loss or unexpected response.');
  return {
    ok: response.ok,
    status: response.status,
    text,
    data,
    entityId: response.headers.get('entityid'),
    url: target.href,
    mime: response.headers.get('content-type'),
  };
}

export function mount(manifest, context) {
  const log = document.getElementById('co-results'),
    status = document.getElementById('co-status');
  let cancelled = false,
    current = null;
  const render = (result) => {
    const detail = document.createElement('details'),
      title = document.createElement('summary'),
      pre = document.createElement('pre');
    title.textContent = result.caseId
      ? `${result.caseId}: ${result.verdict || result.kind || ''} | Liquid ${result.liquid?.returnedCount ?? '-'} | Web API ${result.webapi?.returnedCount ?? '-'}`
      : result.error || 'Run summary';
    const confirmation = result.liquid
      ? {
          test: result.caseId,
          verdict: result.verdict,
          liquid: {
            count: result.liquid.returnedCount,
            ids: result.liquid.ids,
            complete: result.liquid.complete,
            error: result.liquid.error,
          },
          webapi: {
            count: result.webapi.returnedCount,
            ids: result.webapi.ids,
            complete: result.webapi.complete,
            error: result.webapi.error,
          },
        }
      : result.runId
        ? {
            runId: result.runId,
            pairs: result.pairs?.length,
            error: result.error,
            persistenceError: result.persistenceError,
            residuals: result.residuals,
          }
        : result;
    pre.textContent = JSON.stringify(confirmation, null, 2);
    detail.append(title, pre);
    for (const observation of result.pairs || [result])
      for (const lane of [observation.liquid, observation.webapi].filter(Boolean))
        for (const page of lane.pages || []) {
          const blocks = [
            ['Authored FetchXML', page.authoredFetchXml],
            ['Liquid permission-applied XML', page.effectiveFetchXml],
          ];
          for (const event of page.backendEvents || []) {
            try {
              const content = JSON.parse(event.pqvd_payloadtext)?.content;
              if (content?.query?.xml)
                blocks.push([
                  `Plugin-received FetchXML: stage ${event.pqvd_stage}, ${content.linkCount ?? '?'} joins`,
                  content.query.xml,
                ]);
            } catch {
              /* Optional payload or browser capability is unavailable. */
            }
          }
          for (const [label, text] of blocks) {
            if (!text) continue;
            const heading = document.createElement('p'),
              xml = document.createElement('pre');
            heading.textContent = `${observation.caseId} ${lane.engine} ${page.fragment || ''} page ${page.page}: ${label}`;
            xml.textContent = text;
            detail.append(heading, xml);
          }
        }
    const full = document.createElement('details'),
      label = document.createElement('summary'),
      raw = document.createElement('pre');
    label.textContent = 'Full observation: raw evidence, backend XML and context';
    raw.dataset.observation = 'true';
    raw.textContent = JSON.stringify(result, null, 2);
    full.append(label, raw);
    detail.append(full);
    log.append(detail);
  };
  const select = document.getElementById('co-cases');
  for (const plan of [...manifest.cases, ...(manifest.stressCases || [])]) {
    const option = document.createElement('option');
    option.value = plan.id;
    option.textContent = plan.name;
    select.append(option);
  }
  document.getElementById('co-identity').textContent = JSON.stringify(context, null, 2);
  const baselineSelect = document.getElementById('co-baseline');
  document.getElementById('co-view-history').onclick = async () => {
    try {
      if (!baselineSelect.value) throw new Error('Select a saved run.');
      const runner = createRunner({ manifest, context, request: portalRequest });
      const loaded = await runner.loadRecordedRun(baselineSelect.value);
      current = loaded.summary || loaded.index;
      render(current);
      status.textContent = `Saved run loaded; ${loaded.verifiedParts || 0} checksummed parts verified${loaded.legacy ? ' (legacy inline index)' : ''}.`;
    } catch (error) {
      status.textContent = error.message;
    }
  };
  const profileSelect = document.getElementById('co-profile');
  for (const p of manifest.pluginProfiles || []) profileSelect.add(new Option(p.id + ' ' + p.readiness, p.id));
  document.getElementById('co-history').onclick = async () => {
    try {
      const response = await portalRequest({
        url: '/_api/pqvd_testruns?$select=pqvd_testrunid,pqvd_name,pqvd_startedat&$orderby=pqvd_startedat desc&$top=20',
      });
      if (!response.ok) throw new Error(`History read HTTP ${response.status}`);
      baselineSelect.replaceChildren(new Option('No baseline', ''));
      for (const run of response.data.value) baselineSelect.add(new Option(run.pqvd_name, run.pqvd_testrunid));
    } catch (error) {
      status.textContent = error.message;
    }
  };
  const execute = async (crud) => {
    cancelled = false;
    log.textContent = '';
    status.textContent = 'Running';
    document.querySelectorAll('[data-run]').forEach((b) => (b.disabled = true));
    try {
      const runner = createRunner({
        manifest,
        context,
        request: portalRequest,
        notify: render,
        stopped: () => cancelled,
      });
      current = await runner.run({
        crud,
        crudMode: document.getElementById('co-crud-scope').value,
        selectedCases: select.value === 'all' ? undefined : [select.value],
        baselineId: baselineSelect.value || null,
        pluginProfile: profileSelect.value || null,
      });
      render(current);
      status.textContent = current.error
        ? 'Incomplete: ' + current.error
        : cancelled
          ? 'Interrupted; inspect recorded completeness and verdicts.'
          : 'Finished; inspect recorded completeness and verdicts.';
    } catch (error) {
      status.textContent = error.message;
      current = { error: error.message, httpStatus: error.response?.status, rawResponse: error.response?.text };
      render(current);
    } finally {
      document.querySelectorAll('[data-run]').forEach((b) => (b.disabled = false));
    }
  };
  document.getElementById('co-read').onclick = () => execute(false);
  document.getElementById('co-crud').onclick = () => execute(true);
  document.getElementById('co-stop').onclick = () => {
    cancelled = true;
    status.textContent = 'Stopping after current request';
  };
  document.getElementById('co-export').onclick = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
    link.download = 'co-permission-run.json';
    link.click();
    URL.revokeObjectURL(link.href);
  };
}
