import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
const role='f0000000-0000-4000-8000-000000000001';
const flow='f0000000-0000-4000-8000-000000000002';
const standalone='f0000000-0000-4000-8000-000000000003';
export async function operationFixture(t, { solutionComponents = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-catalogue-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const definition = {properties:{definition:{triggers:{manual:{type:'Request',kind:'powerpages',inputs:{schema:{type:'object',properties:{Message:{type:'string'}},required:['Message']}}}},actions:{reply:{type:'Response',kind:'powerpages',inputs:{statusCode:200,body:{Message:"@triggerBody()?['Message']"}}}}}}};
  const files = {
    'website.yml':'adx_websiteid: site\nadx_name: Synthetic operations',
    'Home.webpage.yml':'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml':'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'Main.webtemplate.yml':'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':'<h1>Invented fixture</h1>',
    'Runner.webrole.yml':`adx_webroleid: ${role}\nadx_name: Runner`,
    'sample.serverlogic.yml':`adx_serverlogicid: sample\nadx_name: sample\nadx_serverlogic_adx_webrole:\n- ${role}`,
    'sample.js':`function get(){return JSON.stringify({source:true});}`,
    'Request.cloudflowconsumer.yml':`adx_cloudflowconsumerid: request\nadx_name: Echo\nadx_processid: ${flow}\nadx_flowapiurl: /_api/cloudflow/v1.0/trigger/${flow}\nadx_cloudflowconsumer_adx_webrole:\n- ${role}`,
    'Workflows/echo.json':JSON.stringify(definition),
    'Workflows/echo.json.data.xml':`<Workflow WorkflowId="{${flow}}" Name="Echo"/>`,
    'Workflows/standalone.json':JSON.stringify({properties:{definition:{actions:{connector:{type:'OpenApiConnection'}}}}}),
    'Workflows/standalone.json.data.xml':`<Workflow WorkflowId="{${standalone}}" Name="Connector workflow"/>`,
  };
  files['Other/Solution.xml']='<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName><Version>1.0</Version></SolutionManifest></ImportExportXml>';
  if (solutionComponents) {
    const component = site => `<powerpagecomponent powerpagecomponentid="f0000000-0000-4000-8000-000000000010"><content>{"adx_serverlogic_adx_webrole":["${role}"]}</content><name>Solution logic</name><powerpagecomponenttype>35</powerpagecomponenttype><powerpagesiteid><powerpagesiteid>${site}</powerpagesiteid></powerpagesiteid><filecontent>logic.sl</filecontent><statecode>0</statecode></powerpagecomponent>`;
    files['powerpagecomponents/logic/powerpagecomponent.xml']=component('site');
    files['powerpagecomponents/logic/filecontent/logic.sl']='function get(){return JSON.stringify({fromSolution:true});}';
    files['powerpagecomponents/other/powerpagecomponent.xml']=component('different-site');
    files['powerpagecomponents/other/filecontent/logic.sl']='function get(){throw new Error("Unrelated site");}';
  }
  for(const [name,body] of Object.entries(files)){const root=/^(Workflows|Other|powerpagecomponents)\//.test(name)?'solution':'portal';const file=path.join(dir,root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,body);}
  const app = await createSimulator({sourceDir:path.join(dir,'portal'),solutionRoots:[path.join(dir,'solution')],port:0,watch:false,initial:{version:1,tables:{},mappings:{},permissions:[],settings:{permissionMode:'enforce'},plugins:[],simulator:{mode:'local',pageMode:'local',endpoints:[],identityScope:'configured',identity:{id:'person',roles:['Runner'],roleSource:'override'}}}});
  t.after(()=>app.close());
  return {dir,app};
}
