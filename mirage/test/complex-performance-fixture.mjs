// Invented, opt-in scale fixtures. Wide tables carry real imported metadata and
// source customizations; sparse rows represent nullable Dataverse columns.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performanceFixture, performanceId } from './runtime-performance-fixture.mjs';

export async function complexPerformanceFixture({
  tables = 2000,
  records = 10000000,
  existingRoot,
  shape = 'uniform',
  recordStorage = 'paged',
  ...rest
} = {}) {
  if (shape !== 'uniform') throw new TypeError('Complex qualification uses its explicit 80/20 wide-table distribution');
  const fixture = await performanceFixture({
    ...rest,
    tables,
    records,
    existingRoot,
    shape,
    columns: 12,
    tableSources: false,
  });
  const complexTables = Math.ceil(tables / 2),
    simpleTables = tables - complexTables;
  const complexRecords = simpleTables
    ? Math.min(records - simpleTables, Math.max(complexTables, Math.floor(records * 0.8)))
    : records;
  const countFor = (i) => {
    const count = i < complexTables ? complexTables : simpleTables;
    const total = i < complexTables ? complexRecords : records - complexRecords;
    const ordinal = i < complexTables ? i : i - complexTables;
    return Math.floor(total / count) + (ordinal < total % count ? 1 : 0);
  };
  const stride = Math.max(countFor(0), countFor(tables - 1));
  const directories = new Set();
  const write = async (root, relative, body) => {
    fixture.inventory.files++;
    fixture.inventory.sourceBytes += Buffer.byteLength(body);
    if (relative.endsWith('.xml')) fixture.inventory.xmlFiles++;
    if (existingRoot) return;
    const file = path.join(root, relative);
    if (!directories.has(path.dirname(file))) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      directories.add(path.dirname(file));
    }
    await fs.writeFile(file, body);
  };
  const fixed = [
    'x_value0',
    'x_value1',
    'x_value2',
    'x_quantity',
    'x_enabled',
    'x_when',
    'x_choice0',
    'x_memo',
    'x_json',
    'x_rich',
  ];
  const attribute = (name, type = 'nvarchar', extra = '') =>
    `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type><displaynames><displayname description="${name}" languagecode="1033"/><displayname description="Translated ${name}" languagecode="1036"/></displaynames>${extra}</attribute>`;
  for (let i = 0; i < tables; i++) {
    const root = fixture.solutionRoots[i % fixture.solutionRoots.length],
      entity = `x_scale${i}`,
      wide = i < complexTables;
    const links = wide ? Array.from({ length: 200 }, (_, j) => 'x_link' + j) : ['x_link0'];
    const extra = Array.from({ length: wide ? 46 : 21 }, (_, j) => 'x_extra' + j);
    const fields = [...fixed, ...links, ...extra];
    const columns = fields
      .map((name) =>
        attribute(
          name,
          name === 'x_quantity'
            ? 'int'
            : name === 'x_enabled'
              ? 'bit'
              : name === 'x_when'
                ? 'datetime'
                : name === 'x_choice0'
                  ? 'picklist'
                  : name.startsWith('x_link')
                    ? 'lookup'
                    : ['x_memo', 'x_rich', 'x_json'].includes(name)
                      ? 'ntext'
                      : 'nvarchar',
          name === 'x_value1'
            ? '<IsSecured>1</IsSecured>'
            : name === 'x_choice0'
              ? '<optionset><options><option value="1"><labels><label description="Draft" languagecode="1033"/></labels></option><option value="2"><labels><label description="Review" languagecode="1033"/></labels></option><option value="3"><labels><label description="Complete" languagecode="1033"/></labels></option></options></optionset>'
              : '',
        ),
      )
      .join('');
    await write(
      root,
      `Entities/${entity}/Entity.xml`,
      `<Entity><Name>${entity}</Name><EntityInfo><entity Name="${entity}"><EntitySetName>${entity}s</EntitySetName><PrimaryIdAttribute>${entity}id</PrimaryIdAttribute><PrimaryNameAttribute>x_value0</PrimaryNameAttribute><OwnershipTypeMask>UserOwned</OwnershipTypeMask><attributes>${attribute(entity + 'id', 'primarykey')}${columns}</attributes></entity></EntityInfo></Entity>`,
    );
    const relationships = links
      .map(
        (name, j) =>
          `<EntityRelationship Name="${entity}_${name}"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>${entity}</ReferencingEntityName><ReferencedEntityName>x_scale${(i + j + 1) % tables}</ReferencedEntityName><ReferencingAttributeName>${name}</ReferencingAttributeName><ReferencedAttributeName>x_scale${(i + j + 1) % tables}id</ReferencedAttributeName></EntityRelationship>`,
      )
      .join('');
    await write(
      root,
      `Entities/${entity}/Relationships.xml`,
      '<EntityRelationships>' + relationships + '</EntityRelationships>',
    );
    const library = `x_/scale${i}.js`;
    for (let form = 0; form < (rest.formsPerTable ?? 8); form++) {
      const groups = [];
      for (let first = 0; first < fields.length; first += 64) {
        const rows = fields
          .slice(first, first + 64)
          .map(
            (name) =>
              `<row><cell><control id="${name}" uniqueid="${name}-control" datafieldname="${name}"/></cell></row>`,
          )
          .join('');
        groups.push(
          `<tab name="tab${first}"><labels><label description="Fields ${first}" languagecode="1033"/></labels><columns><column><sections><section name="section${first}"><rows>${rows}</rows></section></sections></column></columns></tab>`,
        );
      }
      const customization = `<formLibraries><Library name="${library}"/></formLibraries><events><event name="onload"><Handlers><Handler libraryName="${library}" functionName="ScaleClient.load" enabled="true" passExecutionContext="true"/></Handlers></event><event name="onchange" attribute="x_value0"><Handlers><Handler libraryName="${library}" functionName="ScaleClient.change" enabled="true" passExecutionContext="true"/></Handlers></event></events>`;
      const pcf = wide
        ? '<controlDescriptions><controlDescription forControl="x_value2-control"><customControl name="publisher.ScaleInput" formFactor="0"><parameters><value type="SingleLine.Text">x_value2</value></parameters></customControl></controlDescription></controlDescriptions>'
        : '';
      await write(
        root,
        `Entities/${entity}/FormXml/main/${form ? `form-${String(form).padStart(3, '0')}.xml` : 'form.xml'}`,
        `<systemform><formid>{${performanceId(1000000 + i * (rest.formsPerTable ?? 8) + form)}}</formid><type>2</type><LocalizedNames><LocalizedName description="Invented form ${i}/${form}" languagecode="1033"/></LocalizedNames><form><tabs>${groups.join('')}</tabs>${customization}${pcf}</form></systemform>`,
      );
    }
    for (let view = 0; view < 4; view++) {
      const selected = fields.slice(0, 8);
      const linked =
        view === 3
          ? `<link-entity name="x_scale${(i + 1) % tables}" from="x_scale${(i + 1) % tables}id" to="x_link0" link-type="outer" alias="related"><attribute name="x_value0"/></link-entity>`
          : '';
      const filter =
        view === 1
          ? '<filter><condition attribute="x_quantity" operator="ge" value="500"/></filter>'
          : view === 2
            ? '<filter><condition attribute="x_choice0" operator="eq" value="2"/></filter>'
            : '';
      await write(
        root,
        `Entities/${entity}/SavedQueries/view-${view}.xml`,
        `<savedquery><savedqueryid>{${performanceId(2000000 + i * 4 + view)}}</savedqueryid><querytype>0</querytype><isdefault>${view === 0 ? 1 : 0}</isdefault><LocalizedNames><LocalizedName description="Scale view ${i}/${view}" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="${entity}">${selected.map((name) => `<attribute name="${name}"/>`).join('')}${filter}${linked}<order attribute="x_value0"/></entity></fetch></fetchxml><layoutxml><grid><row>${selected.map((name) => `<cell name="${name}" width="150"/>`).join('')}</row></grid></layoutxml></savedquery>`,
      );
    }
    await write(
      root,
      `WebResources/scale${i}.js`,
      'var ScaleClient={load:function(e){window.scaleLoads=(window.scaleLoads||0)+1;e.getFormContext().ui.setFormNotification("Scale customization ready","INFO","scale");},change:function(e){window.scaleChanges=(window.scaleChanges||0)+1;}};',
    );
    await write(
      root,
      `WebResources/scale${i}.js.data.xml`,
      `<WebResource><Name>${library}</Name><WebResourceType>3</WebResourceType><FileName>WebResources/scale${i}.js</FileName></WebResource>`,
    );
    if (!existingRoot && ((i + 1) % 64 === 0 || i + 1 === tables))
      rest.onProgress?.({ phase: 'fixture-source', tablesWritten: i + 1, tables });
  }
  const controlRoot = fixture.solutionRoots[0];
  await write(
    controlRoot,
    'Controls/publisher.ScaleInput/ControlManifest.xml',
    '<manifest><control namespace="Scale" constructor="Input" version="1.0.0" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound" required="true"/><resources><code path="bundle.js" order="1"/><css path="style.css" order="1"/></resources></control></manifest>',
  );
  await write(
    controlRoot,
    'Controls/publisher.ScaleInput/ControlManifest.xml.data.xml',
    '<CustomControl><Name>publisher.ScaleInput</Name></CustomControl>',
  );
  await write(
    controlRoot,
    'Controls/publisher.ScaleInput/bundle.js',
    'var Scale=Scale||{};Scale.Input=class{init(c,n,s,container){this.context=c;this.notify=n;this.input=document.createElement("input");this.input.setAttribute("aria-label","Scale custom input");this.input.addEventListener("input",()=>this.notify());container.append(this.input);window.scaleControlMounts=(window.scaleControlMounts||0)+1;}updateView(c){this.input.value=c.parameters.value.raw||"";}getOutputs(){return{value:this.input.value};}destroy(){this.input.remove();window.scaleControlDestroys=(window.scaleControlDestroys||0)+1;}};',
  );
  await write(
    controlRoot,
    'Controls/publisher.ScaleInput/style.css',
    'input[aria-label="Scale custom input"]{border:2px solid #258;padding:6px}',
  );
  let generated = 0;
  const pack = {
    id: 'invented-complex-performance',
    name: 'Invented complex scale fixture',
    description: 'Wide relational source and sparse, varied rows.',
    matches: () => true,
    presets: () => ({
      'invented-scale': {
        name: 'Invented complex scale dataset',
        createOwned: ({ records: recordInput } = {}) => {
          generated++;
          const mappings = {},
            data = {},
            paged = recordStorage === 'paged' && recordInput,
            ids = paged ? null : Array.from({ length: tables }, () => []);
          // Lookups use their target record's actual GUID. Reuse immutable
          // strings rather than allocating a new equal GUID for every edge.
          const rowId = (table, row) =>
            ids
              ? (ids[table][row] ??= performanceId(10000 + table * stride + row))
              : performanceId(10000 + table * stride + row);
          const started = performance.now();
          let recordsCreated = 0;
          for (let i = 0; i < tables; i++) {
            const entity = `x_scale${i}`;
            mappings[entity] = { idColumn: entity + 'id', nameColumn: 'x_value0', entitySet: entity + 's' };
            const makeRow = (row) => ({
              [entity + 'id']: rowId(i, row),
              x_value0: ['Invented ', i, '/', row].join(''),
              x_value1: 'Secured invented value',
              x_value2:
                row % 100 === 0 ? `Unicode Δ 日本語 ${row} ` + 'nested payload '.repeat(64) : 'Invented short value',
              x_quantity: row % 1000,
              x_enabled: row % 2 === 0,
              x_choice0: (row % 3) + 1,
              ...(row % 4 === 0 ? { x_link0: rowId((i + 1) % tables, row % countFor((i + 1) % tables)) } : {}),
              ...(i < complexTables && row % 100 === 0
                ? Object.fromEntries([
                    ...Array.from({ length: 200 }, (_, link) => {
                      const target = (i + link + 1) % tables;
                      return ['x_link' + link, rowId(target, row % countFor(target))];
                    }),
                    ...Array.from({ length: 46 }, (_, field) => [
                      'x_extra' + field,
                      ['Invented ', i, '/', row, '/', field].join(''),
                    ]),
                  ])
                : {}),
              ...(row % 100 === 0
                ? {
                    x_memo: 'Invented multiline\ntext',
                    x_when: '2026-01-02T00:00:00Z',
                    x_rich: '<p><strong>Invented</strong> rich text</p>',
                    x_json: JSON.stringify({ version: 1, tags: ['a', 'b'], nested: { value: row } }),
                  }
                : {}),
            });
            function* rows() {
              for (let row = 0; row < countFor(i); row++) yield makeRow(row);
              recordsCreated += countFor(i);
              if ((i + 1) % 64 === 0 || i + 1 === tables)
                rest.onProgress?.({
                  phase: 'fixture-records',
                  tablesCreated: i + 1,
                  recordsCreated,
                  elapsedMs: Math.round(performance.now() - started),
                  memory: process.memoryUsage(),
                });
            }
            data[entity] = paged ? recordInput.table(rows(), { primaryKey: entity + 'id' }) : Array.from(rows());
          }
          return { name: 'Invented complex scale dataset', mappings, tables: data };
        },
      },
    }),
  };
  const { columns: _baseColumns, ...sourceInventory } = fixture.inventory;
  const inventory = {
    ...sourceInventory,
    complexTables,
    fieldsPerComplexTable: 257,
    fieldsPerSimpleTable: 33,
    relationshipsPerComplexTable: 200,
    relationships: complexTables * 200 + simpleTables,
    views: tables * 4,
    customizedForms: tables * (rest.formsPerTable ?? 8),
    complexRecords,
    denseRowsPerComplexTable: Math.ceil(countFor(0) / 100),
    simpleRecords: records - complexRecords,
  };
  return { ...fixture, pack, inventory, generated: () => generated };
}
