import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createFixture} from '../../test/fixture.mjs';
import {createSimulator} from '../server.mjs';

test('persisted project policy retains its value but reports current default drift consistently',async t=>{
  const fx=createFixture();t.after(()=>fx.cleanup());const stateFile=path.join(fx.dir,'local-state.json');let app;
  t.after(()=>app?.close());
  app=await createSimulator({sourceDir:fx.dir,stateFile,watch:false,contentPolicyDefaults:{confinePortalPages:true}});
  assert.equal(app.state().config.contentPolicySource,'project defaults');await app.store.compact();await app.close();
  app=await createSimulator({sourceDir:fx.dir,stateFile,watch:false,contentPolicyDefaults:{confinePortalPages:false}});
  assert.equal(app.state().config.confinePortalPages,true);assert.equal(app.state().config.contentPolicySource,'runtime state (project default differs)');
  assert.equal((await(await fetch(app.url+'/__sim/api/status')).json()).contentPolicySource,'runtime state (project default differs)');
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).simulator.contentPolicySource,'project defaults','reporting does not rewrite persisted provenance');
  const changed=await fetch(app.url+'/_sim/api/config',{method:'PATCH',headers:{'content-type':'application/json','x-sim-csrf':app.state().csrf},body:JSON.stringify({pageMode:'local'})});
  assert.equal(changed.status,200,await changed.text());await app.store.compact();
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).simulator.contentPolicySource,'project defaults');
  await app.close();app=await createSimulator({sourceDir:fx.dir,stateFile,watch:false,contentPolicyDefaults:{confinePortalPages:true}});
  assert.equal(app.state().config.contentPolicySource,'project defaults');
  await app.close();app=await createSimulator({sourceDir:fx.dir,stateFile,watch:false,contentPolicyDefaults:{externalAssets:false}});
  assert.equal(app.state().config.contentPolicySource,'runtime state (project default differs)','removing the confined default also counts as drift when another policy default remains');
  await app.close();app=await createSimulator({sourceDir:fx.dir,stateFile,watch:false});
  assert.equal(app.state().config.contentPolicySource,'project defaults (no longer configured)');
});
