import test from 'node:test';
import assert from 'node:assert/strict';
import {FORMS,extras,BANNER_HTML} from '../baseline/generate.mjs';

test('item main form places each column once outside hidden sections and tabs (O17)',()=>{
 const xml=FORMS.find(form=>form.file==='item-main').build();
 // Hidden tabs and sections are not rendered, so the platform does not count them; strip them before counting.
 const visible=xml.replace(/<tab [^>]*visible="false"[\s\S]*?<\/tab>/g,'').replace(/<section [^>]*visible="false"[\s\S]*?<\/section>/g,'');
 const fields=[...visible.matchAll(/<control id="([^"]+)" classid="[^"]+" datafieldname="([^"]+)"/g)].filter(([,id])=>!id.startsWith('quickview_')).map(([,,field])=>field);
 assert.deepEqual(fields.filter((field,index)=>fields.indexOf(field)!==index),[]);
 assert.match(xml,/<Url>pqvd_baseline_banner\.html<\/Url>/);
});

test('form web resource is a static HTML document so it renders inline as well as framed (O17)',()=>{
 const spec=extras().webResource;
 assert.deepEqual([spec.name,spec.type,spec.retire],['pqvd_baseline_banner.html',1,['pqvd_baseline_icon.png','pqvd_baseline_icon.svg']]);
 assert.equal(Buffer.from(spec.content,'base64').toString('utf8'),BANNER_HTML);
 assert.match(BANNER_HTML,/^<!DOCTYPE html>[\s\S]*<h2 class="baseline-banner">/);
 assert.doesNotMatch(BANNER_HTML,/<script|on[a-z]+=/i);
});
