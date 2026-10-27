// Expand local CanvasComponent definitions without rewriting Power Fx. Runtime lookup uses
// componentScopes to resolve identifiers in the scope of each instance.
const PREPARED = Symbol('canvas.components.prepared');
export function prepareCanvasSource(source) {
  if (source[PREPARED]) return source;
  // Ambiguous app-global names cannot be expanded without discarding or
  // misattributing source formulas; the runtime refuses this diagnostic.
  if ((source.diagnostics ?? []).some((item) => item.code === 'CANVAS_SOURCE_NAME_COLLISION')) return source;
  const tree = source.tree ?? {
    format: source.app?.format ?? 'pa.yaml',
    screens: source.screens ?? [],
    components: source.components ?? [],
  };
  const definitions = new Map((tree.components ?? []).map((item) => [item.name.toLowerCase(), item]));
  const originalFormulas = source.formulas ?? [];
  const formulas = originalFormulas.filter((row) => !definitions.has(row.owner.split('.')[0].toLowerCase()));
  const scopes = {};
  const functions = {};
  const diagnostics = [...(source.diagnostics ?? [])];
  const used = new Set(
    (tree.screens ?? [])
      .flatMap((screen) => [screen.name, ...(screen.controls ?? []).map((c) => c.name)])
      .map((name) => name.toLowerCase()),
  );
  let serial = 0;
  let count = 0,
    limited = false;
  const next = () => {
    let name;
    do {
      name = `__paqcmp_${++serial}`;
    } while (used.has(name.toLowerCase()));
    used.add(name.toLowerCase());
    return name;
  };
  const report = (code, control) =>
    diagnostics.push({
      code,
      message: `Component ${control.name} cannot be expanded by the local runtime.`,
      source: null,
    });
  const rows = (owner) => originalFormulas.filter((row) => row.owner.toLowerCase() === owner.toLowerCase());
  const screens = (tree.screens ?? []).map((screen) => {
    const output = [];
    const expand = (control, parentScope = null, stack = []) => {
      if (count >= 5000 || stack.length >= 32) {
        if (!limited) {
          report('CANVAS_COMPONENT_EXPANSION_LIMIT', control);
          limited = true;
        }
        return;
      }
      count++;
      const component =
        control.componentName && (control.control ?? '').toLowerCase().startsWith('canvascomponent')
          ? definitions.get(control.componentName.toLowerCase())
          : null;
      if (!control.componentName || !(control.control ?? '').toLowerCase().startsWith('canvascomponent')) {
        output.push(control);
        return;
      }
      if (control.componentLibraryUniqueName || !component || component.definitionType !== 'CanvasComponent') {
        report('CANVAS_COMPONENT_DEFINITION_UNAVAILABLE', control);
        output.push(control);
        return;
      }
      if (stack.includes(component.name.toLowerCase())) {
        report('CANVAS_COMPONENT_RECURSIVE', control);
        output.push(control);
        return;
      }
      const unsupported = Object.values(component.customProperties ?? {}).some(
        (property) =>
          (!['Input', 'Output', 'InputFunction', 'OutputFunction', 'Action', 'Event'].includes(property.kind) &&
            !(property.kind === 'LegacyUnknown' && property.functionScope !== true)) ||
          (['InputFunction', 'OutputFunction', 'Action', 'Event'].includes(property.kind) &&
            (!property.returnType || property.parametersValid === false)),
      );
      if (unsupported) {
        report('CANVAS_COMPONENT_PROPERTY_UNSUPPORTED', control);
        output.push(control);
        return;
      }
      const root = control.name;
      const children = component.controls ?? [];
      const local = Object.fromEntries(children.map((child) => [child.name, next()]));
      const scope = {
        root,
        definition: component.name,
        locals: local,
        accessAppScope: component.accessAppScope === true,
        resetInputs: Object.entries(component.customProperties ?? {})
          .filter(([, property]) => property.kind === 'Input' && property.raiseOnReset === true)
          .map(([name]) => name),
        parent: parentScope,
      };
      scopes[root] = scope;
      functions[root] = Object.fromEntries(
        Object.entries(component.customProperties ?? {}).filter(([, property]) =>
          ['InputFunction', 'OutputFunction', 'Action', 'Event'].includes(property.kind),
        ),
      );
      output.push({ ...control, control: 'GroupContainer@1.0.0', componentName: undefined, componentInstance: root });
      const instanceOwner = `${screen.name}.${root}`;
      const existing = new Set(
        formulas
          .filter((row) => row.owner.toLowerCase() === instanceOwner.toLowerCase())
          .map((row) => row.property.toLowerCase()),
      );
      for (const row of rows(component.name)) {
        const property = component.customProperties?.[row.property];
        if (
          ['Input', 'LegacyUnknown', 'InputFunction', 'Event'].includes(property?.kind) &&
          existing.has(row.property.toLowerCase())
        )
          continue;
        formulas.push({ ...row, owner: instanceOwner, componentDefinition: component.name });
      }
      for (const [name, property] of Object.entries(component.customProperties ?? {})) {
        if (
          ['Input', 'LegacyUnknown', 'InputFunction', 'Event'].includes(property.kind) &&
          property.default != null &&
          !existing.has(name.toLowerCase()) &&
          !rows(component.name).some((row) => row.property.toLowerCase() === name.toLowerCase())
        )
          formulas.push({
            owner: instanceOwner,
            property: name,
            text: property.default,
            source: null,
            line: null,
            componentDefinition: component.name,
          });
      }
      for (const child of children) {
        const name = local[child.name],
          parent = child.parent ? local[child.parent] : root;
        const copy = { ...child, name, originalName: child.name, componentInstance: root, parent };
        scopes[name] = scope;
        for (const row of rows(`${component.name}.${child.name}`))
          formulas.push({ ...row, owner: `${screen.name}.${name}`, componentDefinition: component.name });
        expand(copy, root, [...stack, component.name.toLowerCase()]);
      }
    };
    for (const control of screen.controls ?? []) expand({ ...control });
    return { ...screen, controls: output };
  });
  return {
    ...source,
    [PREPARED]: true,
    tree: { ...tree, screens },
    screens,
    formulas,
    diagnostics,
    componentScopes: scopes,
    componentFunctions: functions,
  };
}
