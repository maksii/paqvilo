import fs from 'node:fs/promises';
import path from 'node:path';
import { profileFixture } from './deployment-profiles.mjs';
import { createSimulator } from '../../server.mjs';

export async function powerPagesControlsFixture(t) {
  const fixture = await profileFixture(t);
  const fields = [
    ['title', 'nvarchar', 160], ['code', 'nvarchar', 20], ['email', 'nvarchar', 100, 'email'],
    ['phone', 'nvarchar', 50], ['url', 'nvarchar', 200, 'url'], ['symbol', 'nvarchar', 10, 'tickersymbol'],
    ['memo', 'ntext', 2000], ['integer', 'int'], ['money', 'money'], ['decimal', 'decimal'],
    ['float', 'float'], ['choice', 'picklist'], ['currency', 'lookup'], ['date', 'datetime', null, 'date'],
    ['time', 'datetime', null, 'datetime'], ['parent', 'lookup'], ['person', 'lookup'],
    ['street', 'nvarchar', 250], ['city', 'nvarchar', 80], ['postal', 'nvarchar', 20],
    ['created', 'datetime', null, 'datetime'], ['modified', 'datetime', null, 'datetime'],
    ['address', 'ntext'], ['county', 'nvarchar', 50], ['othercity', 'nvarchar', 80],
  ];
  const column = role => role === 'address' ? 'home_composite' : 'x_' + role;
  const all = [...fields, ['boolean', 'bit']];
  const metadata = '<Entity><Name>x_sample</Name><EntityInfo><entity><attributes>' +
    '<attribute><LogicalName>x_sampleid</LogicalName><Type>primarykey</Type></attribute>' +
    all.map(([role, type, length, format]) => `<attribute PhysicalName="${column(role)}"><LogicalName>${column(role)}</LogicalName><Name>${column(role)}</Name><Type>${type}</Type><RequiredLevel>none</RequiredLevel>${role === 'address' ? '<ValidForCreateApi>0</ValidForCreateApi><ValidForUpdateApi>0</ValidForUpdateApi>' : ''}${length ? `<MaxLength>${length}</MaxLength>` : ''}${format ? `<Format>${format}</Format>` : ''}${role === 'boolean' ? '<optionset><options><option value="0"><labels><label description="No" languagecode="1033"/></labels></option><option value="1"><labels><label description="Yes" languagecode="1033"/></labels></option></options></optionset>' : role === 'choice' ? '<optionset><options><option value="1"><labels><label description="One" languagecode="1033"/></labels></option></options></optionset>' : ''}</attribute>`).join('') +
    '</attributes></entity></EntityInfo></Entity>';
  const form = '<forms><systemform><formid>{invented-controls}</formid><form><tabs><tab name="main"><labels><label description="Main" languagecode="1033"/></labels><columns><column width="100%"><sections><section name="controls"><rows>' +
    all.map(([role]) => `<row><cell><labels><label description="Invented ${role}" languagecode="1033"/></labels><control id="${column(role)}" datafieldname="${column(role)}"${['created', 'modified', 'othercity'].includes(role) ? ' disabled="true"' : ''}${role === 'boolean' ? ' classid="{67FAC785-CD58-4f9f-ABB3-4B7DDC6ED5ED}"' : ''}/></cell></row>`).join('') +
    '</rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Invented controls" languagecode="1033"/></LocalizedNames></systemform></forms>';
  const files = {
    'web-templates/Main.webtemplate.source.html': '<html><body>{% entityform name: "Invented create" %}</body></html>',
    'Invented.basicform.yml': 'adx_entityformid: invented-create\nadx_name: Invented create\nadx_entityname: x_sample\nadx_formname: Invented controls\nadx_mode: 100000000\nadx_entitypermissionsenabled: false',
    'Invented.basicform.custom_javascript.js': `document.addEventListener('DOMContentLoaded', () => {
      const input = document.getElementById('x_memo'), output = document.createElement('small');
      output.id = 'invented-character-count'; input.after(output);
      input.setAttribute('aria-describedby', output.id);
      const update = () => { output.textContent = input.value.length + ' symbols'; };
      input.addEventListener('input', update); update();
    });`,
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(fixture.sourceDir, name), content);
  const entity = path.join(fixture.solutionRoots[0], 'Entities/x_sample');
  await fs.mkdir(path.join(entity, 'FormXml/main'), { recursive: true });
  await fs.writeFile(path.join(entity, 'Entity.xml'), metadata);
  await fs.writeFile(path.join(entity, 'FormXml/main/controls.xml'), form);
  const simulator = await createSimulator({ sourceDir: fixture.sourceDir, solutionRoots: fixture.solutionRoots, watch: false, port: 0,
    initial: { version: 1, mappings: { x_sample: { entitySet: 'x_samples', idColumn: 'x_sampleid', nameColumn: 'x_title', inferred: false } }, tables: { x_sample: [] }, permissions: [], settings: { permissionMode: 'permissive' } },
  });
  fixture.onCleanup(() => simulator.close());
  return { simulator, input: {
    formName: 'Invented controls', fields: fields.map(([role], index) => ({ name: column(role), role: 'field' + (index + 1),
      ...(role === 'memo' ? { feedbackId: 'invented-character-count' } : {}),
      ...(['title', 'code', 'phone', 'memo', 'street', 'city', 'postal'].includes(role) ? { edit: "Proof O'Brien & Ω" } : {}),
    })), groups: [{ name: 'x_boolean', role: 'boolean' }],
  } };
}
