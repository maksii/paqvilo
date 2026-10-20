// Invented local exports only. Shared by the bounded performance probe and tests.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export const performanceId = n => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
export async function performanceFixture({ tables = 16, columns = 24, records = 1000, formsPerTable = 1 } = {}) {
  for (const [name, value] of Object.entries({ tables, columns, formsPerTable })) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  if (!Number.isSafeInteger(records) || records < tables) throw new TypeError('records must be a safe integer with at least one record per table');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-performance-'));
  const solutionRoots = [path.join(root, 'solution')], sourceDir = path.join(root, 'portal');
  const inventory = { tables, columns, formsPerTable, forms: tables * formsPerTable, records, files: 0, xmlFiles: 0, sourceBytes: 0 };
  const write = async (file, content) => {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
    inventory.files++; inventory.sourceBytes += Buffer.byteLength(content); if (file.endsWith('.xml')) inventory.xmlFiles++;
  };
  await write(path.join(sourceDir, 'website.yml'), `adx_websiteid: ${performanceId(1)}\nadx_name: Invented performance portal`);
  await write(path.join(sourceDir, 'web-pages/Home.webpage.yml'), `adx_webpageid: ${performanceId(2)}\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true`);
  await write(path.join(solutionRoots[0], 'Other/Solution.xml'), '<ImportExportXml><SolutionManifest><UniqueName>InventedPerformance</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>');
  const component = [], mappings = {}, data = {};
  for (let i = 0; i < tables; i++) {
    const entity = `x_scale${i}`, fields = Array.from({ length: columns }, (_, index) => `x_value${index}`);
    const attribute = (name, type, secured = false) => `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type>${secured ? '<IsSecured>1</IsSecured>' : ''}</attribute>`;
    await write(path.join(solutionRoots[0], `Entities/${entity}/Entity.xml`), `<Entity><Name>${entity}</Name><EntityInfo><entity Name="${entity}"><EntitySetName>${entity}s</EntitySetName><PrimaryIdAttribute>${entity}id</PrimaryIdAttribute><PrimaryNameAttribute>x_value0</PrimaryNameAttribute><attributes>${attribute(`${entity}id`, 'primarykey')}${fields.map((name, index) => attribute(name, 'nvarchar', index === 1)).join('')}</attributes></entity></EntityInfo></Entity>`);
    for (let form = 0; form < formsPerTable; form++) {
      const filename = form === 0 ? 'form.xml' : `form-${String(form).padStart(3, '0')}.xml`;
      await write(path.join(solutionRoots[0], `Entities/${entity}/FormXml/main/${filename}`), `<systemform><formid>{${performanceId(1000000 + i * formsPerTable + form)}}</formid><type>2</type><LocalizedNames><LocalizedName description="Invented form ${i}/${form}" languagecode="1033"/></LocalizedNames><form><tabs><tab name="general"><columns><column><sections><section><rows>${fields.map(name => `<row><cell><control datafieldname="${name}"/></cell></row>`).join('')}</rows></section></sections></column></columns></tab></tabs></form></systemform>`);
    }
    component.push(`<AppModuleComponent type="1" schemaName="${entity}"/>`);
    mappings[entity] = { idColumn: `${entity}id`, entitySet: `${entity}s`, nameColumn: 'x_value0' };
    const tableRecords = Math.floor(records / tables) + (i < records % tables ? 1 : 0);
    data[entity] = Array.from({ length: tableRecords }, (_, index) => ({ [`${entity}id`]: performanceId(10000 + i * 10000 + index), x_value0: `Invented ${i}/${index}`, x_value1: 'Secured invented value', x_value2: 'payload'.repeat(24) }));
  }
  await write(path.join(solutionRoots[0], 'AppModules/x_scale/AppModule.xml'), `<AppModule><UniqueName>x_scale</UniqueName><AppModuleId>{${performanceId(3)}}</AppModuleId><AppModuleComponents>${component.join('')}</AppModuleComponents></AppModule>`);
  let generated = 0;
  const pack = { id: 'invented-performance', name: 'Invented performance fixture', description: 'Bounded synthetic loading regression.', matches: () => true, presets: () => ({ 'invented-scale': { name: 'Invented performance dataset', load: () => { generated++; return { name: 'Invented performance dataset', mappings, tables: structuredClone(data) }; } } }) };
  return { root, sourceDir, solutionRoots, pack, inventory, generated: () => generated,
    cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
