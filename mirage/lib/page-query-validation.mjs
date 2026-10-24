// The opt-in scanner follows Microsoft's .NET reference source
// System.Web.CrossSiteScriptingValidation.IsDangerousString. A site's captured
// request rejection selects this mode; it does not reproduce a .NET error page.
export function observedPageQueryValidation(url, observed) {
  if (observed?.requestValidation !== 'aspnet-query') return null;
  // Inspect every decoded value, including earlier duplicate values that a
  // dictionary projection would overwrite. Do not echo input names or values.
  for (const value of url.searchParams.values()) {
    if (/<[a-z!?/]|&#/i.test(value)) {
      return {
        status: 500,
        code: 'PAGE_QUERY_REQUEST_VALIDATION',
        message: 'A potentially dangerous Request.QueryString value was detected from the client.',
      };
    }
  }
  return null;
}
