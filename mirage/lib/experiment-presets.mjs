import { DataError } from './data-error.mjs';
import { validatePlatformOverrides } from './platform-settings.mjs';
import { validatePortalOverrides } from './portal-overrides.mjs';
const fail=message=>{throw new DataError(message,400,'InvalidExperimentPreset');};
const builtinIds=new Set(['source-defaults','expanded-query-budget','webapi-disabled']);
export const experimentId=id=>{if(typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)||['constructor','prototype','__proto__'].includes(id))fail('Use a preset ID of up to 80 letters, digits, hyphens or underscores.');return id;};
export function validateExperiment(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['id','name','platformOverrides','portalOverrides'].includes(k)))fail('An experiment contains id, name, platformOverrides and portalOverrides only.');
 experimentId(p.id);if(typeof p.name!=='string'||!p.name.trim()||p.name.length>160)fail('A preset requires a short name.');
 validatePlatformOverrides(p.platformOverrides??{});validatePortalOverrides(p.portalOverrides??{});
 if(Object.keys(p.portalOverrides??{}).some(k=>!['settings','snippets'].includes(k)))fail('Experiments affect site settings/snippets, not roles or access rules.');
 return p;
}
export function validateExperimentPresets(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)fail('Experiment presets must be an object with at most 100 entries.');
 for(const [id,p]of Object.entries(value)){
  validateExperiment(p);
  if(experimentId(id)!==p.id)fail('Preset identity mismatch.');
  if(builtinIds.has(id))fail('Built-in experiment IDs cannot be replaced.');
 }
 return value;
}
export function experimentPresets(state,portal){
 const disabled=Object.fromEntries(Object.keys(portal.settings??{}).filter(k=>/^Webapi\/[^/]+\/enabled$/i.test(k)).map(k=>[k,'False']));
 return [
  {id:'source-defaults',name:'Source defaults',platformOverrides:{},portalOverrides:{settings:{},snippets:{}},builtin:true},
  {id:'expanded-query-budget',name:'Simulated support increase (30)',platformOverrides:{QueryLinkEntityLimit:30},portalOverrides:{settings:{},snippets:{}},builtin:true},
  {id:'webapi-disabled',name:'Disable exported Web API tables',platformOverrides:{},portalOverrides:{settings:disabled,snippets:{}},builtin:true},
  ...Object.values(validateExperimentPresets(state.simulator?.experimentPresets)).map(p=>({...p,builtin:false})),
 ];
}
export function applyExperiment(state,p){
 const next=structuredClone(state);next.simulator??={};next.simulator.platformOverrides=structuredClone(p.platformOverrides??{});
 next.simulator.portalOverrides={...next.simulator.portalOverrides,settings:structuredClone(p.portalOverrides?.settings??{}),snippets:structuredClone(p.portalOverrides?.snippets??{})};
 next.simulator.activeExperiment={id:p.id,name:p.name};return next;
}
