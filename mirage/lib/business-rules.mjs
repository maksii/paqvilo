// Interpreter for exported business rules (workflow category 2): the rule's XAML
// (Workflows/<name>-<id>.xaml) and its metadata (<name>-<id>.xaml.data.xml).
// It evaluates the designer's ConditionSequence against a record and returns the
// effects the platform would apply: visibility, lock, required level, set/default
// value and field error messages. It executes nothing beyond these known activities.
//
// Live evidence (baseline item-edit/hidden-by-rule, item-create/rule-error): Power
// Pages basic forms show none of these effects, client- or server-side, so the
// renderer does not apply them; this module answers what a rule would do.
import { parseSolutionXml, descendants, child, childText } from "./solution-xml.mjs";

const canonical = (value) => String(value ?? "").replace(/[{}]/g, "").toLowerCase();
const unsupported = (what) => { throw new Error(`Unsupported business rule ${what}`); };
const activityName = (node) => /Activities\.(\w+),/.exec(node.attrs.AssemblyQualifiedName ?? "")?.[1];
const keyed = (node, key) => node?.children.find((item) => item.attrs["x:Key"] === key);
const argument = (node, key) => keyed(child(node, "mxswa:ActivityReference.Arguments"), key)?.text.trim();
const property = (node, key) => keyed(child(node, "mxswa:ActivityReference.Properties"), key);
const variableName = (text) => /^\[(\w+)\]$/.exec(String(text ?? "").trim())?.[1] ?? unsupported(`expression ${text}`);

/** `[New Object() { Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.Integer, "500" }]` */
function crmLiteral(text) {
  const match = /WorkflowPropertyType\.(\w+),\s*"((?:[^"]|"")*)"/.exec(text ?? "") ?? unsupported(`literal ${text}`);
  const value = match[2].replace(/""/g, '"');
  switch (match[1]) {
    case "Boolean": return /^true$/i.test(value);
    case "Integer": case "OptionSetValue": return Number.parseInt(value, 10);
    case "Decimal": case "Float": case "Money": return Number(value);
    case "String": return value;
    default: return unsupported(`literal type ${match[1]}`);
  }
}

const scalar = (value) => (value && typeof value === "object" && "value" in value ? value.value : value);
const blank = (value) => value === undefined || value === null || value === "";

function compare(operator, operand, parameters) {
  const left = scalar(operand), right = scalar(parameters[0]);
  const number = typeof right === "number" && !blank(left) ? Number(left) : left;
  const bool = typeof right === "boolean" && !blank(left) ? left === true || /^(true|1)$/i.test(String(left)) : number;
  switch (operator) {
    case "Null": return blank(left);
    case "NotNull": return !blank(left);
    case "Equal": return !blank(left) && bool === right;
    case "NotEqual": return blank(left) || bool !== right;
    case "GreaterThan": return !blank(left) && number > right;
    case "GreaterEqual": return !blank(left) && number >= right;
    case "LessThan": return !blank(left) && number < right;
    case "LessEqual": return !blank(left) && number <= right;
    default: return unsupported(`operator ${operator}`);
  }
}

/** Effects of one rule's XAML for `record` ({ logicalName: value }); `lcid` picks the error label. */
export function evaluateBusinessRule(xaml, record = {}, { lcid = 1033 } = {}) {
  const root = typeof xaml === "string" ? parseSolutionXml(xaml) : xaml;
  const vars = new Map();
  const effects = [];
  const read = (text) => {
    const name = variableName(text);
    return name === "True" ? true : vars.get(name);
  };
  const run = (nodes, scope = { temp: {} }) => {
    let taken = false;
    for (const node of nodes) {
      const name = node.name;
      if (name === "mxswa:GetEntityProperty") vars.set(variableName(node.attrs.Value), record[node.attrs.Attribute]);
      else if (name === "mxswa:SetEntityProperty") scope.temp[node.attrs.Attribute] = node.attrs.Value === "[Nothing]" ? null : read(node.attrs.Value);
      else if (name === "Assign") continue;
      else if (name === "Sequence") run(node.children.filter((item) => !item.name.startsWith("Sequence.")), { temp: {} });
      else if (name === "mcwc:SetVisibility") effects.push({ type: "visibility", field: node.attrs.ControlId, visible: node.attrs.IsVisible === "True" });
      else if (name === "mcwc:SetDisplayMode") effects.push({ type: "lock", field: node.attrs.ControlId, locked: node.attrs.IsReadOnly === "True" });
      else if (name === "mcwc:SetFieldRequiredLevel") effects.push({ type: "required", field: node.attrs.ControlId, level: node.attrs.RequiredLevel });
      else if (name === "mcwc:SetAttributeValue" || name === "mcwc:SetDefaultValue")
        for (const [field, value] of Object.entries(scope.temp)) effects.push({ type: name === "mcwc:SetAttributeValue" ? "setValue" : "setDefault", field, value });
      else if (name === "mcwc:SetMessage") {
        const labels = descendants(node, "mcwo:StepLabel");
        const label = labels.find((item) => Number(item.attrs.LanguageCode) === lcid) ?? labels[0];
        effects.push({ type: "error", field: node.attrs.ControlId, message: label?.attrs.Description ?? "" });
      } else if (name === "mxswa:ActivityReference") {
        const kind = activityName(node);
        if (kind === "EvaluateExpression") {
          if (argument(node, "ExpressionOperator") !== "CreateCrmType") unsupported(`expression ${argument(node, "ExpressionOperator")}`);
          vars.set(variableName(argument(node, "Result")), crmLiteral(argument(node, "Parameters")));
        } else if (kind === "EvaluateCondition") {
          const parameters = /\{([^}]*)\}/.exec(argument(node, "Parameters") ?? "")?.[1].split(",").map((item) => vars.get(item.trim())) ?? [];
          vars.set(variableName(argument(node, "Result")), compare(argument(node, "ConditionOperator"), read(argument(node, "Operand")), parameters));
        } else if (kind === "ConditionSequence" || kind === "Composite") run(property(node, "Activities")?.children ?? []);
        else if (kind === "ConditionBranch") {
          // The first branch whose condition holds runs; the designer's "else" is a later [True] branch.
          if (!taken && read(argument(node, "Condition")) === true) {
            taken = true;
            run(property(property(node, "Then"), "Activities")?.children ?? []);
          }
        } else unsupported(`activity ${kind}`);
      } else unsupported(`element ${name}`);
    }
  };
  run(descendants(root, "mxswa:Workflow")[0]?.children ?? unsupported("XAML without a workflow"));
  return effects;
}

/** Rule metadata from `<name>-<id>.xaml.data.xml`: identity, activation and trigger scope. */
export function businessRuleMetadata(dataXml) {
  const node = parseSolutionXml(dataXml);
  if (childText(node, "Category") !== "2") return null;
  const scope = childText(node, "ProcessTriggerScope");
  const formId = canonical(childText(node, "ProcessTriggerFormId"));
  return {
    id: canonical(node.attrs.WorkflowId),
    name: node.attrs.Name ?? null,
    entity: childText(node, "PrimaryEntity") ?? null,
    active: childText(node, "StateCode") === "1",
    // ProcessTriggerScope 2 = Entity; 1 = forms (all forms, or the one named by ProcessTriggerFormId).
    scope: scope === "2" ? "entity" : formId ? "form" : "all-forms",
    formId: formId || null,
  };
}

/** Active rules that apply to a table's form (`formId` null for server-side evaluation). */
export function applicableBusinessRules(rules, { entity, formId = null }) {
  return rules.filter((rule) => rule.active && rule.entity === entity &&
    (rule.scope === "entity" || (formId && (rule.scope === "all-forms" || rule.formId === canonical(formId)))));
}
