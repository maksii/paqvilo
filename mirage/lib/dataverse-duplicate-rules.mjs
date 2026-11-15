// Published duplicate-detection rules and their conditions. A leaf module: exported-plugins.mjs reads the rules for the
// PreBusinessEntity image, and importing dataverse-duplicates.mjs there would pull data.mjs into the settings import
// chain (config-keys -> ... -> secret-resolver) before config-keys has initialized.
const PUBLISHED = 2; // statuscode Published; its statecode is Active (1)
const idText = (v) => String((v !== null && typeof v === 'object' ? v.id : v) ?? '').toLowerCase();

export const publishedRules = (store, filter) =>
  store.tableRows('duplicaterule').filter((r) => Number(r.statuscode) === PUBLISHED && filter(r));
export const conditionsOf = (store, rule) =>
  store.tableRows('duplicaterulecondition').filter((c) => idText(c.regardingobjectid) === idText(rule.duplicateruleid));
