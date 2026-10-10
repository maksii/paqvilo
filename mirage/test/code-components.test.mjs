import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importCodeComponents, renderCodeComponent } from '../lib/code-components.mjs';
import { observedConfig } from '../lib/project-config.mjs';

const id='d0000000-0000-4000-8000-000000000001';
async function fixture(t, resources='<code path="bundle.js" order="1"/>') {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-pcf-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const control=path.join(dir,'Controls','tst_Synthetic.Editor');await fs.mkdir(control,{recursive:true});
  await fs.writeFile(path.join(control,'ControlManifest.xml'),`<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources>${resources}</resources></control></manifest>`);
  await fs.writeFile(path.join(control,'ControlManifest.xml.data.xml'),'<CustomControl><Name>tst_Synthetic.Editor</Name></CustomControl>');
  await fs.writeFile(path.join(control,'bundle.js'),'window.ComponentFramework.registerControl("Synthetic.Editor",class{});');
  return {dir,control};
}
test('PCF manifests expose only declared resources and use evidenced GUID mappings', async t=>{
  const {dir}=await fixture(t);const catalog=await importCodeComponents([{dir}]);
  assert.equal(catalog.controls.size,1);assert.equal(catalog.assets.size,1);
  const observed=observedConfig({codeComponents:{[id]:'tst_Synthetic.Editor'},evidence:'invented fixture tag binding'});
  const html=renderCodeComponent({name:id,args:{name:id,value:'</script>'},portal:{observed},catalog,identity:{roles:['Reader']}});
  assert.match(html,/data-pcf-schema="tst_Synthetic.Editor"/);assert.match(html,/__paqviloPcf.mount/);assert.ok(!html.includes('"</script>"'));
  assert.match(renderCodeComponent({name:id,portal:{},catalog}),/requires an observed/);
  assert.throws(()=>observedConfig({codeComponents:{[id]:'tst_Synthetic.Editor'}}),/evidence/);
  assert.throws(()=>observedConfig({codeComponents:{[id]:'../escape'},evidence:'fixture'}),/schema names/);
});
test('PCF manifest traversal is rejected and missing resources never become mountable',async t=>{
  const {dir}=await fixture(t,'<code path="../../outside.js"/>');await fs.writeFile(path.join(dir,'outside.js'),'bad');
  const catalog=await importCodeComponents([{dir}]);assert.equal(catalog.controls.size,0);assert.equal(catalog.assets.size,0);assert.equal(catalog.diagnostics[0].code,'PCF_IMPORT_FAILED');
});
test('PCF rejects invalid declared paths and reports platform and dataset dependencies explicitly', async t => {
  const { dir, control } = await fixture(t, '<code path="bundle.js"/><platform-library name="React" version="16.14.0"/>');
  let catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual(catalog.controls.get('tst_Synthetic.Editor').libraries, [{ name: 'React', version: '16.14.0' }]);
  const portal = { observed: { codeComponents: { [id]: 'tst_Synthetic.Editor' } } };
  assert.match(renderCodeComponent({ name: id, portal, catalog }), /requires platform libraries \(React 16\.14\.0\)/);
  await fs.writeFile(path.join(control, 'ControlManifest.xml'), '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><data-set name="rows"/><resources><code path="bundle.js"/></resources></control></manifest>');
  catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual(catalog.controls.get('tst_Synthetic.Editor').datasets, [{ name: 'rows' }]);
  assert.match(renderCodeComponent({ name: id, portal, catalog }), /requires a dataset binding to an exported table and view/);
  await fs.writeFile(path.join(control, 'ControlManifest.xml'), '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><resources><code path="bundle.js#ignored"/></resources></control></manifest>');
  catalog = await importCodeComponents([{ dir }]);
  assert.equal(catalog.controls.size, 0);
  assert.match(catalog.diagnostics[0].message, /invalid path/);
});
test('PCF type groups preserve their exported types instead of treating numeric values as text', async t => {
  const { dir, control } = await fixture(t);
  await fs.writeFile(path.join(control, 'ControlManifest.xml'), '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><type-group name="Numeric"><type>Whole.None</type></type-group><property name="count" of-type-group="Numeric" usage="bound" default-value="7"/><resources><code path="bundle.js"/></resources></control></manifest>');
  const catalog = await importCodeComponents([{ dir }]);
  assert.deepEqual(catalog.controls.get('tst_Synthetic.Editor').properties[0].types, ['Whole.None']);
  assert.equal(catalog.controls.get('tst_Synthetic.Editor').properties[0]['default-value'], '7');
});
test('PCF datasets bind only to selected exported views and exact table mappings', async t => {
  const { dir, control } = await fixture(t);
  await fs.writeFile(path.join(control, 'ControlManifest.xml'), '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><data-set name="rows"/><resources><code path="bundle.js"/></resources></control></manifest>');
  const catalog = await importCodeComponents([{ dir }]);
  const portal = { observed: { codeComponents: { [id]: 'tst_Synthetic.Editor' } } };
  const metadata = { entities: { tst_row: { primaryNameAttribute: 'tst_title', fields: { tst_title: { label: 'Title', dataverseType: 'nvarchar' } } } }, views: [{ id: 'd0000000-0000-4000-8000-000000000002', name: 'Visible Rows', entity: 'tst_row', fields: [{ name: 'tst_title', width: 200 }], fetchXml: '<fetch><entity name="tst_row"><attribute name="tst_title"/></entity></fetch>' }] };
  const mappings = { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid' } };
  const html = renderCodeComponent({ name: id, args: { rows: metadata.views[0].id }, portal, catalog, metadata, mappings });
  assert.match(html, /__paqviloPcf.mount/);
  assert.match(html, /"viewId":"d0000000-0000-4000-8000-000000000002"/);
  assert.match(html, /"displayName":"Title"/);
  assert.match(renderCodeComponent({ name: id, args: { rows: 'missing' }, portal, catalog, metadata, mappings }), /no exported table definition/);
  assert.match(renderCodeComponent({ name: id, args: { rows: 'Visible Rows' }, portal, catalog, metadata: { ...metadata, views: [...metadata.views, { ...metadata.views[0], id: 'other' }] }, mappings }), /multiple exported views/);
});
test('PCF native form mounts require declared bound properties and retain selected language metadata', async t => {
  const { dir, control } = await fixture(t);
  await fs.writeFile(path.join(control, 'ControlManifest.xml'), '<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><property name="caption" of-type="SingleLine.Text" usage="input"/><resources><code path="bundle.js"/></resources></control></manifest>');
  const catalog = await importCodeComponents([{ dir }]);
  const context = { name: 'tst_Synthetic.Editor', portal: {}, catalog, language: { code: 'fr-FR', lcid: 1036 } };
  const html = renderCodeComponent({ ...context, nativeBinding: { id: 'fullname', control: 'text', properties: ['value'] } });
  assert.match(html, /__paqviloPcf.mount/); assert.match(html, /"lcid":1036/); assert.match(html, /"nativeBinding"/);
  for (const properties of [[], ['unknown'], ['caption'], ['value', 'caption']]) assert.match(renderCodeComponent({ ...context, nativeBinding: { id: 'fullname', control: 'text', properties } }), /no valid single-field native binding/);
});
