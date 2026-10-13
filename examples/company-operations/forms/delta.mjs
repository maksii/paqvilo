import { compileForms } from './catalogue.mjs';

/** Read-only packet builder. The coordinator supplies actual metadata and
 * executes only this table's requests after inspecting the journalled plan. */
export async function planCurrencyReferenceForms(client, schema) {
  const table = 'pqvd_currencyreference';
  const metadata = { [table]: await client.get(`EntityDefinitions(LogicalName='${table}')?$select=LogicalName,PrimaryIdAttribute,PrimaryNameAttribute,ObjectTypeCode&$expand=Attributes($select=LogicalName,AttributeType,AttributeTypeName,DisplayName,IsValidForUpdate)`) };
  const catalogue = compileForms(schema, metadata, { tables: [table] });
  if (catalogue.forms.length !== 2 || catalogue.views.length !== 3 || catalogue.adjustments.length !== 2 ||
      catalogue.forms.some(form => /disabled="false"/.test(form.formXml))) throw new Error('CurrencyReference delta must contain immutable Administration/Summary forms, three views and two adjustments.');
  return { kind: 'source-only-currency-reference-form-delta', table, nativeMutation: false,
    catalogue, requests: [
      ...catalogue.views.map(view => ({ route: 'savedqueries', id: view.id, solution: view.solution, componentType: 26,
        body: { name: view.name, returnedtypecode: table, querytype: view.queryType, fetchxml: view.fetchXml, layoutxml: view.layoutXml } })),
      ...catalogue.forms.map(form => ({ route: 'systemforms', id: form.id, solution: form.solution, componentType: 60,
        body: { name: form.name, objecttypecode: table, type: 2, formxml: form.formXml, formactivationstate: 1 } })),
    ], adjustmentContract: 'Resolve the single generated view per querytype 64/4 from this table; preserve native IDs. Quick Find requires existing solution import workflow.',
    defaultViewId: catalogue.views[0].id, publishEntityNames: [table] };
}
