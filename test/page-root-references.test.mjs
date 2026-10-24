import {test} from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {PortalModel} from '../lense/portal-model.mjs';
import {createFixture,HOME_ID} from './fixture.mjs';
const ROOT='11111111-1111-4111-8111-111111111111', LANG='22222222-2222-4222-8222-222222222222';
for(const short of [false,true])for(const nested of [false,true]){
  test(`explicit language-root identity establishes a displaced root (${short?'short-key':'classic'} export, ${nested?'language subfolder':'shared folder'})`,async t=>{
    const fx=createFixture();t.after(()=>fx.cleanup());
    const k=n=>short?n:'adx_'+n,id=n=>short?'id':'adx_'+n+'id';
    if(short)fx.write('website.yml','id: site\nname: Site\n');
    const folder='web-pages/displaced/content-pages/'+(nested?'en-US/':'');
    fx.write(folder+'Displaced.webpage.yml',YAML.stringify({[id('webpage')]:ROOT,[k('name')]:'Displaced',[k('partialurl')]:'displaced',[k('parentpageid')]:HOME_ID,[k('isroot')]:false}));
    fx.write(folder+'Displaced.webpage.copy.html','<p>Root body</p>');
    fx.write(folder+'Displaced.en-US.webpage.yml',YAML.stringify({[id('webpage')]:LANG,[k('rootwebpageid')]:ROOT,[k('webpagelanguageid')]:'language-en'}));
    fx.write(folder+'Displaced.en-US.webpage.copy.html','<p>Language body</p>');
    for(const model of [new PortalModel(fx.dir),await PortalModel.create(fx.dir)]){
      assert.equal(model.pagePath(ROOT),'/displaced');assert.equal(model.pagePath(LANG),'/displaced');
      const bodies=model.inlineSources.filter(s=>s.rel.startsWith(folder)&&s.kind==='page-copy');
      assert.equal(bodies.length,2);assert.ok(bodies.every(s=>s.pageUrl==='/displaced'));
    }
  });
}
for(const kind of ['orphan','self','inactive-language','language-root'])test(`folder placement without active independent root evidence remains refused: ${kind}`,async t=>{
  const fx=createFixture();t.after(()=>fx.cleanup());const dir='web-pages/orphan/content-pages/';
  const root={adx_webpageid:ROOT,adx_partialurl:'orphan',adx_parentpageid:HOME_ID};
  if(kind==='self')root.adx_rootwebpageid=ROOT;
  if(kind==='language-root')root.adx_webpagelanguageid='language-en';
  fx.write(dir+'Orphan.webpage.yml',YAML.stringify(root));fx.write(dir+'Orphan.webpage.copy.html','<p>Orphan</p>');
  if(kind!=='orphan')fx.write(dir+'Orphan.en-US.webpage.yml',YAML.stringify({adx_webpageid:LANG,adx_rootwebpageid:ROOT,adx_webpagelanguageid:'language-en',...(kind==='inactive-language'?{statecode:1}:{})}));
  for(const model of [new PortalModel(fx.dir),await PortalModel.create(fx.dir)])assert.equal(model.pagePath(ROOT),null);
});
