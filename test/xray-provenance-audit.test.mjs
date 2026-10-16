import test from 'node:test';
import assert from 'node:assert/strict';
import { elementSourceHints, scriptSourceHints } from '../lense/element-provenance.mjs';

const source={sourceFile:'/invented/Partial.html',name:'Partial'};
test('P01 wide valid markup under 1 MB cannot overflow function arguments',()=>{assert.doesNotThrow(()=>elementSourceHints('<br>'.repeat(200_000),source));});
test('P02 Liquid comments and manifests cannot supply rendered markup evidence',()=>{
  const rows=elementSourceHints('{% comment %}\n<div id="ghost"></div>\n{% endcomment %}\n<div id="actual"></div>{% manifest %}<b id="manifest"></b>{% endmanifest %}',source);
  assert.deepEqual(rows.map(row=>[row.selector,row.line]),[['#actual',4]]);
});
test('P03 raw preserves emitted HTML and treats Liquid comment tokens literally',()=>{assert.deepEqual(elementSourceHints('{% raw %}{% comment %}<div id="actual"></div>{% endcomment %}{% endraw %}',source).map(row=>row.selector),['#actual']);});
test('P04 trimming comments, CRLF and unterminated comments preserve lines and exclude unreachable markup',()=>{const rows=elementSourceHints('{%- comment -%}\r\n<b id="ghost"></b>\r\n{%- endcomment -%}\r\n<b id="actual"></b>{% comment %}<b id="never"></b>',source);assert.deepEqual(rows.map(row=>[row.selector,row.line]),[['#actual',4]]);});
test('P05 mixed dynamic class tokens never become invented static classes',()=>{const rows=elementSourceHints('<div class="tone-{{ shade }} a{{ x }}b stable"></div>',source);assert.deepEqual(rows.map(row=>row.selector),['div.stable']);});
test('P06 Liquid inside an identifying attribute cannot manufacture multiple classes',()=>{const rows=elementSourceHints('<div class="a{% comment %}ignored{% endcomment %}b stable"></div>',source);assert.equal(rows.some(row=>/\.a(?:\.|$)|\.b(?:\.|$)/.test(row.selector)),false);});
test('P07 actual quoted metadata attribute references are retained',()=>{assert.equal(scriptSourceHints(`document.querySelector('[data-fieldname="audit_first"]');`,{sourceFile:'/feature.js'})[0]?.selector,'[data-fieldname="audit_first"]');});
test('P08 script comments and documentation strings cannot manufacture selector evidence',()=>{const body=`// document.getElementById("ghost");\nconst documentation = 'document.querySelector("#fiction")';\n/* document.querySelector("#comment") */\ndocument.getElementById("actual");`;assert.deepEqual(scriptSourceHints(body,{sourceFile:'/feature.js'}).map(row=>[row.selector,row.line]),[['#actual',4]]);});
test('P09 escaped static JavaScript strings identify the actual runtime identifier',()=>{const body=String.raw`document.getElementById("audit\u005ffirst"); document.querySelector("#audit\\:first");`;assert.deepEqual(scriptSourceHints(body,{}).map(row=>row.selector),['#audit_first','#audit\\:first']);});
test('P10 rejected dynamic references do not exhaust the accepted reference budget',()=>{assert.deepEqual(scriptSourceHints('document.querySelector("#{{ dynamic }}"); document.querySelector("#actual");',{}, {limit:1}).map(row=>row.selector),['#actual']);});
test('P11 arbitrary attribute values and URL query values never enter provenance hints',()=>{assert.deepEqual(scriptSourceHints('document.querySelector("[data-private=SECRET_SENTINEL]"); document.querySelector("a[href*=TOKEN_SENTINEL]");',{}),[]);});
test('P12 concatenated strings and optional dynamic arguments are not static references',()=>{assert.deepEqual(scriptSourceHints('document.querySelector("#prefix" + suffix); document.querySelector("#x", extra);',{}),[]);});
test('P13 regex and nested template text cannot manufacture script references',()=>{const text='const pattern = /document.querySelector("#ghost")/; const text = `outer ${`inner`} document.querySelector("#fiction")`;';assert.deepEqual(scriptSourceHints(text,{}),[]);});
test('P14 repeated literal references deduplicate before applying the budget',()=>{assert.deepEqual(scriptSourceHints('document.querySelector("#one"); document.querySelector("#one"); document.querySelector("#two");',{}, {limit:2}).map(row=>row.selector),['#one','#two']);});

test('P15 Liquid in tag structure cannot manufacture a different static element selector',()=>{for(const text of ['<di{% comment %}ignored{% endcomment %}v class="stable"></div>','<di{% raw %}v{% endraw %} class="stable"></div>','<di{{ suffix }} class="stable"></div>'])assert.deepEqual(elementSourceHints(text,source),[]);});
test('P16 classic script HTML comment forms cannot supply selector evidence',()=>{for(const prefix of ['<!--','-->'])assert.deepEqual(scriptSourceHints(prefix+' document.querySelector("#ghost");\ndocument.querySelector("#actual");',{sourceFile:'/feature.js'}).map(row=>[row.selector,row.line]),[['#actual',2]]);});
