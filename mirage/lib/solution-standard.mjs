/**
 * Documented Microsoft Dataverse definitions that partial solution exports omit.
 *
 * Solution exports contain only the components (and, for system tables, only the
 * customized columns) that were added to a solution. When the selected sources do
 * not declare an entity set, primary key or a built-in relationship, the importer
 * consults this catalogue. Every entry was read from the Microsoft Dataverse
 * table/entity reference page it cites (properties tables, fetched 2026-10-07);
 * nothing here is inferred from a project.
 */
const PA = "https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/";
const D365 = "https://learn.microsoft.com/dynamics365/developer/reference/entities/";

// logicalName -> [EntitySetName, PrimaryIdAttribute, PrimaryNameAttribute|null, reference base]
const TABLES = {
  account: ["accounts", "accountid", "name", PA],
  activitypointer: ["activitypointers", "activityid", "subject", PA],
  adx_externalidentity: ["adx_externalidentities", "adx_externalidentityid", "adx_username", PA],
  adx_portalcomment: ["adx_portalcomments", "activityid", "subject", PA],
  annotation: ["annotations", "annotationid", "subject", PA],
  businessunit: ["businessunits", "businessunitid", "name", PA],
  category: ["categories", "categoryid", "title", PA],
  connection: ["connections", "connectionid", "name", PA],
  contact: ["contacts", "contactid", "fullname", PA],
  email: ["emails", "activityid", "subject", PA],
  environmentvariabledefinition: ["environmentvariabledefinitions", "environmentvariabledefinitionid", "schemaname", PA],
  environmentvariablevalue: ["environmentvariablevalues", "environmentvariablevalueid", "schemaname", PA],
  incident: ["incidents", "incidentid", "title", D365],
  knowledgearticle: ["knowledgearticles", "knowledgearticleid", "title", PA],
  languagelocale: ["languagelocale", "languagelocaleid", "name", PA],
  lead: ["leads", "leadid", "fullname", D365],
  mspp_webrole: ["mspp_webroles", "mspp_webroleid", "mspp_name", PA],
  msdyn_richtextfile: ["msdyn_richtextfiles", "msdyn_richtextfileid", "msdyn_name", PA],
  powerpagecomponent: ["powerpagecomponents", "powerpagecomponentid", "name", PA],
  processstage: ["processstages", "processstageid", "stagename", PA],
  product: ["products", "productid", "name", D365],
  queue: ["queues", "queueid", "name", PA],
  sharepointdocumentlocation: ["sharepointdocumentlocations", "sharepointdocumentlocationid", "name", PA],
  systemuser: ["systemusers", "systemuserid", "fullname", PA],
  task: ["tasks", "activityid", "subject", PA],
  team: ["teams", "teamid", "name", PA],
  webresource: ["webresourceset", "webresourceid", "name", PA],
};

/** Documented built-in relationships that portal grants reference but solutions rarely export. */
const ONE_TO_MANY = [
  // [schemaName, referencingEntity, referencedEntity, referencingAttribute, referencedAttribute, referencingNavigation, referencedNavigation, reference table]
  ["contact_customer_accounts", "contact", "account", "parentcustomerid", "accountid", "parentcustomerid_account", "contact_customer_accounts", "account"],
  ["contact_customer_contacts", "contact", "contact", "parentcustomerid", "contactid", "parentcustomerid_contact", "contact_customer_contacts", "contact"],
  ["account_primary_contact", "account", "contact", "primarycontactid", "contactid", "primarycontactid", "account_primary_contact", "account"],
  ["account_parent_account", "account", "account", "parentaccountid", "accountid", "parentaccountid", "account_parent_account", "account"],
  ["knowledgearticle_Annotations", "annotation", "knowledgearticle", "objectid", "knowledgearticleid", "objectid_knowledgearticle", "knowledgearticle_Annotations", "knowledgearticle"],
  ["environmentvariabledefinition_environmentvariablevalue", "environmentvariablevalue", "environmentvariabledefinition", "environmentvariabledefinitionid", "environmentvariabledefinitionid", "EnvironmentVariableDefinitionId", "environmentvariabledefinition_environmentvariablevalue", "environmentvariabledefinition"],
  // Activities regarding accounts and contacts (activitypointer, account and contact references).
  ["Account_ActivityPointers", "activitypointer", "account", "regardingobjectid", "accountid", "regardingobjectid_account", "Account_ActivityPointers", "activitypointer"],
  ["Contact_ActivityPointers", "activitypointer", "contact", "regardingobjectid", "contactid", "regardingobjectid_contact", "Contact_ActivityPointers", "activitypointer"],
  // Merged contacts (contact reference) and case customers (Dynamics 365 incident reference).
  ["contact_master_contact", "contact", "contact", "masterid", "contactid", "masterid", "contact_master_contact", "contact"],
  ["incident_customer_accounts", "incident", "account", "customerid", "accountid", "customerid_account", "incident_customer_accounts", "incident"],
  ["incident_customer_contacts", "incident", "contact", "customerid", "contactid", "customerid_contact", "incident_customer_contacts", "incident"],
  // SharePoint document locations regarding records (sharepointdocumentlocation reference;
  // the referenced navigation property is the relationship schema name, as documented for
  // Account_SharepointDocumentLocation).
  ["Account_SharepointDocumentLocation", "sharepointdocumentlocation", "account", "regardingobjectid", "accountid", "regardingobjectid_account", "Account_SharepointDocumentLocation", "sharepointdocumentlocation"],
  ["adx_portalcomment_SharePointDocumentLocations", "sharepointdocumentlocation", "adx_portalcomment", "regardingobjectid", "activityid", "regardingobjectid_adx_portalcomment", "adx_portalcomment_SharePointDocumentLocations", "sharepointdocumentlocation"],
  ["knowledgearticle_SharePointDocumentLocations", "sharepointdocumentlocation", "knowledgearticle", "regardingobjectid", "knowledgearticleid", "regardingobjectid_knowledgearticle", "knowledgearticle_SharePointDocumentLocations", "sharepointdocumentlocation"],
  ["KbArticle_SharepointDocumentLocation", "sharepointdocumentlocation", "kbarticle", "regardingobjectid", "kbarticleid", "regardingobjectid_kbarticle", "KbArticle_SharepointDocumentLocation", "sharepointdocumentlocation"],
  ["msdyn_knowledgearticletemplate_SharePointDocumentLocations", "sharepointdocumentlocation", "msdyn_knowledgearticletemplate", "regardingobjectid", "msdyn_knowledgearticletemplateid", "regardingobjectid_msdyn_knowledgearticletemplate", "msdyn_knowledgearticletemplate_SharePointDocumentLocations", "sharepointdocumentlocation"],
  ["mspp_website_SharePointDocumentLocations", "sharepointdocumentlocation", "mspp_website", "regardingobjectid", "mspp_websiteid", "regardingobjectid_mspp_website", "mspp_website_SharePointDocumentLocations", "sharepointdocumentlocation"],
  // Case activities, notes, email and portal comments (Dynamics 365 incident reference;
  // the referencing navigation from the activitypointer, annotation, email and
  // adx_portalcomment references).
  ["Incident_ActivityPointers", "activitypointer", "incident", "regardingobjectid", "incidentid", "regardingobjectid_incident", "Incident_ActivityPointers", "incident"],
  ["Incident_Annotation", "annotation", "incident", "objectid", "incidentid", "objectid_incident", "Incident_Annotation", "incident"],
  ["Incident_Emails", "email", "incident", "regardingobjectid", "incidentid", "regardingobjectid_incident_email", "Incident_Emails", "incident"],
  ["incident_adx_portalcomments", "adx_portalcomment", "incident", "regardingobjectid", "incidentid", "regardingobjectid_incident_adx_portalcomment", "incident_adx_portalcomments", "incident"],
  // Notes on portal comments (annotation reference).
  ["adx_portalcomment_Annotations", "annotation", "adx_portalcomment", "objectid", "activityid", "objectid_adx_portalcomment", "adx_portalcomment_Annotations", "annotation"],
];
const MANY_TO_MANY = [
  // [schemaName, entity1, entity2, intersectEntity, attribute1, attribute2, navigation1, navigation2, reference table]
  ["knowledgearticle_category", "knowledgearticle", "category", "knowledgearticlescategories", "knowledgearticleid", "categoryid", "knowledgearticle_category", "knowledgearticle_category", "knowledgearticle"],
  // Enhanced-model web role memberships (contact reference).
  ["powerpagecomponent_mspp_webrole_contact", "powerpagecomponent", "contact", "powerpagecomponent_mspp_webrole_contact", "powerpagecomponentid", "contactid", "powerpagecomponent_mspp_webrole_contact", "powerpagecomponent_mspp_webrole_contact", "contact"],
];

const reference = (logicalName) => {
  const row = TABLES[logicalName];
  return (row?.[3] ?? PA) + logicalName;
};

export function standardTable(logicalName) {
  const name = String(logicalName ?? "").toLowerCase();
  const row = TABLES[name];
  return row
    ? {
        entitySet: row[0],
        primaryIdAttribute: row[1],
        primaryNameAttribute: row[2],
        reference: reference(name),
      }
    : null;
}

export function standardRelationships() {
  return [
    ...ONE_TO_MANY.map(([schemaName, referencingEntity, referencedEntity, referencingAttribute, referencedAttribute, referencingNavigation, referencedNavigation, table]) => ({
      schemaName,
      type: "one-to-many",
      referencingEntity,
      referencedEntity,
      referencingAttribute,
      referencedAttribute,
      referencingNavigation,
      referencedNavigation,
      source: reference(table),
      standardFallback: true,
    })),
    ...MANY_TO_MANY.map(([schemaName, entity1, entity2, intersectEntity, attribute1, attribute2, navigation1, navigation2, table]) => ({
      schemaName,
      type: "many-to-many",
      entity1,
      entity2,
      intersectEntity,
      attribute1,
      attribute2,
      navigation1,
      navigation2,
      source: reference(table),
      standardFallback: true,
    })),
  ];
}

/**
 * Fallback only: Dataverse generates EntitySetName as the plural of the table name,
 * including intersect tables of many-to-many relationships
 * (https://learn.microsoft.com/power-apps/developer/data-platform/entity-metadata#table-names).
 * The selected exports show the generator's English rules for custom tables
 * (for example x_epiversions -> x_epiversionses). Results are marked inferred.
 */
export function pluralizeEntitySetName(logicalName) {
  const name = String(logicalName ?? "");
  if (/(?:s|x|z|ch|sh)$/i.test(name)) return name + "es";
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + "ies";
  return name + "s";
}

/**
 * Targets of the system lookup columns of standard tables (documented on every table
 * reference page, for example account: createdby -> systemuser, ownerid -> systemuser
 * and team). Their relationships are system components that solutions do not export.
 */
export const STANDARD_LOOKUP_TARGETS = {
  createdby: ["systemuser"],
  modifiedby: ["systemuser"],
  createdonbehalfby: ["systemuser"],
  modifiedonbehalfby: ["systemuser"],
  owninguser: ["systemuser"],
  owningteam: ["team"],
  owningbusinessunit: ["businessunit"],
  ownerid: ["systemuser", "team"],
  organizationid: ["organization"],
};
export const STANDARD_LOOKUP_REFERENCE = PA + "account";

/** Columns Dataverse creates on every standard table but never writes into solution XML. */
export const IMPLICIT_SYSTEM_COLUMNS = {
  versionnumber: {
    name: "versionnumber",
    label: "Version Number",
    dataverseType: "bigint",
    type: "number",
    required: false,
    requiredLevel: "none",
    validForCreate: false,
    validForUpdate: false,
    validForRead: true,
    implicit: true,
    source: PA + "environmentvariabledefinition",
  },
};
