import { DataError } from './data-error.mjs';

const learn='https://learn.microsoft.com/en-us/';
const organization=learn+'power-apps/developer/data-platform/organization-table';
const files=learn+'power-apps/developer/data-platform/attachment-annotation-files#file-size-limits';
const fileTypes=learn+'power-apps/developer/data-platform/files-images-overview';
const fetch=learn+'power-apps/developer/data-platform/fetchxml/';
const support='https://support.microsoft.com/en-au/topic/timeline-does-not-render-and-shows-records-could-not-be-loaded-4ce9200a-1afe-3ef4-ac11-a74b91f4f40c';
const item=(key,type,defaultValue,access,coverage,source,description,extra={})=>({key,type,defaultValue,access,coverage,source,description,...extra});

/** Curated feature-documented controls, not every writable Organization column. */
export const PLATFORM_SETTINGS=Object.freeze([
 item('QueryLinkEntityLimit','integer',15,'Microsoft support request','FetchXML and SDK QueryExpression joins',support,'Organization-wide support-managed join budget. Raising it here simulates an approved support change.',{min:1,max:1000}),
 item('MaxUploadFileSize','integer',5242880,'Organization setting','Annotation and ActivityMimeAttachment writes',files,'Maximum base64-encoded attachment size in bytes; file/image columns have separate limits.',{min:1,max:131072000,column:'maxuploadfilesize'}),
 item('BlockedAttachments','string','','Organization setting','Annotation and ActivityMimeAttachment writes',fileTypes,'Semicolon-separated blocked extensions, without dots. Empty local default; use the organization row or an override for the actual environment list.',{column:'blockedattachments'}),
 item('BlockedMimeTypes','string','','Organization setting','Annotation and ActivityMimeAttachment writes',fileTypes,'Semicolon-separated blocked MIME types.',{column:'blockedmimetypes'}),
 item('AllowedMimeTypes','string','','Organization setting','Annotation and ActivityMimeAttachment writes',fileTypes,'Semicolon-separated allowed MIME types; empty means no allowlist.',{column:'allowedmimetypes'}),
 ...[
  ['AuditSettings','string','auditsettings'],
  ['IsAuditEnabled','boolean','isauditenabled'],['IsUserAccessAuditEnabled','boolean','isuseraccessauditenabled'],
  ['AuditRetentionPeriodV2','integer','auditretentionperiodv2'],['UserAccessAuditingInterval','integer','useraccessauditinginterval'],
  ['PluginTraceLogSetting','integer','plugintracelogsetting'],['QuickFindRecordLimitEnabled','boolean','quickfindrecordlimitenabled'],
  ['ShareToPreviousOwnerOnAssign','boolean','sharetopreviousowneronassign'],['ExpireChangeTrackingInDays','integer','expirechangetrackingindays'],
  ['ExpireSubscriptionsInDays','integer','expiresubscriptionsindays'],['IsExternalSearchIndexEnabled','boolean','isexternalsearchindexenabled'],
 ].map(([key,type,column])=>item(key,type,null,'Organization setting','Catalogue only; behavior not simulated',organization,'Feature-documented organization option. Stored and reported for scenario provenance; changing it does not invent the associated service.',{column,...(type==='integer'?{min:0,max:2147483647}:{}),...(key==='PluginTraceLogSetting'?{min:0,max:2}:{}),...(key==='AuditRetentionPeriodV2'?{min:-1}: {})})),
 ...['AllowSaveAsDraftAppointment','AutoTrackSentFolderItems'].map(key=>item(key,'boolean',false,'OrgDBOrgSettings tool','Catalogue only; Exchange synchronization not simulated',learn+'power-platform/admin/orgdborgsettings','Documented server-side synchronization option; change through the supported OrganizationSettingsEditor tool in a real environment.')),
 item('WorkflowSettings.MaxDepth','integer',8,'On-premises deployment PowerShell','Catalogue only; CLR/async safety bounds remain independent',learn+'dotnet/api/microsoft.xrm.sdk.iexecutioncontext.depth','Documented legacy deployment control; not presented as a self-service cloud organization setting.',{min:1,max:32}),
 item('FetchConditionLimit','integer',500,'Simulator experiment','FetchXML condition/link count',fetch+'filter-rows','Documented default limit; this local override is not a claim of a supported cloud administration setting.',{min:1,max:10000}),
 item('AggregateQueryRecordLimit','integer',50000,'Simulator experiment','FetchXML aggregates only',fetch+'aggregate-data','Documented FetchXML aggregate bound. Local override; no inferred cloud support ticket entitlement. OData aggregate limits remain separate.',{min:1,max:1000000}),
 item('FetchLinkDepth','integer',32,'Simulator safety bound','FetchXML nesting',fetch+'join-tables','Local execution bound, not a documented Dataverse organization option.',{min:1,max:60}),
 item('FetchJoinRowLimit','integer',250000,'Simulator safety bound','Intermediate FetchXML joined rows',null,'Local memory protection; exceeding it fails rather than truncating rows.',{min:1,max:1000000,stateSetting:'fetchJoinRowLimit'}),
]);
const definitions=new Map(PLATFORM_SETTINGS.map(x=>[x.key,x]));
export function validatePlatformOverrides(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new DataError('Platform overrides must be an object.',400,'InvalidPlatformSetting');
 for(const [key,v]of Object.entries(value)){
  const d=definitions.get(key);if(!d)throw new DataError('Unknown platform setting: '+key,400,'InvalidPlatformSetting');
  if(d.type==='integer'&&(!Number.isSafeInteger(v)||v<d.min||v>d.max)||d.type==='boolean'&&typeof v!=='boolean'||d.type==='string'&&(typeof v!=='string'||v.length>8192))throw new DataError('Invalid value for platform setting '+key,400,'InvalidPlatformSetting');
 }
 return value;
}
export function platformSettingEntries(state){
 const overrides=validatePlatformOverrides(state.simulator?.platformOverrides);
 const rows=state.tables?.organization??[],org=rows.length===1?rows[0]:{};
 return PLATFORM_SETTINGS.map(d=>{
  const local=Object.hasOwn(overrides,d.key),fromOrganization=d.column&&Object.hasOwn(org,d.column)&&org[d.column]!=null,fromSetting=d.stateSetting&&state.settings?.[d.stateSetting]!=null,source=fromOrganization?org[d.column]:fromSetting?state.settings[d.stateSetting]:d.defaultValue;
  return {...d,sourceValue:source,value:local?overrides[d.key]:source,overridden:local,origin:local?'Instance override':fromOrganization?'Organization row':fromSetting?'Existing simulator setting':'Default / not configured'};
 });
}
export const platformValues=state=>Object.fromEntries(platformSettingEntries(state).map(d=>[d.key,d.value]));
export function assertAttachmentPolicy(state,entity,row,changes=row){
 if(!['annotation','activitymimeattachment'].includes(entity)||!['filename','mimetype','documentbody','body'].some(k=>Object.hasOwn(changes,k)))return;
 const p=platformValues(state),body=row[entity==='annotation'?'documentbody':'body'];
 if(body==null&&!row.filename)return;
 const list=value=>String(value??'').split(/[;,\s]+/).map(s=>s.toLowerCase().replace(/^\./,'')).filter(Boolean);
 const extension=String(row.filename??'').split(/[\\/]/).pop().split('.').slice(1).pop()?.toLowerCase();
 const mime=String(row.mimetype??'application/octet-stream').toLowerCase().split(';')[0].trim();
 if(extension&&list(p.BlockedAttachments).includes(extension))throw new DataError('Attachment extension is blocked by the organization.',400,'AttachmentTypeBlocked');
 const allowed=list(p.AllowedMimeTypes);if(list(p.BlockedMimeTypes).includes(mime)||allowed.length&&!allowed.includes(mime))throw new DataError('Attachment MIME type is blocked by the organization.',400,'AttachmentTypeBlocked');
 if(typeof body==='string'&&Buffer.byteLength(body,'utf8')>p.MaxUploadFileSize)throw new DataError('Attachment file size is too big.',400,'AttachmentTooLarge',{innerCode:'0x80044a02'});
}
