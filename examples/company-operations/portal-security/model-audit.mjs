// A configuration/fixture audit, not a replacement for Power Pages authorization.
// Compare graph reachability with the independently authored catalogue assertions.
function contactScopeRows(node, actor, rowsByTable, relationships, reached) {
  const relationship = relationships.get(node.relationship);
  for (const row of rowsByTable.get(node.table) ?? [])
    if (row.refs?.[relationship.lookup.name] === actor.key) reached.add(row.key);
}

function manyToManyRows(relationship, parentNode, parents, associations, reached) {
  for (const association of associations.filter((item) => item.relationship === relationship.name)) {
    if (relationship.parent === parentNode.table && parents.has(association.from))
      for (const key of association.to) reached.add(key);
    else if (relationship.child === parentNode.table && association.to.some((key) => parents.has(key)))
      reached.add(association.from);
  }
}

function relatedScopeRows(node, blueprint, visibleByNode, relationships, rowsByTable, { byKey, catalogue, reached }) {
  const parents = visibleByNode.get(node.parent) ?? new Set(),
    parentNode = blueprint.nodes.find((item) => item.key === node.parent),
    relationship = relationships.get(node.relationship);
  if (relationship.kind === 'manyToMany') {
    manyToManyRows(relationship, parentNode, parents, catalogue.associations, reached);
  } else if (relationship.parent === parentNode.table) {
    for (const row of rowsByTable.get(node.table) ?? [])
      if (parents.has(row.refs?.[relationship.lookup.name])) reached.add(row.key);
  } else {
    for (const parent of parents) {
      const target = byKey.get(parent)?.refs?.[relationship.lookup.name];
      if (target) reached.add(target);
    }
  }
}

function reachedRows(node, actor, context) {
  const reached = new Set();
  if (node.scope === 'Self') {
    if (actor?.table === 'contact') reached.add(actor.key);
  } else if (node.scope === 'Contact') {
    contactScopeRows(node, actor, context.rowsByTable, context.relationships, reached);
  } else {
    relatedScopeRows(node, context.blueprint, context.visibleByNode, context.relationships, context.rowsByTable, {
      byKey: context.byKey,
      catalogue: context.catalogue,
      reached,
    });
  }
  return reached;
}

function addEffectivePrivileges(node, reached, effective) {
  for (const key of reached) {
    if (!effective.has(key)) effective.set(key, { privileges: new Set(), provenance: [] });
    const entry = effective.get(key);
    for (const [right, value] of Object.entries(node.privileges)) if (value) entry.privileges.add(right);
    entry.provenance.push(node.key);
  }
}

export function evaluateConfiguredGraph(blueprint, schema, catalogue, personaKey) {
  const persona = catalogue.personas.find((p) => p.key === personaKey);
  if (!persona) throw new Error('Unknown persona');
  const actor = catalogue.records.find((r) => r.id === persona.contactId),
    roles = new Set([...persona.webRoles, 'TESTRUNNER']);
  const byKey = new Map(catalogue.records.map((r) => [r.key, r])),
    rowsByTable = new Map();
  for (const row of catalogue.records) {
    if (!rowsByTable.has(row.table)) rowsByTable.set(row.table, []);
    rowsByTable.get(row.table).push(row);
  }
  const relationships = new Map(schema.relationships.map((r) => [r.name, r]));
  relationships.set('account_parent_account', {
    kind: 'oneToMany',
    parent: 'account',
    child: 'account',
    lookup: { name: 'parentaccountid' },
  });
  const visibleByNode = new Map(),
    effective = new Map();
  const context = { blueprint, visibleByNode, relationships, rowsByTable, byKey, catalogue };
  for (const node of blueprint.nodes) {
    if (!roles.has(node.role) || !node.active) {
      visibleByNode.set(node.key, new Set());
      continue;
    }
    const reached = reachedRows(node, actor, context);
    visibleByNode.set(node.key, reached);
    addEffectivePrivileges(node, reached, effective);
  }
  return effective;
}
export function auditScenarioOracles(blueprint, schema, catalogue) {
  const mismatch = [],
    supported = { Read: 'read', Write: 'write', Delete: 'delete', Append: 'append', AppendTo: 'appendTo' },
    cache = new Map();
  let checked = 0,
    skipped = 0;
  for (const scenario of catalogue.scenarios) {
    const cacheKey = scenario.persona + ':' + (scenario.variant ?? 'baseline');
    if (!cache.has(cacheKey)) {
      let configured = blueprint;
      if (scenario.variant === 'website-auditor-parent-disabled') {
        configured = structuredClone(blueprint);
        configured.nodes.find((n) => n.key === 'AUDITOR-GRANTS-ACCESSPERMISSION').active = false;
      } else if (scenario.variant) {
        skipped += scenario.expected.length;
        continue;
      }
      cache.set(cacheKey, evaluateConfiguredGraph(configured, schema, catalogue, scenario.persona));
    }
    const effective = cache.get(cacheKey);
    for (const expected of scenario.expected) {
      const right = supported[expected.privilege];
      if (!right) {
        skipped++;
        continue;
      }
      checked++;
      const result = effective.get(expected.target),
        actual = result?.privileges.has(right) ?? false;
      if (actual !== expected.allowed)
        mismatch.push({
          scenario: scenario.id,
          persona: scenario.persona,
          target: expected.target,
          privilege: expected.privilege,
          expected: expected.allowed,
          actual,
          provenance: result?.provenance ?? [],
        });
    }
  }
  return {
    kind: 'offline-configured-graph-vs-independent-oracles',
    checked,
    skipped,
    mismatch,
    passed: mismatch.length === 0,
    runtimeVerified: false,
  };
}
