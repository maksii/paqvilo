import {caseTemplate} from './compile.mjs';
/** Isolated native probes for the FetchXML QueryDrop property contract. The
 * no-access/XML-only variants deliberately never dereference .results. */
export function queryDropProbeTemplate(plan,mode) {
 if(!['none','xml','results','both'].includes(mode))throw new Error('Unknown QueryDrop access mode.');
 const full=caseTemplate(plan);if(mode==='both')return full;
 if(mode==='results')return full.replace('<effective-fetchxml>{{ visibility_query.xml | xml_escape }}</effective-fetchxml>','');
 const prefix=full.slice(0,full.indexOf('<co-test-response'));
 return prefix+`<co-test-response version="1" outcome="results-not-requested" case-id="${plan.id}" operation-id="{{ operation.id | xml_escape }}" contact-id="{{ user.id | xml_escape }}" dataset-version="{{ dataset_version | xml_escape }}"><roles>{% for role in user.roles %}<role>{{ role | xml_escape }}</role>{% endfor %}</roles><records/><paging more="false"/><diagnostics><authored-fetchxml>{{ authored_xml | xml_escape }}</authored-fetchxml>${mode==='xml'?'<effective-fetchxml>{{ visibility_query.xml | xml_escape }}</effective-fetchxml>':''}</diagnostics></co-test-response>`;
}
export function buildQueryDropProbes(admittedPlan,limitedPlan) {
 return [admittedPlan,limitedPlan].flatMap((plan,index)=>['none','xml','results','both'].map(mode=>({...plan,id:`QF-DROP-${index?'LIMIT':'READ'}-${mode.toUpperCase()}`,variant:`query-drop-${mode}`,fragments:undefined,templateSuffix:undefined,accessMode:mode,probeKind:index?'authored-link-limit':'admitted-read'})));
}
