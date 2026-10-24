import { createPortalRenderer } from 'paqvilo/mirage/lib/liquid.mjs';
import { normalizeMockLiquidFetchXml } from 'paqvilo/mirage/lib/data.mjs';
import { parseSolutionXml } from 'paqvilo/mirage/lib/solution-xml.mjs';

/** Parse the actual query template response, retaining selected Liquid values
 * as XML strings. SDK attributes and selected template fields are separate
 * contracts: aliases, nulls and choice drops must pass through the renderer. */
export function parseLiquidReplayResponse(body) {
  const root = parseSolutionXml(body);
  if (root.name !== 'co-test-response') throw new Error('The query template did not return a lab response.');
  const child = (node, name) => node?.children?.find((item) => item.name === name);
  const rows = (child(root, 'records')?.children ?? [])
    .filter((record) => record.name === 'record')
    .map((record) => {
      const row = {};
      for (const field of record.children ?? []) {
        if (
          field.name !== 'field' ||
          !field.attrs.name ||
          Object.hasOwn(row, field.attrs.name) ||
          !['true', 'false'].includes(field.attrs.null)
        )
          throw new Error('The query template returned invalid field metadata.');
        row[field.attrs.name] = field.attrs.null === 'true' ? null : field.text;
      }
      return row;
    });
  const paging = child(root, 'paging'),
    diagnostics = child(root, 'diagnostics');
  return {
    operationId: root.attrs['operation-id'],
    outcome: root.attrs.outcome,
    rows,
    more:
      String(paging?.attrs.more ?? '').toLowerCase() === 'true'
        ? true
        : String(paging?.attrs.more ?? '').toLowerCase() === 'false'
          ? false
          : null,
    authoredFetchXml: child(diagnostics, 'authored-fetchxml')?.text ?? '',
    effectiveFetchXml: child(diagnostics, 'effective-fetchxml')?.text ?? '',
  };
}

/** Render only explicitly supplied frozen sources. The caller supplies the
 * frozen identity and immutable operation inputs; dispatcher ownership checks
 * and authentication middleware are outside this query-template qualification.
 * No native output or expected outcome is used to select execution behavior. */
export function createLiquidReplayClient({ store, identity, portal, templates, datasetVersion }) {
  if (!store || !identity || !templates || typeof datasetVersion !== 'string')
    throw new Error('Liquid replay requires a frozen store, identity, templates and dataset version.');
  const sources = new Map();
  for (const template of templates) {
    if (typeof template.name !== 'string' || typeof template.source !== 'string' || sources.has(template.name))
      throw new Error('Frozen query template sources must be unique.');
    sources.set(template.name, template.source);
  }
  const capturedIdentity = structuredClone(identity);
  let providerFaults = [];
  const renderer = createPortalRenderer(
    { ...portal, templates: Object.fromEntries(templates.map((template) => [template.name, template])) },
    {
      observed: portal?.observed,
      previewFetchXml: (xml, _user, _request, options) =>
        store.previewPermissionFetchXml(xml, capturedIdentity, options),
      fetchXml: async (xml, _user, _request, options) => {
        try {
          return await store.readOperation(() =>
            normalizeMockLiquidFetchXml(
              store.fetchXml(xml, capturedIdentity, { portalRequest: true, profile: 'portal', right: options?.right }),
              xml,
              store.resolveMapping.bind(store),
            ),
          );
        } catch (cause) {
          providerFaults.push({
            code: cause.code ?? null,
            platformCode: cause.details?.innerCode ?? null,
            status: cause.status ?? null,
          });
          throw cause;
        }
      },
    },
  );
  return {
    qualificationScope:
      'Actual frozen query-template source through Mirage Liquid renderer; explicitly supplied frozen identity and operation inputs',
    async request({ caseId, variant, templateName, operation }) {
      const match = /^(?:fetchxml|inner|outer)(-part[1-9]\d*)?$/.exec(variant);
      if (!templateName && !match && variant !== 'query-budget')
        throw new Error('This query variant has no qualified Liquid-template adapter.');
      const name = templateName ?? `CO Query ${caseId}${match?.[1] ?? ''}`,
        source = sources.get(name);
      if (source === undefined) throw new Error('The exact frozen query-template source is unavailable.');
      providerFaults = [];
      const body = await renderer.renderString(source, {
        operation: structuredClone(operation),
        user: { id: capturedIdentity.contactId ?? capturedIdentity.id, roles: capturedIdentity.roles ?? [] },
        dataset_version: datasetVersion,
      });
      const root = parseSolutionXml(body),
        roles = root.children.find((node) => node.name === 'roles')?.children.map((node) => node.text) ?? [];
      const sameRoles =
        JSON.stringify([...roles].sort()) === JSON.stringify([...(capturedIdentity.roles ?? [])].sort());
      if (
        root.attrs['operation-id'] !== operation.id ||
        root.attrs['contact-id'] !== (capturedIdentity.contactId ?? capturedIdentity.id) ||
        root.attrs['case-id'] !== caseId ||
        root.attrs['dataset-version'] !== datasetVersion ||
        !sameRoles
      )
        throw new Error('Rendered query-template actor, roles, case, operation or dataset binding changed.');
      return {
        body,
        page: parseLiquidReplayResponse(body),
        templateName: name,
        responseBindingVerified: true,
        providerFaults: [...providerFaults],
      };
    },
  };
}
