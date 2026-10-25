/** Browser-safe evidence policy. Embed this factory, not a second copy of its rules. */
export function inspectionEvidenceRuntime() {
  const text = (value, limit = 512) =>
    typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0') ? value : null;
  const unique = (rows, key) => [...new Map(rows.map((row) => [key(row), row])).values()];
  const regionOf = (value) => {
    if (!value || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)) return undefined;
    if (value.start < 0 || value.end < value.start || value.end > 1_000_000_000) return undefined;
    return {
      start: value.start,
      end: value.end,
      ...(Number.isSafeInteger(value.line) && value.line > 0 ? { line: value.line } : {}),
      ...(Number.isSafeInteger(value.column) && value.column > 0 ? { column: value.column } : {}),
    };
  };
  function normalizeInspectionScope(value) {
    if (
      !value ||
      !text(value.documentId, 256) ||
      !text(value.frameId, 256) ||
      !Number.isSafeInteger(value.uiEpoch) ||
      value.uiEpoch < 0 ||
      !text(value.sourceRevision, 256)
    )
      return null;
    return {
      documentId: value.documentId,
      frameId: value.frameId,
      uiEpoch: value.uiEpoch,
      sourceRevision: value.sourceRevision,
    };
  }
  function compareInspectionScopes(packet, current) {
    const a = normalizeInspectionScope(packet),
      b = normalizeInspectionScope(current);
    const observation =
      a && b && a.documentId === b.documentId && a.frameId === b.frameId && a.uiEpoch === b.uiEpoch
        ? 'current'
        : 'stale';
    return {
      owner: observation,
      source: observation === 'current' && a.sourceRevision === b.sourceRevision ? 'current' : 'stale',
    };
  }
  function normalizeInspectionSourceRef(value) {
    if (!value || typeof value !== 'object' || !text(value.id ?? value.key ?? value.sourceKey, 8192)) return null;
    const result = { id: value.id ?? value.key ?? value.sourceKey };
    for (const key of [
      'key',
      'sourceKey',
      'componentKey',
      'placementKey',
      'kind',
      'recordId',
      'name',
      'label',
      'ref',
      'sourceRevision',
      'contentRevision',
      'currentContentRevision',
      'relationship',
      'languageId',
      'profileId',
      'layer',
      'evidenceLabel',
    ]) {
      const clean = text(value[key], ['key', 'sourceKey', 'ref'].includes(key) ? 16384 : 1024);
      if (clean) result[key] = clean;
    }
    if (value.lcid !== undefined && Number.isSafeInteger(value.lcid) && value.lcid >= 0) result.lcid = value.lcid;
    if (['available', 'pending', 'unavailable'].includes(value.currentState)) result.currentState = value.currentState;
    if (
      Array.isArray(value.fieldPath) &&
      value.fieldPath.length <= 32 &&
      value.fieldPath.every((part) => text(part, 512))
    )
      result.fieldPath = [...value.fieldPath];
    const region = regionOf(value.region);
    if (region) result.region = region;
    if (value.observations && typeof value.observations === 'object') {
      result.observations = {};
      for (const key of ['declared', 'requested', 'served', 'parsed', 'executed', 'mounted'])
        if ([true, false, 'unavailable'].includes(value.observations[key]))
          result.observations[key] = value.observations[key];
    }
    return result;
  }
  const componentOf = (value) => {
    if (!value || typeof value !== 'object' || !text(value.kind, 128)) return null;
    const result = { kind: value.kind };
    for (const key of [
      'key',
      'id',
      'recordId',
      'name',
      'label',
      'entity',
      'field',
      'controlName',
      'formId',
      'viewId',
      'namespace',
      'constructorName',
      'mountState',
    ]) {
      const clean = text(value[key], key === 'key' ? 8192 : 1024);
      if (clean) result[key] = clean;
    }
    if (Number.isSafeInteger(value.formFactor) && value.formFactor >= 0 && value.formFactor <= 2)
      result.formFactor = value.formFactor;
    if (
      !result.key &&
      !result.id &&
      !result.recordId &&
      !result.controlName &&
      !result.field &&
      !result.name &&
      !(result.kind === 'table' && result.entity)
    )
      return null;
    result.key ??= [
      result.kind,
      result.entity,
      result.id ?? result.recordId ?? result.controlName ?? result.field ?? result.name,
    ]
      .filter(Boolean)
      .join(':');
    return result.key === result.kind ? null : result;
  };
  const componentKey = (value) => (value ? value.kind + '\0' + value.key : '');
  const refKey = (value) =>
    JSON.stringify([
      value.sourceKey ?? value.key ?? value.id,
      value.region ?? null,
      value.relationship ?? null,
      value.sourceRevision ?? null,
      value.contentRevision ?? null,
    ]);
  const localProofs = new Set(['render-literal', 'render-platform', 'mirage-registry', 'mirage-owner']);
  const ownerProofs = new Set([
    ...localProofs,
    'runtime-owner',
    'native-api',
    'native-api-owner',
    'native-component-id',
    'native-field-id',
    'model-driven-binding',
    'lense-applied-literal',
  ]);
  const sourceProofs = new Set(['render-literal', 'render-platform', 'lense-applied-literal', 'observed-dom-callsite']);

  /** Inputs have already crossed the provider's trusted channel. Page hints never assign their own proof type. */
  function resolveInspectionEvidence(input = {}) {
    const scope = normalizeInspectionScope(input.scope);
    const result = {
      version: 1,
      scope: scope ?? null,
      owner: { status: 'unavailable', component: null, evidence: [] },
      source: { status: 'unavailable', refs: [] },
      enclosing: [],
      facts: [],
      candidates: [],
      conflicts: [],
      unavailable: [],
      limits: { truncated: false, reasons: [] },
    };
    const notice = (dimension, reason) => ({ dimension, reason, label: reason.replaceAll('-', ' ') });
    if (input.version !== 1) {
      result.unavailable.push(notice('all', 'unsupported-evidence-version'));
      return result;
    }
    if (!scope) {
      result.unavailable.push(notice('all', 'invalid-selection-scope'));
      return result;
    }
    const rawRefs = Array.isArray(input.sourceRefs) ? input.sourceRefs : [];
    const refs = rawRefs.slice(0, 128).map(normalizeInspectionSourceRef).filter(Boolean);
    const byId = new Map();
    const currentById = new Map(
      (Array.isArray(input.currentSourceRefs) ? input.currentSourceRefs : [])
        .slice(0, 256)
        .map(normalizeInspectionSourceRef)
        .filter(Boolean)
        .map((ref) => [ref.id, ref]),
    );
    const ambiguousRefs = new Set();
    const identityKey = (ref) =>
      JSON.stringify([
        ref.sourceKey ?? ref.key ?? ref.id,
        ref.componentKey,
        ref.recordId,
        ref.fieldPath,
        ref.languageId,
        ref.lcid,
        ref.profileId,
        ref.layer,
        ref.kind,
        ref.ref,
      ]);
    for (const ref of refs) {
      const previous = byId.get(ref.id) ?? [];
      if (previous.some((item) => identityKey(item) !== identityKey(ref))) ambiguousRefs.add(ref.id);
      byId.set(ref.id, [...previous, ref]);
    }
    const rawFacts = [
      ...(Array.isArray(input.facts) ? input.facts : []),
      ...(Array.isArray(input.ownerFacts) ? input.ownerFacts.map((row) => ({ ...row, dimension: 'owner' })) : []),
      ...(Array.isArray(input.contextFacts) ? input.contextFacts.map((row) => ({ ...row, dimension: 'context' })) : []),
    ];
    const facts = rawFacts.slice(0, 256).flatMap((value, index) => {
      if (!value || typeof value !== 'object' || !text(value.proof ?? value.kind, 128)) return [];
      const dimension =
        value.dimension === 'direct' ? 'source' : value.dimension === 'component' ? 'owner' : value.dimension;
      if (!['owner', 'source', 'enclosing', 'context'].includes(dimension)) return [];
      const factScope = normalizeInspectionScope(value.scope);
      const freshness = compareInspectionScopes(factScope, scope);
      const sourceRevision = text(value.renderSourceRevision ?? value.sourceRevision, 256) ?? factScope?.sourceRevision;
      if (sourceRevision !== scope.sourceRevision) freshness.source = 'stale';
      if (input.node?.connected === false || value.stale === true) freshness.owner = freshness.source = 'stale';
      const proof = value.proof ?? value.kind;
      const allowed = !localProofs.has(proof) || input.mode === 'local';
      return [
        {
          id: text(value.id, 256) ?? 'fact-' + index,
          dimension,
          proof,
          freshness,
          subject: text(value.subject, 8192) ?? text(input.node?.id, 256) ?? 'selection',
          predicate: text(value.predicate, 128) ?? (dimension === 'source' ? 'definition' : 'identity'),
          binding: componentOf(value.binding ?? value.component),
          sourceRefIds: Array.isArray(value.sourceRefIds)
            ? value.sourceRefIds.slice(0, 32).filter((id) => text(id, 8192))
            : [],
          sourceRefBindings: (Array.isArray(value.sourceRefBindings) ? value.sourceRefBindings : [])
            .slice(0, 32)
            .filter((ref) => text(ref?.id, 8192) && text(ref.sourceRevision, 256) && text(ref.contentRevision, 1024))
            .map((ref) => ({ id: ref.id, sourceRevision: ref.sourceRevision, contentRevision: ref.contentRevision })),
          sourceRevision,
          region: regionOf(value.region),
          reason: text(value.reason, 256),
          label: text(value.label, 512),
          allowed,
          conflict: proof === 'lifecycle-conflict' || proof === 'binding-conflict',
        },
      ];
    });
    const evidenceOf = (fact) => ({
      id: fact.id,
      kind: fact.proof,
      label: fact.label ?? fact.reason ?? fact.proof.replaceAll('-', ' '),
    });
    const ownerRows = facts.filter((fact) => fact.dimension === 'owner' && fact.binding);
    const exactOwners = ownerRows.filter(
      (fact) => fact.allowed && fact.freshness.owner === 'current' && ownerProofs.has(fact.proof),
    );
    const ownerConflicts = facts.filter(
      (fact) => fact.dimension === 'owner' && fact.conflict && fact.freshness.owner === 'current',
    );
    const groups = new Map();
    for (const fact of exactOwners) {
      const key = fact.subject + '\0' + fact.predicate;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(componentKey(fact.binding));
    }
    if (
      ownerConflicts.length ||
      new Set(exactOwners.map((fact) => componentKey(fact.binding))).size > 1 ||
      [...groups.values()].some((group) => group.size > 1)
    ) {
      result.owner.status = 'conflicting';
      result.conflicts.push(notice('owner', 'contradictory-current-owner-evidence'));
    } else if (exactOwners.length) {
      const selected = exactOwners[0];
      result.owner = { status: 'exact', component: selected.binding, evidence: exactOwners.map(evidenceOf) };
    } else if (ownerRows.some((fact) => fact.freshness.owner === 'current')) {
      result.owner.status = 'candidate';
    } else if (ownerRows.length || input.node?.connected === false) result.owner.status = 'stale';
    for (const fact of ownerRows)
      if (result.owner.status !== 'exact' || componentKey(fact.binding) !== componentKey(result.owner.component))
        result.candidates.push({
          status: fact.freshness.owner === 'stale' ? 'stale' : 'candidate',
          component: fact.binding,
          reason: fact.reason ?? fact.proof,
        });

    const sourceFacts = facts.filter((fact) => fact.dimension === 'source');
    // Retain candidate/stale definition links as such. Only an independently
    // exact current owner can promote a matching definition to exact source.
    for (const fact of ownerRows)
      if (fact.sourceRefIds.length)
        sourceFacts.push({ ...fact, dimension: 'source', proof: 'export-definition', predicate: 'definition' });
    const sourceRows = sourceFacts.flatMap((fact) =>
      fact.sourceRefIds.map((id) => {
        const versions = byId.get(id) ?? [];
        const binding = fact.sourceRefBindings.find((ref) => ref.id === id);
        const relevant = versions.filter((ref) =>
          binding
            ? ref.sourceRevision === binding.sourceRevision && ref.contentRevision === binding.contentRevision
            : !fact.sourceRevision || ref.sourceRevision === fact.sourceRevision,
        );
        const choices = relevant.length ? relevant : binding ? [] : versions;
        const versionConflict =
          new Set(choices.map((ref) => JSON.stringify([ref.sourceRevision, ref.contentRevision]))).size > 1;
        const ref = choices[0];
        if (!ref) return { fact, ref: null, status: 'unavailable' };
        const stale =
          fact.freshness.source === 'stale' ||
          (ref.sourceRevision && ref.sourceRevision !== scope.sourceRevision) ||
          (ref.currentContentRevision && ref.currentContentRevision !== ref.contentRevision) ||
          (currentById.has(ref.id) && currentById.get(ref.id).contentRevision !== ref.contentRevision);
        const matchesOwner =
          result.owner.status === 'exact' &&
          (componentKey(fact.binding) === componentKey(result.owner.component) ||
            ref.componentKey === result.owner.component.key);
        const exactProof =
          fact.allowed && (sourceProofs.has(fact.proof) || (fact.proof === 'export-definition' && matchesOwner));
        const verified = Boolean(ref.ref && (ref.sourceKey ?? ref.key) && ref.sourceRevision && ref.contentRevision);
        return {
          fact,
          ref: {
            ...ref,
            evidenceLabel: ref.evidenceLabel ?? fact.label ?? fact.reason ?? fact.proof.replaceAll('-', ' '),
            ...(fact.region ? { region: fact.region } : {}),
          },
          status: ['pending', 'unavailable'].includes(ref.currentState)
            ? 'unavailable'
            : ambiguousRefs.has(id) || versionConflict
              ? 'conflicting'
              : stale
                ? 'stale'
                : exactProof && verified
                  ? 'exact'
                  : 'candidate',
        };
      }),
    );
    const exactSources = sourceRows.filter((row) => row.status === 'exact');
    const sourceGroups = new Map();
    for (const { fact, ref } of exactSources) {
      const group = fact.subject + '\0' + (ref.relationship ?? fact.predicate);
      if (!sourceGroups.has(group)) sourceGroups.set(group, new Set());
      sourceGroups.get(group).add(refKey(ref));
    }
    const sourceConflict =
      sourceRows.some((row) => row.status === 'conflicting') ||
      facts.some((fact) => fact.dimension === 'source' && fact.conflict && fact.freshness.source === 'current') ||
      [...sourceGroups.values()].some((group) => group.size > 1);
    if (sourceConflict) {
      result.source.status = 'conflicting';
      result.conflicts.push(notice('source', 'contradictory-current-source-evidence'));
    } else if (exactSources.length) result.source.status = 'exact';
    else if (sourceRows.some((row) => row.status === 'stale')) result.source.status = 'stale';
    else if (sourceRows.some((row) => row.status === 'candidate')) result.source.status = 'candidate';
    const refPriority = { unavailable: 0, stale: 1, candidate: 2, exact: 3, conflicting: 4 };
    result.source.refs = unique(
      sourceRows
        .filter((row) => row.ref)
        .map(({ ref, status }) => ({
          ...ref,
          status: sourceConflict && status === 'exact' ? 'conflicting' : status,
        }))
        .sort((a, b) => refPriority[a.status] - refPriority[b.status]),
      refKey,
    );
    const exactRefIdentities = new Set(
      result.source.refs
        .filter((ref) => ref.status === 'exact')
        .map((ref) =>
          JSON.stringify([
            ref.sourceKey ?? ref.key ?? ref.id,
            ref.sourceRevision,
            ref.contentRevision,
            ref.relationship ?? null,
          ]),
        ),
    );
    result.source.refs = result.source.refs.filter(
      (ref) =>
        ref.status !== 'candidate' ||
        !exactRefIdentities.has(
          JSON.stringify([
            ref.sourceKey ?? ref.key ?? ref.id,
            ref.sourceRevision,
            ref.contentRevision,
            ref.relationship ?? null,
          ]),
        ),
    );
    for (const fact of facts.filter((row) => ['enclosing', 'context'].includes(row.dimension))) {
      const status =
        fact.freshness.owner === 'stale'
          ? 'stale'
          : fact.allowed && ownerProofs.has(fact.proof)
            ? 'exact'
            : 'candidate';
      if (fact.dimension === 'enclosing')
        result.enclosing.push({
          status,
          component: fact.binding,
          relationship: fact.predicate,
          evidence: [evidenceOf(fact)],
        });
      else result.facts.push({ ...evidenceOf(fact), status, relationship: fact.predicate, component: fact.binding });
    }
    result.candidates = unique(result.candidates, (row) => componentKey(row.component) + '\0' + row.status);
    result.enclosing = unique(result.enclosing, (row) => componentKey(row.component) + '\0' + row.relationship);
    const hierarchyOrder = {
      form: 0,
      formxml: 0,
      view: 0,
      table: 1,
      'basic-form': 2,
      'advanced-form-step': 2,
      'advanced-form': 3,
      list: 3,
      webpage: 4,
      page: 4,
    };
    result.enclosing.sort(
      (a, b) =>
        (hierarchyOrder[a.component?.kind?.toLowerCase()] ?? 10) -
        (hierarchyOrder[b.component?.kind?.toLowerCase()] ?? 10),
    );
    const omitted = input.completeness?.omitted;
    result.limits.truncated = Boolean(
      input.limits?.truncated ||
      input.completeness?.complete === false ||
      rawRefs.length > 128 ||
      rawFacts.length > 256 ||
      (omitted && Object.values(omitted).some((count) => Number.isFinite(count) && count > 0)),
    );
    const reasons = [
      ...(Array.isArray(input.completeness?.reasons) ? input.completeness.reasons : []),
      ...(Array.isArray(input.limits?.reasons) ? input.limits.reasons : []),
    ];
    result.limits.reasons = unique(
      reasons.slice(0, 32).filter((reason) => text(reason, 256)),
      (reason) => reason,
    );
    result.limits.sources = (Array.isArray(input.limits?.sources) ? input.limits.sources : [])
      .slice(0, 64)
      .filter((item) => text(item?.ref, 16384))
      .map((item) => ({ ref: item.ref, reason: text(item.reason, 256) ?? 'index-omission' }));
    result.limits.omitted = Object.fromEntries(
      Object.entries(input.limits?.omitted ?? {})
        .slice(0, 16)
        .filter(([key, count]) => text(key, 128) && Number.isSafeInteger(count) && count >= 0),
    );
    if (result.limits.truncated && !result.limits.reasons.length) result.limits.reasons.push('bounded-evidence-search');
    if (result.owner.status === 'unavailable')
      result.unavailable.push(notice('owner', 'no-current-direct-owner-proof'));
    if (result.source.status === 'unavailable')
      result.unavailable.push(notice('source', 'no-current-editable-source-proof'));
    if (input.mode === 'live')
      result.facts.push({
        kind: 'deployed-revision',
        label: 'Local definition; deployed revision unverified',
        observed: false,
      });
    return result;
  }
  return Object.freeze({
    normalizeInspectionScope,
    compareInspectionScopes,
    normalizeInspectionSourceRef,
    resolveInspectionEvidence,
  });
}

export const { normalizeInspectionScope, normalizeInspectionSourceRef, resolveInspectionEvidence } =
  inspectionEvidenceRuntime();
