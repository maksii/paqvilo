// @test-kind contract: shared selection-evidence markup of the panel Inspect tab and the X-ray card (designed UI)
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInspectionEvidence } from '../lense/inspection-evidence-ui.mjs';

const evidence = (sourceStatus = 'exact') => ({
  version: 1,
  owner: { status: 'exact', component: { kind: 'form', name: 'Invented form' }, evidence: [{ kind: 'rendered-id' }] },
  source: {
    status: sourceStatus,
    refs: [
      {
        name: 'Invented source',
        kind: 'script',
        ref: 'invented.js',
        key: 'synthetic-key',
        sourceRevision: 'source-1',
        contentRevision: 'content-1',
        region: { start: 4, end: 8 },
        observations: { served: 'observed', executed: 'unavailable' },
      },
    ],
  },
  enclosing: [],
  facts: [],
  candidates: [],
  conflicts: [],
  unavailable: [],
  limits: { truncated: false },
});

// Visible text only: tags and attribute values (tooltips, labels) removed.
const visible = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('shared summary keeps exact ownership independent of stale source and disables stale exact actions', () => {
  const input = evidence('stale');
  input.source.refs[0].status = 'exact';
  const html = renderInspectionEvidence(input);
  assert.match(html, /data-owner-status="exact" data-source-status="stale"/);
  assert.match(
    html,
    /aria-label="Open Invented source in the editor" title="The page or your sources changed[^"]*"[^>]*disabled/,
  );
  // Empty disclosures are not rendered: only the component and its source file.
  assert.equal((html.match(/data-evidence-role=/g) ?? []).length, 2);
  // Only what was seen on the page is stated; an unobserved step is not news.
  assert.match(visible(html), /Loaded by this page/);
  assert.doesNotMatch(visible(html), /Ran on this page|not observed|Execution/);
});

test('candidate source actions are explicit and carry both revisions and exact requested region in both UIs', () => {
  const input = evidence('candidate');
  for (const context of ['panel', 'xray']) {
    const html = renderInspectionEvidence(input, { context });
    assert.match(
      html,
      /data-source-key="synthetic-key" data-source-revision="source-1" data-content-revision="content-1"/,
    );
    assert.match(html, /data-source-region="\{&quot;start&quot;:4,&quot;end&quot;:8\}"/);
    assert.match(
      html,
      /data-focus-key="evidence-source-synthetic-key-open" aria-label="Open Invented source in the editor" title="Open Invented source in the editor at the matching line"/,
    );
    assert.match(
      html,
      context === 'panel' ? /data-act="open" data-rel="invented.js"/ : /data-action="open" data-ref="invented.js"/,
    );
    assert.doesNotMatch(html, /aria-label="Open Invented source in the editor"[^>]*disabled/);
    assert.match(html, /data-status="candidate"[^>]*>Likely</);
  }
});

test('the field hierarchy is visible before source actions and keeps explicit form, table, basic-form and webpage roles', () => {
  const input = evidence();
  input.owner.component = { kind: 'column', name: 'Title', entity: 'sample_entry' };
  input.enclosing = [
    ['form', 'Entry form'],
    ['table', 'Entry'],
    ['basic-form', 'Portal editor'],
    ['webpage', 'Host page'],
  ].map(([kind, name]) => ({ component: { kind, key: kind, name }, status: 'exact', relationship: 'contains' }));
  for (const context of ['panel', 'xray']) {
    const html = renderInspectionEvidence(input, { context });
    assert.deepEqual(
      [...html.matchAll(/data-hierarchy-kind="([^"]+)"/g)].map((match) => match[1]),
      ['column', 'form', 'table', 'basic-form', 'webpage'],
    );
    assert.match(
      html,
      /data-disclosure="evidence-enclosing" open><summary class="gh"[^>]*><svg[^>]*>.*?<\/svg><span>Contained in</,
    );
    assert.ok(html.indexOf('Host page') < html.indexOf('data-evidence-role="source"'));
  }
});

test('unverified, conflicting and unavailable refs cannot open through the legacy path fallback', () => {
  for (const certainty of ['conflicting', 'unavailable'])
    assert.match(
      renderInspectionEvidence(evidence(certainty)),
      /aria-label="Open Invented source in the editor"[^>]*disabled/,
    );
  const input = evidence();
  delete input.source.refs[0].contentRevision;
  assert.match(
    renderInspectionEvidence(input),
    /aria-label="Open Invented source in the editor" title="Refresh inspection, then select the element again to open this file." disabled/,
  );
  assert.match(
    renderInspectionEvidence({ ...input, version: 2 }),
    /data-owner-status="unavailable" data-source-status="unavailable"/,
  );
});

test('the serialized renderer escapes metadata and exposes truncation without confidence scores or owner promotion', () => {
  const render = new Function(`return (${renderInspectionEvidence.toString()})`)();
  const input = evidence();
  input.owner.component.name = '<img src=x onerror="invented()">';
  input.source.refs[0].ref = 'invented" data-act="unsafe';
  input.candidates = [{ component: { name: 'Alternative' }, reason: 'shared-selector', score: 0.99 }];
  input.limits = { truncated: true, reasons: ['root-scan-budget'] };
  const html = render(input, { context: 'panel' });
  assert.doesNotMatch(html, /<img|data-act="unsafe"|99%|0\.99/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<span>Search limits<\/span><\/summary><div class="banner">Not all matches are shown\.<\/div>/);
  assert.match(html, /data-disclosure="evidence-alternatives"><summary[^>]*>.*?<span>Other possible matches</);
  // Machine reason codes never become visible text.
  assert.doesNotMatch(html, /shared-selector|shared selector|root-scan-budget|root scan budget/);
  assert.match(render(null, { part: 'styles' }), /summary:focus-visible/);
});

test('limits list what was skipped in plain words and stay distinct from selected attribution', () => {
  const input = evidence();
  input.limits = {
    truncated: true,
    omitted: { candidates: 15, markupSources: 1, otherKind: 3 },
    sources: [
      { ref: 'templates/large<source>.html', reason: 'Skipped: file too large to search' },
      { ref: 'templates/other.html', reason: 'index-omission' },
    ],
  };
  const html = renderInspectionEvidence(input);
  // The count is the kit's count pill.
  assert.match(html, /<span>Search limits <span class="n dimn" title="Not shown">16<\/span><\/span><\/summary>/);
  assert.match(html, /15 more matches not shown · 1 large file skipped/);
  assert.doesNotMatch(html, /otherKind|markupSources|index-omission/);
  assert.match(html, /Files skipped by the search/);
  assert.match(
    html,
    /<span>Skipped: file too large to search<\/span><\/div><div class="sub path" title="templates\/large&lt;source&gt;\.html"><bdi>templates\/large&lt;source&gt;\.html<\/bdi>/,
  );
  assert.match(
    html,
    /<span>Skipped file<\/span><\/div><div class="sub path" title="templates\/other\.html"><bdi>templates\/other\.html</,
  );
  assert.match(html, /data-owner-status="exact" data-source-status="exact"/);
  // Nothing limited: no limits disclosure at all.
  assert.doesNotMatch(renderInspectionEvidence(evidence()), /data-evidence-role="limits"/);
});

test('direct current source precedes alternatives and historical refs without promoting them', () => {
  const input = evidence();
  input.source.refs.unshift({ ...input.source.refs[0], name: 'Alternative source', status: 'candidate' });
  input.source.refs.unshift({ ...input.source.refs[0], name: 'Historical source', status: 'stale' });
  const html = renderInspectionEvidence(input);
  assert.ok(html.indexOf('Invented source') < html.indexOf('Alternative source'));
  assert.ok(html.indexOf('Alternative source') < html.indexOf('Historical source'));
  assert.match(html, /<span>Historical source<\/span><span[^>]*data-status="stale"[^>]*>Outdated</);
  assert.match(html, /<h4 class="gh">Source files<\/h4>/);
});

test('compact panel summary names the selected file once, without repeating the certainty badges of the details', () => {
  const input = evidence('stale');
  input.source.refs[0].fieldPath = ['fields', 'value'];
  input.source.refs.unshift({ ...input.source.refs[0], ref: 'historical.html', status: 'unavailable' });
  input.source.refs[1].status = 'exact';
  const html = renderInspectionEvidence(input, { part: 'headline', context: 'panel' });
  assert.match(html, /data-evidence-source-context[^>]*><bdi>invented.js · Field: fields.value · \+1 more file</);
  // The headline repeats the file the open details list; it shows only while the summary is collapsed.
  assert.match(
    renderInspectionEvidence(null, { part: 'styles' }),
    /details\[open\]>summary \[data-evidence-headline\]\{display:none\}/,
  );
  assert.doesNotMatch(html, /historical.html|data-act=|data-action=|data-status=|Owner|Component/);
  assert.equal(renderInspectionEvidence(input, { part: 'headline' }), '');
});

test('enclosing components with a local definition offer the same compact actions as source rows; others none', () => {
  const input = evidence();
  input.enclosing = [
    {
      status: 'exact',
      relationship: 'current-view',
      component: { kind: 'view', key: 'view:a', id: 'view-id-a', name: 'Active entries', entity: 'sample_entry' },
      refs: [
        {
          ref: 'views/a.xml',
          key: 'view-key',
          sourceRevision: 'source-1',
          contentRevision: 'content-2',
          status: 'exact',
        },
      ],
    },
    { status: 'candidate', relationship: 'declares', component: { kind: 'list', key: 'list:b', name: 'Entries' } },
  ];
  for (const context of ['panel', 'xray']) {
    const html = renderInspectionEvidence(input, { context });
    const view = html.split('data-hierarchy-key=')[1],
      list = html.split('data-hierarchy-key=')[2];
    const act = context === 'panel' ? 'data-act' : 'data-action';
    assert.match(
      view,
      new RegExp(
        `^"view:a"><div class="main"><div class="name" title="View · Table: sample_entry · ID: view-id-a"><span>Active entries</span><span class="what">View</span><span class="ie-rel" data-relation title="The view shown here" role="img" aria-label="The view shown here">Shown here</span><span class="c ok ie-state" data-status="exact"`,
      ),
    );
    assert.match(
      view,
      new RegExp(
        `${act}="open" data-(?:rel|ref)="views/a.xml" data-source-key="view-key" data-source-revision="source-1" data-content-revision="content-2"`,
      ),
    );
    assert.match(
      view,
      /class="ib" [^>]*aria-label="Open view Active entries in the editor" title="Open view Active entries in the editor"><svg[^>]*><path d="M6 4 2 8l4 4M10 4l4 4-4 4"\/>/,
    );
    assert.match(
      view,
      new RegExp(
        `class="ib" ${act}="copy" data-copy="views/a.xml"[^>]*aria-label="Copy the source reference of view Active entries" title="Copy the source reference of view Active entries"`,
      ),
    );
    assert.match(
      view,
      /<div class="sub" title="View · Table: sample_entry · ID: view-id-a">Table: sample_entry<\/div>/,
    );
    // The relation is the tooltip; the row shows the kind.
    assert.match(
      list,
      /<div class="name"><span>Entries<\/span><span class="what">List<\/span><span class="ie-rel" data-relation title="Used on this page" role="img" aria-label="Used on this page">On this page<\/span>/,
    );
    assert.doesNotMatch(list.split('</details>')[0], /<button|class="acts"/);
  }
});

test('certainty badges explain what each state means for the row they are on', () => {
  const input = evidence('candidate');
  input.enclosing = [
    {
      status: 'exact',
      relationship: 'contains',
      component: { kind: 'basic-form', key: 'basic-form:a', name: 'Editor' },
    },
    { status: 'candidate', relationship: 'defined-on', component: { kind: 'table', key: 'table:a', name: 'entry' } },
  ];
  const html = renderInspectionEvidence(input);
  const title = (name) =>
    new RegExp(
      `<span>${name}</span>(?:<span class="what">[^<]*</span>)?(?:<span class="ie-rel"[^>]*>[^<]*</span>)?<span class="c [a-z]+ ie-state" data-status="[a-z]+" title="([^"]*)"`,
    ).exec(html)?.[1];
  assert.equal(title('Invented form'), 'Identified from the selected element itself.');
  assert.equal(title('Editor'), 'Identified on this page around the selected element.');
  assert.match(title('entry'), /^Found through the configuration in your sources, not identified on this page\./);
  assert.match(title('Invented source'), /^This file matches the element by name or markup, but may not be the one/);
  // The "selected element itself" wording belongs to the component row only.
  assert.equal(html.split('title="Identified from the selected element itself.').length, 2);
});

test('the component row carries its own file, so the same file is not listed again under source files', () => {
  const input = evidence();
  input.owner.component = { kind: 'column', key: 'column:entry:title', name: 'sample_title', entity: 'entry' };
  input.owner.evidence = [{ kind: 'native-field-id', label: 'Matched by field name on the page' }];
  input.source.refs = [
    {
      ...input.source.refs[0],
      name: 'sample_title',
      kind: 'column',
      ref: '@solution/Entities/entry/Entity.xml',
      componentKey: 'column:entry:title',
      fieldPath: ['fields', 'sample_title'],
      status: 'exact',
      observations: undefined,
    },
  ];
  const html = renderInspectionEvidence(input, { context: 'xray' });
  assert.equal(visible(html).split('Entity.xml').length, 2, html);
  assert.match(html, /data-evidence-role="owner"[\s\S]*aria-label="Open column sample_title in the editor"/);
  // The X-ray card header names the component and carries its badge: the row keeps the facts and the file only.
  const owner = html.split('data-evidence-role="owner"')[1].split('</div>\n')[0];
  // Its field path ends in its own name (fields.sample_title), which the header already shows.
  assert.match(owner, /<div class="sub"[^>]*>Table: entry<\/div>/);
  assert.match(
    owner,
    /<div class="sub path" title="@solution\/Entities\/entry\/Entity\.xml"><bdi>@solution\/Entities\/entry\/Entity\.xml<\/bdi><\/div>/,
  );
  assert.doesNotMatch(owner, /Component|>sample_title<|data-status=/);
  assert.match(
    renderInspectionEvidence(input, { part: 'badge' }),
    /^<span class="c ok ie-state" data-status="exact" title="Identified from the selected element itself\.\nMatched by field name on the page"/,
  );
  assert.equal(
    renderInspectionEvidence({ ...input, owner: { status: 'unavailable', component: null } }, { part: 'badge' }),
    '',
  );
  // The panel names the selection only in its summary line, so its row keeps the name, the kind and the badge.
  assert.match(
    renderInspectionEvidence(input, { context: 'panel' }),
    /<span>sample_title<\/span><span class="what">Column<\/span><span class="c ok ie-state" data-status="exact"/,
  );
  assert.doesNotMatch(html, /data-evidence-role="source"|No source file found/);
  // An outdated own file stays a source row, where its badge says so.
  const outdated = structuredClone(input);
  outdated.source.status = 'stale';
  outdated.source.refs[0].status = 'stale';
  assert.match(
    renderInspectionEvidence(outdated, { context: 'xray' }),
    /data-evidence-role="source"><h4 class="gh">Source file<\/h4>[\s\S]*<span>sample_title<\/span><span class="c warn ie-state" data-status="stale"/,
  );
  // A second file stays a source row.
  input.source.refs.push({ ...evidence().source.refs[0], status: 'candidate' });
  const both = renderInspectionEvidence(input, { context: 'xray' });
  assert.match(both, /data-evidence-role="source"><h4 class="gh">Source file<\/h4>[\s\S]*Invented source/);
});

test('without a component nothing restates "not established"; raw codes and empty sections stay out of view', () => {
  const input = evidence('candidate');
  input.owner = { status: 'unavailable', component: null, evidence: [] };
  input.unavailable = [
    { dimension: 'owner', reason: 'no-current-direct-owner-proof' },
    { dimension: 'all', reason: 'invalid-selection-scope', label: 'Select the element again.' },
  ];
  input.conflicts = [{ dimension: 'source', reason: 'contradictory-current-source-evidence' }];
  input.limits = { truncated: false, reasons: ['node-not-proved', 'native-structure-generation-changed'] };
  input.enclosing = [
    {
      status: 'candidate',
      relationship: 'invented-relationship',
      component: { kind: 'webpage', key: 'webpage:a', name: 'Home' },
    },
  ];
  const html = renderInspectionEvidence(input);
  const text = visible(html);
  assert.doesNotMatch(html, /data-evidence-role="owner"|Not established|Owner|Unavailable/);
  // The conflict without a label of its own still says what it means.
  assert.match(
    text,
    /Several matches claim this element\. Check which one applies before you edit\. Select the element again\. The app redrew the form\. Select the element again\./,
  );
  assert.doesNotMatch(
    text,
    /no current|no-current|node-not-proved|invented-relationship|invented relationship|contradictory/,
  );
  assert.match(text, /Home Web page Likely/);
  for (const role of ['context', 'alternatives', 'limits'])
    assert.doesNotMatch(html, new RegExp(`data-evidence-role="${role}"`));
});

test('each open and copy button names its own row for screen readers', () => {
  const input = evidence();
  input.enclosing = [
    ['list', 'Projects'],
    ['webpage', 'Projects'],
  ].map(([kind, name]) => ({
    status: 'candidate',
    relationship: 'contains',
    component: { kind, key: kind + ':a', name },
    refs: [{ ref: kind + '.yml', key: kind, sourceRevision: 's', contentRevision: 'c', status: 'candidate' }],
  }));
  const html = renderInspectionEvidence(input, { context: 'panel' });
  const names = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(names).size, names.length, names.join(' | '));
  assert.ok(
    names.includes('Open list Projects in the editor') && names.includes('Open web page Projects in the editor'),
  );
});

// Under a page CSP without 'unsafe-inline' styles, a style attribute in Lense markup is reported as a page error.
test('no part of the shared markup carries a style attribute, so a strict style-src CSP reports nothing', () => {
  const input = evidence();
  input.source.refs.push({ ...input.source.refs[0], ref: 'second.js', status: 'candidate' });
  input.limits = { truncated: true, sources: [{ ref: 'large.html' }] };
  for (const context of ['panel', 'xray', undefined])
    for (const part of [undefined, 'headline', 'badge'])
      assert.doesNotMatch(renderInspectionEvidence(input, { context, part }), /\sstyle=/i, `${context} ${part}`);
});

test('a certainty badge names its meaning for screen readers, not only in a mouse tooltip', () => {
  const html = renderInspectionEvidence(evidence('candidate'), { context: 'xray' });
  assert.match(
    html,
    /<span class="c warn ie-state" data-status="candidate" title="(This file matches[^"]*)" role="img" tabindex="0" aria-label="Likely: \1">Likely<\/span>/,
  );
});

test('a relation is a short visible badge on the row, its sentence in the tooltip and the accessible name', () => {
  const input = evidence();
  input.enclosing = [
    { status: 'exact', relationship: 'current-view', component: { kind: 'view', key: 'view:a', name: 'Active' } },
    { status: 'candidate', relationship: 'defined-on', component: { kind: 'table', key: 'table:a', name: 'entry' } },
    {
      status: 'candidate',
      relationship: 'configured-webpage',
      component: { kind: 'webpage', key: 'webpage:a', name: 'Home' },
    },
    { status: 'candidate', relationship: 'declares', component: { kind: 'form', key: 'form:b', name: 'Other' } },
  ];
  for (const context of ['panel', 'xray']) {
    const html = renderInspectionEvidence(input, { context });
    for (const [short, sentence] of [
      ['Shown here', 'The view shown here'],
      ['Its table', 'The table of this element'],
      // One word for one relation in both runtimes: what contains the element says so.
      ['Contains it', 'The web page of this address, which contains this element'],
      ['On this page', 'Used on this page'],
    ]) {
      assert.match(visible(html), new RegExp(short));
      assert.ok(
        html.includes(
          `<span class="ie-rel" data-relation title="${sentence}" role="img" aria-label="${sentence}">${short}</span>`,
        ),
        sentence,
      );
    }
    // The sentence is no longer hidden in the name's tooltip only.
    assert.doesNotMatch(html, /<div class="name" title="The view shown here/);
  }
  // A row a host lists itself (X-ray's markup matches) takes the same badge.
  const row = renderInspectionEvidence(null, {
    part: 'row',
    context: 'xray',
    row: { name: 'Header', path: 'a.html', relation: ['Parent', 'Markup matches header.top on a parent element'] },
  });
  assert.match(
    row,
    /<span>Header<\/span><span class="ie-rel" data-relation title="Markup matches header.top on a parent element" role="img" aria-label="Markup matches header.top on a parent element">Parent<\/span>/,
  );
});

test('a certainty badge is reachable by keyboard', () => {
  const html = renderInspectionEvidence(evidence());
  assert.ok(html.match(/class="c [a-z]+ ie-state"/g).length >= 2);
  for (const chip of html.match(/<span class="c [a-z]+ ie-state"[^>]*>/g)) assert.match(chip, /tabindex="0"/);
});

test('GUIDs and internal field names never reach the visible text', () => {
  const formId = 'fa110000-0000-4000-8000-000000000078';
  const input = evidence();
  input.owner.component = { kind: 'control', key: 'control:x', name: 'sample_budget', formId };
  input.source.refs[0].fieldPath = ['$record'];
  input.enclosing = [
    { status: 'exact', relationship: 'contains', component: { kind: 'form', key: 'form:' + formId, name: formId } },
  ];
  input.facts = [
    {
      status: 'exact',
      relationship: 'contains',
      component: {
        kind: 'section',
        key: 'section:' + formId,
        name: `${formId}:{d3002aa1-0bbb-4415-8bc2-29e49766c0af}`,
      },
    },
    { status: 'exact', relationship: 'contains', component: { kind: 'table', key: 'table:sample', name: 'sample' } },
  ];
  for (const context of ['panel', 'xray']) {
    const html = renderInspectionEvidence(input, { context, openGroups: ['enclosing', 'context'] });
    const text = visible(html);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/i);
    assert.doesNotMatch(text, /\$record/);
    // The form without a display name is named by its kind; the nameless section adds no row; the table stays.
    assert.match(
      html,
      /data-hierarchy-key="form:fa110000[^"]*"><div class="main"><div class="name"[^>]*><span>Form<\/span><span class="ie-rel"/,
    );
    assert.doesNotMatch(text, /Section/);
    assert.match(text, /sample Table/);
    for (const field of ['name', 'source']) {
      input.source.refs[0].fieldPath = [field];
      assert.doesNotMatch(visible(renderInspectionEvidence(input, { context })), /Field:/);
    }
    input.source.refs[0].fieldPath = ['$record'];
  }
});

test('the empty source state and notices use the kit empty state and banner', () => {
  const input = evidence();
  input.source = { status: 'unavailable', refs: [] };
  input.conflicts = [{ label: 'First notice' }, { label: 'Second notice' }];
  const html = renderInspectionEvidence(input);
  assert.match(html, /<div class="empty">No source file found<\/div>/);
  assert.match(html, /<div class="banner">First notice<\/div><div class="banner">Second notice<\/div>/);
  assert.doesNotMatch(
    renderInspectionEvidence(null, { part: 'styles' }),
    /\.inspection-evidence \.(?:banner|ie-empty|gh\{[^}]*font-size)/,
  );
});

test('a file under the source folder shows its path from there; the full path stays in the tooltip', () => {
  const sourceDir = String.raw`C:\Invented\sources`;
  const full = String.raw`C:\Invented\sources\solution\Entities\entry\FormXml\main.xml`;
  const input = evidence();
  input.sourceDir = sourceDir;
  input.owner.component = { kind: 'control', key: 'control:budget', name: 'sample_budget' };
  input.source.refs = [
    {
      ...input.source.refs[0],
      name: 'sample_budget',
      componentKey: 'control:budget',
      ref: full,
      fieldPath: ['controls', 'sample_budget'],
      status: 'exact',
    },
  ];
  for (const context of ['panel', 'xray']) {
    const html = renderInspectionEvidence(input, { context });
    assert.ok(
      html.includes(`title="${full}"><bdi>solution/Entities/entry/FormXml/main.xml</bdi>`),
      `${context}: ${html}`,
    );
    // The field path ends in the row's own name: it is not shown.
    assert.doesNotMatch(visible(html), /Field:|controls\./);
  }
  const headline = renderInspectionEvidence(input, { part: 'headline', context: 'panel' });
  assert.match(headline, /<bdi>solution\/Entities\/entry\/FormXml\/main\.xml<\/bdi>/);
  assert.ok(headline.includes(`title="${full}"`));
  // A file outside the source folder keeps its full path.
  input.source.refs[0].ref = String.raw`D:\elsewhere\main.xml`;
  assert.ok(
    renderInspectionEvidence(input, { context: 'xray' }).includes(String.raw`<bdi>D:\elsewhere\main.xml</bdi>`),
  );
});

test('a Solution path shows an ID segment as {…}, and a component is named display name · logical name', () => {
  const full = 'solution/Entities/entry/FormXml/main/{fa110000-0000-4000-8000-0000000000aa}.xml';
  const input = evidence();
  input.owner.component = { kind: 'column', key: 'column:entry:sample_title', label: 'Title', name: 'sample_title' };
  input.source.refs = [{ ...input.source.refs[0], ref: full }];
  const html = renderInspectionEvidence(input, { context: 'panel' });
  assert.ok(html.includes(`title="${full}"><bdi>solution/Entities/entry/FormXml/main/{…}.xml</bdi>`), html);
  assert.ok(html.includes('data-copy="' + full + '"'), 'the copy is the full path');
  assert.match(html, /<span>Title · sample_title<\/span><span class="what">Column<\/span>/);
  // The panel's one-line summary uses the same display.
  assert.match(
    renderInspectionEvidence(input, { part: 'headline', context: 'panel' }),
    /<bdi>solution\/Entities\/entry\/FormXml\/main\/\{…\}\.xml<\/bdi>/,
  );
  // Narrow rows: a row's chips wrap onto their own line and its reason line wraps, so the name keeps its width.
  assert.match(renderInspectionEvidence(null, { part: 'styles' }), /\.ie-row \.name\{flex-wrap:wrap/);
});
