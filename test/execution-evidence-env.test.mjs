import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadCatalogue} from '../lense/config.mjs';

test('Execution receipt output uses a separate namespace while catalogue typos still fail',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-execution-env-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true,maxRetries:5}));
 const config=path.join(directory,'catalogue.json');
 await fs.writeFile(config,JSON.stringify({sites:{invented:{source:directory,environments:{dev:'https://invented.example.test'}}}}));
 assert.ok(loadCatalogue({config},{PAQ_TEST_CLR_EVIDENCE:path.join(directory,'receipt.json'),PAQ_TEST_XRM_SDK:path.join(directory,'Sdk.dll')}).sites.invented);
 assert.throws(()=>loadCatalogue({config},{PAQVILO_TEST_CLR_EVIDENCE:'receipt.json'}),/Unknown setting PAQVILO_TEST_CLR_EVIDENCE/);
 assert.throws(()=>loadCatalogue({config},{PAQVILO_TEST_XRM_SDK:'Sdk.dll'}),/Unknown setting PAQVILO_TEST_XRM_SDK/);
 assert.throws(()=>loadCatalogue({config},{PAQVILO_SCPOE:'all'}),/Unknown setting PAQVILO_SCPOE/);
});
