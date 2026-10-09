// Public /_api surface implemented by the local runtime (server.mjs api()).
// The static inventory compares exported portal usage against these tables;
// keep them in sync with the handler when routes or headers change.

/** Request shapes recognised by the local /_api handler. */
export const WEBAPI_ROUTES = new Set([
  "collection",
  "collection/$count",
  "entity",
  "entity(alternate-key)",
  "entity/property-or-navigation",
  "entity/property/$value",
  "entity/navigation/$ref",
  "entity/navigation(key)/$ref",
]);

/** Request headers with defined local behaviour. */
export const WEBAPI_HEADERS = new Set([
  "If-Match",
  "If-None-Match",
  "MSCRM.SuppressDuplicateDetection",
  "OData-MaxVersion",
  "OData-Version",
  "__RequestVerificationToken",
  "X-Requested-With",
]);

/** Prefer header preferences honoured locally. */
export const WEBAPI_PREFERENCES = new Set([
  "odata.maxpagesize",
  "odata.include-annotations",
  "return=representation",
]);

/** Response/request annotations produced or accepted locally. */
export const WEBAPI_ANNOTATIONS = new Set([
  "OData.Community.Display.V1.FormattedValue",
  "OData.Community.Display.V1.AttributeName",
  "Microsoft.Dynamics.CRM.lookuplogicalname",
  "Microsoft.Dynamics.CRM.associatednavigationproperty",
  "Microsoft.Dynamics.CRM.fetchxmlpagingcookie",
  "Microsoft.Dynamics.CRM.morerecords",
  "Microsoft.Dynamics.CRM.totalrecordcount",
  "Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded",
  "odata.bind",
  "odata.id",
  "odata.nextLink",
  "odata.count",
  "odata.etag",
  "odata.context",
]);
