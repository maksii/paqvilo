import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { renderComponent as candidate } from '../lib/platform.mjs';

const getAttributes = node => Object.fromEntries((node.attrs??[]).map(attribute=>[attribute.name,attribute.value]));
function controls(html) {
  const output=[];
  function walk(node,ancestors=[]){const attributes=getAttributes(node);if(node.tagName==='input'||node.tagName==='select'||node.tagName==='option'||node.tagName==='textarea')output.push({tag:node.tagName,attributes,hiddenAncestors:ancestors.filter(item=>item.hidden!==undefined||/display\s*:\s*none/i.test(item.style??'')).length});for(const child of node.childNodes??[])walk(child,[...ancestors,attributes]);}
  walk(parseFragment(html));return output;
}
async function render(renderer,{mode=100000001,stored=null,style=100000000,field={},metadata={}}={}) {
  const row={sample_widgetid:'row',sample_choice:stored};
  const baseline=structuredClone(row);
  const options={portal:{forms:[{id:'form',name:'Invented choice form',mode}],records:[{kind:'basicformmetadata',adx_entityform:'form',adx_type:100000000,adx_attributelogicalname:'sample_choice',adx_controlstyle:style,...metadata}],pages:[],website:{}},store:{resolveMapping:()=>({entitySet:'sample_widgets',idColumn:'sample_widgetid'}),get:async()=>row},schemas:{form:{entity:'sample_widget',fields:[{name:'sample_choice',type:'picklist',dataverseType:'picklist',defaultValue:2,options:[{value:0,label:'Zero'},{value:1,label:'First'},{value:2,label:'Second'}],...field}]}}};
  const html=await renderer('entityform','form',{request:{params:{id:'row'}}},options);
  assert.deepEqual(row,baseline,'rendering never stamps the stored NULL/default');
  return{html,controls:controls(html)};
}
const radios=result=>result.controls.filter(control=>control.tag==='input'&&control.attributes.type==='radio');
const selected=result=>radios(result).filter(control=>Object.hasOwn(control.attributes,'checked')).map(control=>control.attributes.value);

for(const mode of [100000001,100000002]){
 for(const style of [100000000,100000001]){
  test(`NULL radio choice renders exported default in mode${mode}/style${style} without changing data`,async()=>{
   const result=await render(candidate,{mode,style});assert.deepEqual(selected(result),['2']);
   assert.equal(radios(result).length,3);
   assert.equal(radios(result).filter(control=>Object.hasOwn(control.attributes,'disabled')).length,mode===100000002?3:0);
  });
 }
}
test('explicit zero and another stored option retain precedence over an exported default',async()=>{
 for(const stored of [0,1,2])assert.deepEqual(selected(await render(candidate,{stored})),[String(stored)]);
});
test('an explicit schema default overrides column default while zero remains a valid default',async()=>{
 assert.deepEqual(selected(await render(candidate,{field:{default:0}})),['0']);
 assert.deepEqual(selected(await render(candidate,{field:{default:1}})),['1']);
});
test('ignore-default metadata and absence of a default preserve the empty radio selection',async()=>{
 assert.deepEqual(selected(await render(candidate,{metadata:{adx_ignoredefaultvalue:true}})),[]);
 assert.deepEqual(selected(await render(candidate,{field:{defaultValue:undefined}})),[]);
});
test('required, disabled and hidden radio controls preserve their authored states',async()=>{
 const required=await render(candidate,{field:{required:true}});
 assert.match(required.html,/<span[^>]*id="sample_choice"[^>]*data-required="true"/);
 assert.deepEqual(selected(required),['2']);
 const disabled=await render(candidate,{field:{readOnly:true}});
 assert.equal(radios(disabled).every(control=>Object.hasOwn(control.attributes,'disabled')),true);
 assert.deepEqual(selected(disabled),['2']);
 const hidden=await render(candidate,{field:{hidden:true}});
 assert.equal(radios(hidden).every(control=>control.hiddenAncestors>0),true);
 assert.deepEqual(selected(hidden),['2']);
});
test('existing NULL dropdown and matrix choices do not acquire an unqualified default',async()=>{
 const dropdown=await render(candidate,{style:NaN});
 const selectedOptions=dropdown.controls.filter(control=>control.tag==='option'&&Object.hasOwn(control.attributes,'selected'));
 assert.equal(selectedOptions.length,1);assert.equal(selectedOptions[0].attributes.value,'');
 const matrix=await render(candidate,{style:100000006});
 assert.equal(radios(matrix).length,3);assert.deepEqual(selected(matrix),[]);
});
test('NULL text, integer, date and Boolean controls retain their own empty/default semantics',async()=>{
 for(const field of [{type:'text',dataverseType:'nvarchar',defaultValue:'invented'},{type:'number',dataverseType:'int',defaultValue:7},{type:'date',dataverseType:'datetime',defaultValue:'2026-01-01'}]){
  const result=await render(candidate,{field:{...field,options:[]}});
  const fieldControls=result.controls.filter(control=>control.attributes.id==='sample_choice'||control.attributes.id?.startsWith('sample_choice_'));
  assert.ok(fieldControls.length,field.dataverseType);
  assert.equal(fieldControls.every(control=>(control.attributes.value??'')===''),true,field.dataverseType);
 }
 const checkbox=await render(candidate,{field:{type:'boolean',dataverseType:'bit',defaultValue:true,options:[]}});
 assert.equal(checkbox.controls.some(control=>control.attributes.id==='sample_choice'&&Object.hasOwn(control.attributes,'checked')),false);
});
test('insert defaults and authored prepopulation still retain their existing precedence',async()=>{
 assert.deepEqual(selected(await render(candidate,{mode:100000000})),['2']);
 const metadata={adx_prepopulatetype:100000000,adx_prepopulatevalue:'1'};
 assert.deepEqual(selected(await render(candidate,{metadata})),['1']);
});

test('an exported default never overrides explicit zero even with ignore-default metadata',async()=>{
 assert.deepEqual(selected(await render(candidate,{stored:0,metadata:{adx_ignoredefaultvalue:true}})),['0']);
});
