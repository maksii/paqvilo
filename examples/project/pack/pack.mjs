import fs from 'node:fs';
import {pluginSteps} from './dataverse-plugins.mjs';
const tables=JSON.parse(fs.readFileSync(new URL('./fixtures.json',import.meta.url),'utf8'));
const mappings={account:{entitySet:'accounts',inferred:true,idColumn:'accountid'},contact:{entitySet:'contacts',inferred:true,idColumn:'contactid'},annotation:{entitySet:'annotations',inferred:true,idColumn:'annotationid'},transactioncurrency:{entitySet:'transactioncurrencies',inferred:true,idColumn:'transactioncurrencyid'}};
// Permissions are imported from the portal. Only this contact receives the editor role.
const permissions=[];
const personaRoles=[{contactId:tables.contact[0].contactid,roles:['Workspace Editors']}];
// Explicit local model of Dataverse's contact display-name calculation.
const plugins=[{id:'demo-contact-name',entity:'contact',operations:['create','update'],set:{fullname:{op:'concat',args:['$record.firstname',' ','$record.lastname']}}}];
export default {
 id:'example',name:'Paqvilo demo',description:'Invented accounts, related contacts and attachments',
 matches:({portal})=>portal?.website?.name==='Paqvilo demo',
 presets:()=>({
  'example-demo':{name:'Populated account workspace',description:'12 accounts, 24 contacts and two notes; editor and reader access',mappings,tables,permissions,plugins,personaRoles,permissionSource:'exported',settings:{permissionMode:'enforce'}},
  'example-empty':{name:'Empty account workspace',description:'No accounts or notes; editor and reader remain available for local sign-in',mappings,tables:{...tables,account:[],annotation:[],contact:tables.contact.slice(0,2).map(({parentcustomerid,_parentcustomerid_value,...contact})=>contact)},permissions,plugins,personaRoles,permissionSource:'exported',settings:{permissionMode:'enforce'}},
 }),
 generators:{},personas:[],plugins:[],pluginSteps,
 serverLogics:{'paqvilo-estimate':({runExportedServerLogic})=>runExportedServerLogic(),'paqvilo-account-summary':({runExportedServerLogic})=>runExportedServerLogic()},
 cloudFlows:{'Example Location':({runExportedCloudFlow})=>runExportedCloudFlow()},
};
