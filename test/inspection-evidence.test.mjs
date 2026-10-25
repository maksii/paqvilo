import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectionEvidenceRuntime,
  normalizeInspectionSourceRef,
  resolveInspectionEvidence,
} from '../lense/inspection-evidence.mjs';

const scope = { documentId: 'document-a', frameId: 'frame-a', uiEpoch: 1, sourceRevision: 'source-a' };
const field = { kind: 'field', key: 'field:sample_entry:title', entity: 'sample_entry', name: 'title' };
const source = {
  id: 'field-source',
  key: 'field:sample_entry:title:definition',
  componentKey: field.key,
  kind: 'field',
  ref: 'solutions/entry/Entity.xml',
  name: 'Title column',
  sourceRevision: scope.sourceRevision,
  contentRevision: 'content-a',
  relationship: 'definition',
  region: { start: 10, end: 40, line: 2, column: 1 },
};
const owner = {
  id: 'selected-control',
  scope,
  dimension: 'owner',
  kind: 'observed',
  proof: 'mirage-registry',
  subject: 'selection',
  predicate: 'identity',
  binding: field,
  sourceRefIds: [source.id],
};
const packet = (facts = [owner], refs = [source], rest = {}) => ({
  version: 1,
  mode: 'local',
  scope,
  node: { id: 'node-a', tag: 'input', connected: true },
  facts,
  sourceRefs: refs,
  completeness: { complete: true },
  ...rest,
});

test('a mounted current control resolves its own column definition without borrowing enclosing form ownership', () => {
  const form = { kind: 'form', key: 'form:a', name: 'Entry form' };
  const result = resolveInspectionEvidence(
    packet([
      owner,
      {
        ...owner,
        id: 'enclosing-form',
        dimension: 'enclosing',
        predicate: 'contains',
        binding: form,
        sourceRefIds: [],
      },
    ]),
  );
  assert.equal(result.owner.status, 'exact');
  assert.equal(result.owner.component.key, field.key);
  assert.equal(result.source.status, 'exact');
  assert.equal(result.source.refs[0].ref, source.ref);
  assert.equal(result.enclosing[0].component.key, form.key);
});

test('a changed source snapshot preserves a current runtime owner while refusing its old source action', () => {
  const current = { ...scope, sourceRevision: 'source-b' };
  const result = resolveInspectionEvidence(packet([owner], [source], { scope: current }));
  assert.equal(result.owner.status, 'exact');
  assert.equal(result.source.status, 'stale');
  assert.equal(result.source.refs[0].status, 'stale');
  assert.deepEqual(inspectionEvidenceRuntime().compareInspectionScopes(scope, current), {
    owner: 'current',
    source: 'stale',
  });
});

for (const changed of [{ documentId: 'document-b' }, { frameId: 'frame-b' }, { uiEpoch: 2 }])
  test(`a superseded ${Object.keys(changed)[0]} never keeps an exact selection`, () => {
    const result = resolveInspectionEvidence(packet([owner], [source], { scope: { ...scope, ...changed } }));
    assert.equal(result.owner.status, 'stale');
    assert.notEqual(result.source.status, 'exact');
  });

test('native navigation input, sole exported shape and DOM tokens remain candidates despite exact-looking files', () => {
  for (const proof of ['api-page-context', 'metadata-shape', 'configured-default', 'native-dom', 'static-selector']) {
    const candidate = { ...owner, proof, dimension: 'owner' };
    const result = resolveInspectionEvidence(
      packet([candidate, { ...candidate, dimension: 'source' }], [source], { mode: 'live' }),
    );
    assert.equal(result.owner.status, 'candidate', proof);
    assert.equal(result.source.status, 'candidate', proof);
  }
});

test('an asset served, parsed or executed has no implicit ownership of a selected element', () => {
  const asset = { ...source, observations: { served: true, parsed: true, executed: true } };
  const result = resolveInspectionEvidence(
    packet(
      [
        { ...owner, dimension: 'context', proof: 'script-reference', predicate: 'declares' },
        { ...owner, dimension: 'source', proof: 'verified-source-map' },
      ],
      [asset],
    ),
  );
  assert.equal(result.owner.status, 'unavailable');
  assert.equal(result.source.status, 'candidate');
  assert.equal(result.source.refs[0].observations.executed, true);
});

test('conflicting selected runtime identities fail closed independently from a verified producing source', () => {
  const other = { ...owner, id: 'other-owner', binding: { ...field, key: 'field:sample_entry:other', name: 'other' } };
  const literal = { ...owner, id: 'literal', dimension: 'source', proof: 'render-literal', sourceRefIds: [source.id] };
  const result = resolveInspectionEvidence(packet([owner, other, literal]));
  assert.equal(result.owner.status, 'conflicting');
  assert.equal(result.owner.component, null);
  assert.equal(result.source.status, 'exact');
  assert.equal(result.conflicts[0].dimension, 'owner');
});

test('definition and placement are distinct valid relationships, while competing definitions conflict', () => {
  const placement = {
    ...source,
    id: 'placement',
    key: 'form:a:control:title',
    relationship: 'placement',
    ref: 'solutions/entry/Form.xml',
  };
  const result = resolveInspectionEvidence(
    packet([{ ...owner, sourceRefIds: [source.id, placement.id] }], [source, placement]),
  );
  assert.equal(result.source.status, 'exact');
  assert.equal(result.source.refs.length, 2);
  const competing = { ...placement, relationship: 'definition' };
  const conflict = resolveInspectionEvidence(
    packet([{ ...owner, sourceRefIds: [source.id, competing.id] }], [source, competing]),
  );
  assert.equal(conflict.source.status, 'conflicting');
  assert.ok(conflict.source.refs.every((ref) => ref.status === 'conflicting'));
});

test('duplicate source IDs with different field identities cannot silently select the first definition', () => {
  const result = resolveInspectionEvidence(packet([owner], [source, { ...source, key: 'different:localized:field' }]));
  assert.equal(result.owner.status, 'exact');
  assert.equal(result.source.status, 'conflicting');
});

test('generated and unexported controls retain exact owner with unavailable editable source', () => {
  const result = resolveInspectionEvidence(packet([{ ...owner, sourceRefIds: [] }], []));
  assert.equal(result.owner.status, 'exact');
  assert.equal(result.source.status, 'unavailable');
  assert.equal(result.source.refs.length, 0);
});

test('a detached original is stale; copied local proof types are not authoritative on live pages', () => {
  const detached = resolveInspectionEvidence(packet([owner], [source], { node: { id: 'node-a', connected: false } }));
  assert.equal(detached.owner.status, 'stale');
  assert.equal(detached.source.status, 'stale');
  const live = resolveInspectionEvidence(
    packet([owner, { ...owner, dimension: 'source', proof: 'render-literal' }], [source], { mode: 'live' }),
  );
  assert.equal(live.owner.status, 'candidate');
  assert.equal(live.source.status, 'candidate');
});

test('missing source revision cannot produce an exact editable-source claim', () => {
  const result = resolveInspectionEvidence(packet([owner], [{ ...source, contentRevision: undefined }]));
  assert.equal(result.owner.status, 'exact');
  assert.equal(result.source.status, 'candidate');
});

test('a static alternative cannot overwrite current exact proof, and historical revisions stay visibly separate', () => {
  const literal = { ...owner, dimension: 'source', proof: 'render-literal' };
  const staticMatch = { ...literal, id: 'static-match', proof: 'static-selector' };
  const current = resolveInspectionEvidence(packet([literal, staticMatch]));
  assert.equal(current.source.status, 'exact');
  assert.equal(current.source.refs.length, 1);
  assert.equal(current.source.refs[0].status, 'exact');
  const point = resolveInspectionEvidence(
    packet([{ ...literal, region: { start: 12, end: 18, line: 2, column: 3 } }, staticMatch]),
  );
  assert.equal(point.source.refs.length, 1, 'static whole-field hint does not duplicate an actual selected-tag proof');
  assert.equal(point.source.refs[0].region.start, 12);
  const old = { ...source, id: 'old-source', sourceRevision: 'source-old', contentRevision: 'content-old' };
  const mixed = resolveInspectionEvidence(
    packet(
      [literal, { ...literal, id: 'old-literal', sourceRefIds: [old.id], renderSourceRevision: 'source-old' }],
      [source, old],
    ),
  );
  assert.equal(mixed.source.status, 'exact');
  assert.equal(mixed.source.refs.length, 2);
  assert.deepEqual(new Set(mixed.source.refs.map((ref) => ref.status)), new Set(['exact', 'stale']));
});

test('a table name without a selected column identity cannot become an exact column', () => {
  const result = resolveInspectionEvidence(packet([{ ...owner, binding: { kind: 'field', entity: 'sample_entry' } }]));
  assert.equal(result.owner.status, 'unavailable');
});

test('selected field context orders the Solution form, table, basic form and webpage independently of discovery order', () => {
  const parents = [
    ['webpage', 'host-page'],
    ['basic-form', 'portal-form'],
    ['table', 'sample_entry'],
    ['form', 'solution-form'],
  ];
  const result = resolveInspectionEvidence(
    packet([
      owner,
      ...parents.map(([kind, key]) => ({
        id: key,
        scope,
        dimension: 'enclosing',
        proof: 'native-component-id',
        subject: 'selection',
        predicate: 'contains',
        binding: { kind, key, name: key },
      })),
    ]),
  );
  assert.deepEqual(
    result.enclosing.map((row) => row.component.kind),
    ['form', 'table', 'basic-form', 'webpage'],
  );
  assert.equal(result.owner.component.key, field.key);
});

test('a future or missing wire version never silently acquires v1 exact proof', () => {
  for (const version of [undefined, 0, 2, '1']) {
    const result = resolveInspectionEvidence({ ...packet(), version });
    assert.equal(result.owner.status, 'unavailable');
    assert.equal(result.source.status, 'unavailable');
  }
});

test('a Solution-only content edit invalidates rendered source even when the portal revision did not change', () => {
  for (const rest of [
    { currentSourceRefs: [{ ...source, contentRevision: 'edited-form-content' }] },
    { sourceRefs: [{ ...source, currentContentRevision: 'edited-form-content' }] },
  ]) {
    const result = resolveInspectionEvidence({ ...packet(), ...rest });
    assert.equal(result.owner.status, 'exact');
    assert.equal(result.source.status, 'stale');
    assert.equal(result.source.refs[0].status, 'stale');
  }
});

test('a historical observed reference and a current static candidate keep their own versions and regions', () => {
  const historic = {
    ...source,
    sourceRevision: 'source-old',
    contentRevision: 'content-old',
    region: { start: 0, end: 80 },
  };
  const literal = {
    id: 'old-tag',
    dimension: 'source',
    proof: 'render-literal',
    scope,
    renderSourceRevision: 'source-old',
    sourceRefIds: [source.id],
    sourceRefBindings: [historic],
    region: { start: 12, end: 20 },
    label: 'Observed authored tag',
  };
  const candidate = {
    id: 'current-candidate',
    dimension: 'source',
    proof: 'static-selector',
    scope,
    sourceRefIds: [source.id],
    sourceRefBindings: [source],
  };
  const result = resolveInspectionEvidence(packet([literal, candidate], [historic, source]));
  assert.equal(result.source.status, 'stale');
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(new Set(result.source.refs.map((ref) => ref.status)), new Set(['stale', 'candidate']));
  const old = result.source.refs.find((ref) => ref.contentRevision === 'content-old');
  assert.equal(old.region.start, 12);
  assert.equal(old.evidenceLabel, 'Observed authored tag');
  const sameContent = resolveInspectionEvidence(
    packet(
      [{ ...literal, renderSourceRevision: scope.sourceRevision, sourceRefBindings: [source] }],
      [source, { ...source, region: { start: 0, end: 100 } }],
    ),
  );
  assert.equal(
    sameContent.source.status,
    'exact',
    'same definition with a different observation region is not a contradictory source identity',
  );
});

test('the same global revision cannot silently choose between content versions without an observation binding', () => {
  const changed = { ...source, contentRevision: 'changed-content' };
  const literal = { id: 'tag', dimension: 'source', proof: 'render-literal', scope, sourceRefIds: [source.id] };
  assert.equal(resolveInspectionEvidence(packet([literal], [source, changed])).source.status, 'conflicting');
  const bound = resolveInspectionEvidence(
    packet([{ ...literal, sourceRefBindings: [source] }], [source, changed], { currentSourceRefs: [changed] }),
  );
  assert.equal(bound.source.status, 'stale');
  assert.equal(bound.source.refs[0].contentRevision, source.contentRevision);
});

test('lazy source hydration keeps the observed owner while current source membership is pending', () => {
  const waiting = resolveInspectionEvidence(packet([owner], [{ ...source, currentState: 'pending' }]));
  assert.equal(waiting.owner.status, 'exact');
  assert.equal(waiting.source.status, 'unavailable');
  assert.equal(waiting.source.refs[0].status, 'unavailable');
  const hydrated = resolveInspectionEvidence(
    packet([owner], [{ ...source, currentState: 'available', currentContentRevision: source.contentRevision }]),
  );
  assert.equal(hydrated.owner.status, 'exact');
  assert.equal(hydrated.source.status, 'exact');
});

test('unrelated bounded scans do not erase direct bindings and all bounds stay explicit', () => {
  const result = resolveInspectionEvidence(
    packet([owner], [source], {
      completeness: { complete: false, reasons: ['closed-shadow-boundary'], omitted: { candidates: 5 } },
    }),
  );
  assert.equal(result.owner.status, 'exact');
  assert.equal(result.source.status, 'exact');
  assert.equal(result.limits.truncated, true);
  assert.ok(result.limits.reasons.includes('closed-shadow-boundary'));
});

test('browser serialization uses the same complete policy, with no closure imports or private source fields', () => {
  const browserRuntime = new Function(`return (${inspectionEvidenceRuntime.toString()})();`)();
  assert.deepEqual(browserRuntime.resolveInspectionEvidence(packet()), resolveInspectionEvidence(packet()));
  const clean = normalizeInspectionSourceRef({
    ...source,
    file: 'private-path',
    body: 'private-body',
    token: 'private-token',
    editTarget: { secret: true },
  });
  for (const key of ['file', 'body', 'token', 'editTarget']) assert.equal(key in clean, false);
  assert.equal(resolveInspectionEvidence({ scope: null }).owner.status, 'unavailable');
});
