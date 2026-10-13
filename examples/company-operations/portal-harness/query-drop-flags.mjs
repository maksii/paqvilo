import{caseTemplate}from'./compile.mjs';
const flagBlock=label=>`<permission-flags phase="${label}">{% for property in flag_properties %}{% assign value = visibility_query[property] %}<flag name="{{ property | xml_escape }}" null="{% if value == nil %}true{% else %}false{% endif %}">{{ value | xml_escape }}</flag>{% endfor %}</permission-flags>`;
/** Flags/XML are captured before even the envelope's .results-dependent status.
 * This makes the before/after boundary explicit in actual deployed Liquid. */
export function queryDropFlagTemplate(plan){
 if(!['default','read','write','create','Create','invalid','delete','Delete','append','Append','appendto','AppendTo','append_to'].includes(plan.requestedRight))throw new Error('Unknown bounded FetchXML right probe.');
 const original=caseTemplate(plan),tag='{% fetchxml visibility_query %}',rightTag=plan.requestedRight==='default'?tag:`{% fetchxml visibility_query right:'${plan.requestedRight}' %}`,source=original.replace(tag,rightTag),at=source.indexOf('<co-test-response');
 return source.slice(0,at)+`{% assign flag_properties = 'permission_granted|global_permission_granted|rules_exist' | split: '|' %}{% capture flags_before %}${flagBlock('before-results')}{% endcapture %}{% capture xml_before %}{{ visibility_query.xml | xml_escape }}{% endcapture %}`+source.slice(at).replace('<diagnostics>',`<diagnostics>{{ flags_before }}<xml-before-results>{{ xml_before }}</xml-before-results>${flagBlock('after-results')}`);
}
export function buildQueryDropFlagProbes(roots){return roots.flatMap(({kind,plan},index)=>['default','read','write','create'].map(right=>({...plan,fragments:undefined,templateSuffix:undefined,id:`QF-FLAG-${index+1}-${right.toUpperCase()}`,variant:`query-drop-flags-${right}`,requestedRight:right,probeKind:kind})));}
