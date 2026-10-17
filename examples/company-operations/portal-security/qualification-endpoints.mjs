import { caseTemplate } from '../portal-harness/compile.mjs';
import { componentId } from './blueprint.mjs';

const identifier = /^[a-z][a-z0-9_]*$/i;
const literal = /^[A-Za-z0-9._-]{1,80}$/;

/** Anonymous probes cannot read controller-owned recording tables. Their
 * dispatcher has one source-bound query and escaped marker parameters; the
 * original observer independently verifies the SDK-stamped intent. */
export function compileAnonymousQualificationEndpoint(configuration, { suiteVersion, datasetVersion, namespace } = {}) {
  const plan = configuration.query;
  if (!configuration.roles.some(role => role.anonymous) || !identifier.test(plan.table) ||
      plan.fixtureBindings?.length || plan.fetchXml.includes('{{qualificationRecordIdValues}}') ||
      ![suiteVersion, datasetVersion, namespace].every(value => literal.test(value ?? '')))
    throw new Error('Anonymous endpoint needs its fixed source/fixture query and bounded version/namespace.');
  let source = caseTemplate(plan);
  const replacements = { 'operation.id': 'bound_operation_id', 'operation.pqvd_markerutc': 'bound_utc_marker',
    'operation.pqvd_markeroperation': 'bound_operation_marker', 'operation.pqvd_pagenumber': 'bound_page' };
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
  if (/entities\.|operation\./.test(source)) throw new Error('Anonymous query source unexpectedly reads a private operation.');
  source = `{% assign dataset_version = '${datasetVersion}' %}{% assign bound_operation_id = request.params.operationId | downcase %}{% assign bound_operation_marker = 'CO-OP:' | append: bound_operation_id %}{% assign bound_utc_marker = request.params.markerUtc %}{% assign bound_page = request.params.page | default: 1 | integer %}{% if user == nil and request.params.suiteVersion == '${suiteVersion}' and bound_operation_id.size == 36 and bound_utc_marker contains 'CO-UTC:' and bound_page >= 1 and bound_page <= 20 %}${source}{% else %}<co-test-response outcome="rejected"><error>Anonymous source-bound stamped read required.</error></co-test-response>{% endif %}`;
  const contextSource = `<main><pre id="co-context">&lt;co-context contact-id="{{ user.id | xml_escape | escape }}"&gt;&lt;roles&gt;{% for role in user.roles %}&lt;role&gt;{{ role | xml_escape | escape }}&lt;/role&gt;{% endfor %}&lt;/roles&gt;&lt;/co-context&gt;</pre></main>`;
  const id = suffix => componentId('anonymous-qualification:' + namespace + ':' + suffix);
  return { kind: 'anonymous-source-bound-qualification-endpoint', nativeMutation: false, namespace,
    template: { id: id('query'), type: 8, name: 'CO Anonymous Qualification ' + namespace, content: { source, mimetype: 'application/xml' } },
    contextTemplate: { id: id('context'), type: 8, name: 'CO Anonymous Qualification Context ' + namespace, content: { source: contextSource } },
    policy: { recordingTableGlobalGrants: false, acceptsAuthoredFetchXml: false, fixedTable: plan.table,
      sourceQueryId: plan.id, requireConfiguredSDKIntentProvenance: 'AnonymousPortal.ConfiguredSDKIntent',
      actor: 'Guid.Empty', controllerOwnershipIndependent: true, separateAnonymousBrowserRequired: true },
    requestParameters(operation, page = 1) {
      if (!/^[a-f0-9-]{36}$/i.test(operation.pqvd_testoperationid ?? '') || !operation.pqvd_markerutc?.startsWith('CO-UTC:') ||
          !Number.isInteger(page) || page < 1 || page > 20) throw new Error('Bind the actual immutable SDK marker and page.');
      return new URLSearchParams({ operationId: operation.pqvd_testoperationid, markerUtc: operation.pqvd_markerutc, page, suiteVersion }).toString();
    } };
}
