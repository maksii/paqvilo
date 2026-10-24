import {test} from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {PortalModel,sourceText} from '../lense/portal-model.mjs';
import {editSource} from '../lense/source-edit.mjs';
import {createFixture,HOME_ID} from './fixture.mjs';
for(const short of [false,true]){
  test(`YAML-inline snippet edits retain record and sibling identity (${short?'short-key':'classic'} export)`,async t=>{
    const fx=createFixture();t.after(()=>fx.cleanup());const k=n=>short?n:'adx_'+n,id=short?'id':'adx_contentsnippetid';
    if(short)fx.write('website.yml','id: site\nname: Site\n');
    const file='content-snippets/inline/en-US/Inline.contentsnippet.yml';
    const record={[id]:'inline-snippet',[k('name')]:'Inline',[k('value')]:'<p>Old inline snippet</p>',[k('contentsnippetlanguageid')]:'language-en',[k('type')]:756150001,sibling:'retained'};
    fx.write(file,YAML.stringify(record));
    let model=await PortalModel.create(fx.dir);const source=model.inlineSources.find(s=>s.rel===file+'#'+k('value'));
    assert.ok(source);assert.equal(sourceText(source),record[k('value')]);assert.equal(source.recordId,'inline-snippet');
    editSource(source,text=>text.replace('Old','New'));
    assert.deepEqual(YAML.parse(fx.read(file)),{...record,[k('value')]:'<p>New inline snippet</p>'});
    const languageMove={...record,[k('contentsnippetlanguageid')]:'language-other'};
    fx.write(file,YAML.stringify(languageMove));
    assert.equal(sourceText(source),null);assert.throws(()=>editSource(source,text=>text+'x'),/stale language identity/);
    const foreign={...record,[id]:'foreign-snippet'};fx.write(file,YAML.stringify(foreign));
    assert.equal(sourceText(source),null);assert.throws(()=>editSource(source,text=>text+'x'),/stale record identity/);
  });
  test(`standalone step sources use declared parent-form identity (${short?'short-key':'classic'} export)`,async t=>{
    const fx=createFixture();t.after(()=>fx.cleanup());const k=n=>short?n:'adx_'+n,id=n=>short?'id':'adx_'+n+'id';
    if(short)fx.write('website.yml','id: site\nname: Site\n');
    fx.write('web-pages/home/Home.webpage.yml',YAML.stringify({[id('webpage')]:HOME_ID,[k('partialurl')]:'/',[k('webform')]:'declared-form'}));
    const stem='advanced-form-steps/step/Step.advancedformstep';
    fx.write(stem+'.yml',YAML.stringify({[id('webformstep')]:'declared-step',[k('webform')]:'declared-form',[k('title')]:'<b>Step title</b>'}));
    fx.write(stem+'.custom_javascript.js','window.inventedStep = true;');
    for(const model of [new PortalModel(fx.dir),await PortalModel.create(fx.dir)]){
      const script=model.inlineSources.find(s=>s.rel===stem+'.custom_javascript.js');assert.ok(script);assert.equal(script.kind,'advanced-form-step-js');assert.deepEqual(script.usedOn,['/']);
      const title=model.inlineSources.find(s=>s.rel===stem+'.yml#'+k('title'));assert.ok(title);assert.deepEqual(title.usedOn,['/']);
    }
  });
}
