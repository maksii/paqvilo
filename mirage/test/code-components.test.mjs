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
