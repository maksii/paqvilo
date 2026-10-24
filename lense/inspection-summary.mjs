/** Compact inspection protocol, also used by the panel's legacy-report adapter. */
export function inspectionSummary(report) {
  const length = (value) => (Array.isArray(value) ? value.length : 0);
  return {
    path: report.path,
    view: 'summary',
    revision: report.revision,
    permissionMode: report.permissionMode,
    sourceRoots: report.sourceRoots,
    page: report.page
      ? {
          name: report.page.name,
          pageName: report.page.pageName ?? null,
          url: report.page.url,
          title: report.page.title ?? null,
          access: {
            allowed: report.page.access?.allowed ?? null,
            status: report.page.access?.status ?? null,
            code: report.page.access?.code ?? null,
            reason: report.page.access?.reason ?? null,
          },
        }
      : null,
    tables: (Array.isArray(report.tables) ? report.tables : []).map((table) => table.logicalName).filter(Boolean),
    counts: {
      accessRules: length(report.page?.access?.rules),
      templates: length(report.webTemplates),
      snippets: length(report.snippets),
      settings: length(report.siteSettings),
      forms: length(report.forms),
      views: length(report.views),
      tables: length(report.tables),
      columns: length(report.columns),
      usages: length(report.usages),
      related:
        length(report.related?.weblinks) +
        length(report.related?.sitemarkers) +
        length(report.related?.redirects) +
        length(report.related?.shortcuts),
      unresolved: length(report.unresolved),
    },
  };
}
