import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveDeploymentProfiles,loadDeploymentProfiles,deploymentProfilesStatus} from '../lib/deployment-profiles.mjs';
import {profileFixture} from './fixtures/deployment-profiles.mjs';
import {createSimulator} from '../server.mjs';
import {resolveMirageConfig} from '../../lense/config.mjs';
import {mirageReadiness} from '../../lense/commands/mirage.mjs';

test('unused PAC connection references are reported without dropping connected entries',async t=>{
  const fixture=await profileFixture(t),file=path.join(fixture.root,'mixed.json');
  await fs.writeFile(file,JSON.stringify({ConnectionReferences:[{LogicalName:'unused',ConnectionId:'',ConnectorId:''},{LogicalName:'active',ConnectionId:'synthetic-connection',ConnectorId:'connector'}]}));
  const config=resolveDeploymentProfiles({default:'dev',profiles:{dev:{connectionReferences:'mixed.json'}}},fixture.root);
  const loaded=await loadDeploymentProfiles(config);
  assert.equal(loaded.connectionReferences.length,1);assert.equal(loaded.connectionReferences[0].logicalName,'active');
  assert.equal(loaded.diagnostics[0].code,'DEPLOYMENT_PROFILE_CONNECTION_UNSET');assert.equal(loaded.diagnostics[0].count,1);assert.deepEqual(loaded.diagnostics[0].logicalNames,['unused']);
  const app=await createSimulator({...fixture,deploymentProfiles:config,watch:false});fixture.onCleanup(()=>app.close());
  assert.equal(app.store.snapshot().tables.connectionreference.length,1);
  assert.ok(app.state().diagnostics.some(d=>d.code==='DEPLOYMENT_PROFILE_CONNECTION_UNSET'));
});
test('source-relative profile paths follow the selected checkout and Solution files merge in order',async t=>{
  const fixture=await profileFixture(t);
  await fs.mkdir(path.join(fixture.sourceDir,'deployment-profiles'),{recursive:true});
  await fs.writeFile(path.join(fixture.sourceDir,'deployment-profiles','local.json'),JSON.stringify({EnvironmentVariables:[{SchemaName:'sample_Url',Value:'local last'}],ConnectionReferences:[{LogicalName:'sample_Api',ConnectionId:'local-connection',ConnectorId:'connector'}]}));
  const mirage={deploymentProfiles:{default:'dev',profiles:{dev:{environmentVariables:['profiles/dev-settings.json',{source:'deployment-profiles/local.json'}],connectionReferences:['profiles/dev-settings.json',{source:'deployment-profiles/local.json'}]}}}};
  const config=resolveMirageConfig(mirage,{configDir:fixture.root,sourceRoot:path.dirname(fixture.sourceDir),sourceDir:fixture.sourceDir}).deploymentProfiles;
  const loaded=await loadDeploymentProfiles(config);
  assert.equal(loaded.environmentVariables.sample_Url,'local last');assert.equal(loaded.connectionReferences[0].connectionId,'local-connection');
  const other=resolveMirageConfig(mirage,{configDir:fixture.root,sourceRoot:fixture.root,sourceDir:path.join(fixture.root,'other-checkout')});
  assert.equal(other.deploymentProfiles.profiles.dev.environmentVariables[1],path.join(fixture.root,'other-checkout','deployment-profiles','local.json'));
});
test('profile parser failures report file, code and line without exposing source values, including doctor',async t=>{
  const fixture=await profileFixture(t),file=path.join(fixture.root,'duplicate.yml');
  await fs.writeFile(file,'adx_contentsnippet: []\nadx_contentsnippet: []\nsecret: do-not-echo-this\n');
  const config=resolveDeploymentProfiles({default:'broken',profiles:{broken:{pages:'duplicate.yml'}}},fixture.root);
  await assert.rejects(loadDeploymentProfiles(config),error=>error.details.file==='duplicate.yml'&&error.details.parserCode==='DUPLICATE_KEY'&&error.details.line===2&&!error.message.includes('do-not-echo-this'));
  const status=await deploymentProfilesStatus(config);assert.equal(status.ready,false);assert.equal(status.profiles[0].files[0].exists,true);
  const report=await mirageReadiness({configDir:fixture.root,stateDir:path.join(fixture.root,'.paqvilo'),siteName:'synthetic',sourceDir:fixture.sourceDir,mirageConfig:{solutionRoots:[],dataPacks:[],deploymentProfiles:config}}, {}, {checkPort:async()=>true});
  assert.equal(report.deploymentProfiles.profiles[0].error.line,2);assert.ok(report.errors.some(message=>message.includes('duplicate.yml')));
});
