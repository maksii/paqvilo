// @test-kind contract: Paqvilo's own evidence policy for Lense selections (owner, source and enclosing certainty rules)
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

test('an enclosing component keeps its exported definition files so it offers the same source actions', () => {
  const view = { kind: 'view', key: 'view:a', id: 'a', name: 'Active entries', entity: 'sample_entry' };
  const viewSource = {
    ...source,
    id: 'view-source',
    key: 'view:a:definition',
    componentKey: view.key,
    ref: 'views/a.xml',
  };
  const enclosing = (proof, extra = {}) => ({
    ...owner,
    id: 'enclosing-' + proof,
    dimension: 'enclosing',
    proof,
    predicate: 'current-view',
    binding: view,
    sourceRefIds: [viewSource.id],
    ...extra,
  });
  const exact = resolveInspectionEvidence(packet([owner, enclosing('native-component-id')], [source, viewSource]));
  assert.equal(exact.enclosing[0].status, 'exact');
  assert.deepEqual(
    exact.enclosing[0].refs.map((ref) => [ref.ref, ref.status, ref.sourceRevision, ref.contentRevision]),
    [['views/a.xml', 'exact', scope.sourceRevision, 'content-a']],
  );
  assert.equal(
    exact.source.refs.some((ref) => ref.ref === 'views/a.xml'),
    false,
    'containment is not the source',
  );
  const declared = resolveInspectionEvidence(packet([owner, enclosing('declared-include')], [source, viewSource]));
  assert.equal(declared.enclosing[0].refs[0].status, 'candidate');
  const changed = resolveInspectionEvidence(
    packet([owner, enclosing('native-component-id')], [source, { ...viewSource, currentContentRevision: 'content-b' }]),
  );
  assert.equal(changed.enclosing[0].refs[0].status, 'stale');
  const none = resolveInspectionEvidence(packet([owner, enclosing('native-component-id', { sourceRefIds: [] })]));
  assert.deepEqual(none.enclosing[0].refs, []);
  assert.equal(none.facts.length, 0, 'no filler context row');
});

test('evidence carries plain-word labels for known proofs and notices, and none for raw codes', () => {
  const result = resolveInspectionEvidence(packet([{ ...owner, proof: 'native-field-id' }]));
  assert.deepEqual(
    result.owner.evidence.map((item) => item.label),
    ['Matched by field ID on the page'],
  );
  assert.equal(result.source.refs[0].evidenceLabel, 'Defined in this file');
  // A producer's own label wins; an unknown proof is never de-hyphenated into text.
  const labelled = resolveInspectionEvidence(packet([{ ...owner, proof: 'native-dom', label: 'Matched by name' }]));
  assert.equal(labelled.candidates[0].label, 'Matched by name');
  const unknown = resolveInspectionEvidence(packet([{ ...owner, proof: 'invented-proof' }]));
  assert.equal(unknown.candidates[0].label, undefined);
  assert.equal(unknown.candidates[0].reason, 'invented-proof', 'the code stays available to tools');
  // "No proof" notices restate the Not found badge: they keep their code but get no text.
  const empty = resolveInspectionEvidence(packet([], []));
  assert.deepEqual(
    empty.unavailable.map((item) => [item.reason, item.label]),
    [
      ['no-current-direct-owner-proof', undefined],
      ['no-current-editable-source-proof', undefined],
    ],
  );
  assert.equal(resolveInspectionEvidence({ version: 2 }).unavailable[0].label, 'Select the element again.');
  const conflict = resolveInspectionEvidence(
    packet([owner, { ...owner, id: 'other', binding: { ...field, key: 'field:sample_entry:other', name: 'other' } }]),
  );
  assert.equal(conflict.conflicts[0].label, 'Several components match this element.');
});

test('context names each component and relation once, never the owner, and keeps the current form as context', () => {
  // A model-driven provider reports the table and the form once per enclosing region: the same component many times.
  const form = { kind: 'form', key: 'form:a', name: 'Entry form' };
  const table = { kind: 'table', key: 'table:sample_entry', name: 'sample_entry' };
  const context = (id, binding) => ({
    ...owner,
    id,
    dimension: 'context',
    predicate: 'contains',
    binding,
    sourceRefIds: [],
  });
  const result = resolveInspectionEvidence(
    packet([
      owner,
      { ...owner, id: 'open-form', dimension: 'enclosing', predicate: 'contains', binding: form, sourceRefIds: [] },
      context('table-1', table),
      context('form-1', form),
      context('table-2', table),
      context('form-2', { ...form, name: 'a' }),
      context('owner-again', field),
      // The same form in another relation (the page's current form) is distinct context and stays.
      { ...context('form-current', form), predicate: 'current-form' },
    ]),
  );
  assert.deepEqual(
    result.enclosing.map((row) => row.component.key),
    ['form:a'],
  );
  assert.deepEqual(
    result.facts.map((row) => [row.component.key, row.relationship]),
    [
      ['table:sample_entry', 'contains'],
      ['form:a', 'contains'],
      ['form:a', 'current-form'],
    ],
  );
});

test('a Mirage registry match names Mirage, never a file it did not report', () => {
  const result = resolveInspectionEvidence(packet([{ ...owner, sourceRefIds: [] }], []));
  assert.equal(result.owner.status, 'exact');
  assert.equal(result.source.status, 'unavailable');
  assert.deepEqual(
    result.owner.evidence.map((item) => item.label),
    ['Identified by Mirage'],
  );
});

test('a fact about the owner in another relation keeps its producer reason as its label', () => {
  // A mounted code component reports its form factor on its own component: that fact is not a repeat of the owner.
  const result = resolveInspectionEvidence(
    packet([
      owner,
      {
        ...owner,
        id: 'mounted',
        dimension: 'context',
        predicate: 'mounted-form-factor',
        reason: 'pcf-form-factor-0',
        sourceRefIds: [],
      },
    ]),
  );
  assert.deepEqual(
    result.facts.map((fact) => [fact.relationship, fact.label]),
    [['mounted-form-factor', 'pcf-form-factor-0']],
  );
});

const template = {
  id: 'template-source',
  key: 'webtemplate:layout:source',
  kind: 'webtemplate',
  ref: 'web-templates/layout/Layout.webtemplate.source.html',
  name: 'Layout',
  sourceRevision: scope.sourceRevision,
  contentRevision: 'layout-content',
};
const servedFact = (kind, extra = {}) => ({
  id: 'served',
  scope,
  dimension: 'source',
  kind,
  subject: 'selection',
  predicate: 'created-by',
  sourceRefIds: [template.id],
  region: { start: 12, end: 40, line: 2, column: 3 },
  renderSourceRevision: scope.sourceRevision,
  ...extra,
});

test('markup found in a served live page where the export puts it is an exact source; generated markup names its Liquid code', () => {
  const literal = resolveInspectionEvidence({
    version: 1,
    scope,
    mode: 'live',
    facts: [servedFact('served-literal')],
    sourceRefs: [template],
  });
  assert.equal(literal.source.status, 'exact');
  assert.deepEqual(
    [literal.source.refs[0].ref, literal.source.refs[0].region.line, literal.source.refs[0].evidenceLabel],
    [template.ref, 2, 'Found at this place in the served page'],
  );
  const generated = resolveInspectionEvidence({
    version: 1,
    scope,
    mode: 'live',
    facts: [servedFact('served-generated', { predicate: 'implementation' })],
    sourceRefs: [template],
  });
  assert.deepEqual(
    [generated.source.status, generated.source.refs[0].evidenceLabel],
    ['exact', 'Generated by this Liquid code'],
  );
  // The tag that wrote it, as the served binding carries it, names it; control flow around it does not, and the list
  // is bounded.
  const tagged = (liquid) =>
    resolveInspectionEvidence({
      version: 1,
      scope,
      mode: 'live',
      facts: [servedFact('served-generated', { predicate: 'implementation', liquid })],
      sourceRefs: [template],
    }).source.refs[0].evidenceLabel;
  assert.equal(
    tagged([
      { kind: 'tag', name: 'if' },
      { kind: 'tag', name: 'entityform' },
      { kind: 'tag', name: 'endif' },
    ]),
    'Generated by the entityform tag',
  );
  assert.equal(tagged([{ kind: 'output', name: 'page' }]), 'Generated by this Liquid code');
  assert.equal(
    tagged([
      { kind: 'tag', name: 'entityform' },
      { kind: 'tag', name: 'entitylist' },
    ]),
    'Generated by this Liquid code',
    'two component tags do not name one writer',
  );
  assert.equal(tagged([{ kind: 'tag', name: 'x'.repeat(65) }]), 'Generated by this Liquid code');
  assert.equal(
    tagged([...Array(4).fill({ kind: 'tag', name: 'if' }), { kind: 'tag', name: 'entityform' }]),
    'Generated by this Liquid code',
    'only the first four tokens are read',
  );
  // What a local render reports is not accepted from a live page.
  const copied = resolveInspectionEvidence({
    version: 1,
    scope,
    mode: 'live',
    facts: [servedFact('render-generated')],
    sourceRefs: [template],
  });
  assert.equal(copied.source.status, 'candidate');
});

test('a place where the deployed copy of a file differs from the local one is likely, never exact', () => {
  const drift = resolveInspectionEvidence({
    version: 1,
    scope,
    mode: 'live',
    facts: [servedFact('served-drift', { predicate: 'implementation' })],
    sourceRefs: [template],
  });
  assert.equal(drift.source.status, 'candidate');
  assert.match(drift.source.refs[0].evidenceLabel, /the deployed version differs here/);
});

test('saving another file does not make a source the page still shows outdated; saving that file does', () => {
  const later = { ...scope, sourceRevision: 'source-b' };
  const input = (changedFiles) => ({
    version: 1,
    scope: later,
    mode: 'live',
    // Made when the page loaded, at the earlier source revision.
    facts: [servedFact('served-literal', { scope: later })],
    sourceRefs: [template],
    ...(changedFiles ? { changedFiles } : {}),
  });
  assert.equal(resolveInspectionEvidence(input()).source.status, 'stale', 'without knowing which files changed');
  assert.equal(
    resolveInspectionEvidence(input(['web-pages/home/Home.webpage.copy.html'])).source.status,
    'exact',
    'another file was saved',
  );
  assert.equal(
    // As a Windows path, in another letter case.
    resolveInspectionEvidence(input([String.raw`Web-Templates\layout\Layout.webtemplate.source.html`])).source.status,
    'stale',
    'the file itself was saved since the page loaded',
  );
  assert.equal(
    Object.keys(resolveInspectionEvidence(input([])).scope).includes('changedFiles'),
    false,
    'the list of changed files is not part of the result',
  );
});

test('an element inside a proven element is contained in it exactly; the portal shell and a loaded file are owners', () => {
  const contained = resolveInspectionEvidence({
    version: 1,
    scope,
    mode: 'live',
    facts: [
      servedFact('served-literal', {
        id: 'container:served',
        dimension: 'enclosing',
        predicate: 'contains',
        binding: { kind: 'markup', key: 'markup:template-source:12', name: 'Layout · div' },
        label: 'Directly inside this element',
      }),
    ],
    sourceRefs: [template],
  });
  assert.equal(contained.owner.status, 'unavailable');
  assert.deepEqual(
    contained.enclosing.map((row) => [row.status, row.component.kind, row.refs[0]?.ref, row.evidence[0].id]),
    [['exact', 'markup', template.ref, 'container:served']],
  );
  const shell = resolveInspectionEvidence({
    version: 1,
    scope,
    mode: 'live',
    facts: [
      {
        id: 'shell',
        scope,
        dimension: 'owner',
        kind: 'served-platform',
        subject: 'selection',
        predicate: 'identity',
        binding: { kind: 'platform-shell', key: 'platform-shell:page', name: 'Page shell' },
        renderSourceRevision: scope.sourceRevision,
      },
    ],
    sourceRefs: [],
  });
  assert.deepEqual([shell.owner.status, shell.owner.component.kind], ['exact', 'platform-shell']);
  const loaded = resolveInspectionEvidence({
    version: 1,
    scope,
    mode: 'live',
    facts: [
      {
        id: 'resource:web-file:logo',
        scope,
        dimension: 'owner',
        proof: 'resource-url',
        subject: 'selection',
        predicate: 'identity',
        binding: { kind: 'web-file', key: 'web-file:logo', id: 'logo', name: 'logo.svg' },
      },
    ],
    sourceRefs: [],
  });
  assert.deepEqual([loaded.owner.status, loaded.owner.evidence[0].label], ['exact', 'Loaded by this element']);
});

test('the view a list shows is one component whether a producer calls it a list view or a view', () => {
  const shown = { key: 'view:invented-view', entity: 'sample_entry', name: 'Invented view' };
  const fact = (id, kind) => ({ ...owner, id, binding: { ...shown, kind }, sourceRefIds: [] });
  const result = resolveInspectionEvidence(packet([fact('registry', 'list-view'), fact('observed', 'view')], []));
  assert.equal(result.owner.status, 'exact');
  assert.equal(result.owner.component.key, 'view:invented-view');
  // Two different views are still two owners.
  const other = { ...fact('observed', 'view'), binding: { ...shown, kind: 'view', key: 'view:another' } };
  assert.equal(
    resolveInspectionEvidence(packet([fact('registry', 'list-view'), other], [])).owner.status,
    'conflicting',
  );
});
