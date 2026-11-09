// Narrow source-context review for the original keyed HEAD/OPTIONS router test.
// The caller must provide ASTs parsed from actual repository sources; a normalized
// current AST is acceptable only after the caller has independently recognized
// and removed qualifier-generated guards/imports. Never accept manifest ASTs.
import { createHash } from 'node:crypto';

const BASELINE_ID = 'mirage/test/dataverse-api.test.mjs:615:2';
const BASE_AST = 'b26deeddf3dd980e9ac11007fa9228b0ce3693a110d1b34a9bc52c696ab67649';
const CURRENT_AST = '451960fe4493bac0b3debaee0bdc6a755d1f96b0da718ee31f8b2a3f86f1f578';
const TARGET_AST = '3d39e94ee2e5cdcd8682557c9d2216f835efd4c4dfa1963ab3c4e4ac354009a8';
const EARLIER_AST = '061036792d817561107eab9caa15b44a7b4ab483d1ecba3e3f0d53aa5e38b646';
const BEFORE_AST = {
  baseline: 'da0013cd6c490250ebebcc817591276a12e9847cfd7fbd9fa947c05605561fed',
  current: 'b2c820b88565b355ea6e43891c63a94690a31776f135a6e1a521cfe3db894791',
};
const AFTER_AST = {
  baseline: '8ba297c856c7e4e48dac6362a4f7806fada8d6ae785b32b4e48124629410d2fc',
  current: 'ae3b5d4a9ad5dc5904efdac5668d12b9b41e045cb78127bbabe9de3905f98bfa',
};
const TITLE = "lists the keyed record's verbs in Allow on a HEAD or OPTIONS 405";
const TARGET = 'widgets(aaaaaaaa-0000-0000-0000-000000000001)';
const ROW = 'aaaaaaaa-0000-0000-0000-000000000001';
const normalize = (x) =>
  typeof x === 'bigint'
    ? { $bigint: String(x) }
    : Array.isArray(x)
      ? x.map(normalize)
      : !x || typeof x !== 'object'
        ? x
        : Object.fromEntries(
            Object.entries(x)
              .filter(([k]) => !['loc', 'range', 'start', 'end', 'raw'].includes(k))
              .map(([k, v]) => [k, normalize(v)]),
          );
export const apiRouterSliceAstHash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
const fail = () => {
  throw Object.assign(new Error('api-router-slice-unproven'), { qualificationCode: 'api-router-slice-unproven' });
};
const check = (x) => {
  if (!x) fail();
};
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'range', 'start', 'end'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((x) => walk(x, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
const property = (node, name) =>
  node?.type === 'ObjectExpression' ? node.properties.find((p) => !p.computed && p.key?.name === name) : undefined;
const stringValue = (node) => (node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null);

function inspect(ast, stage) {
  check(ast?.type === 'Program' && apiRouterSliceAstHash(ast) === (stage === 'baseline' ? BASE_AST : CURRENT_AST));
  const describes = ast.body.filter(
    (n) =>
      n.type === 'ExpressionStatement' &&
      n.expression?.type === 'CallExpression' &&
      n.expression.callee?.name === 'describe',
  );
  check(describes.length > 0);
  const call = describes[0].expression;
  check(
    call.arguments.length === 2 &&
      call.arguments[1].type === 'ArrowFunctionExpression' &&
      !call.arguments[1].async &&
      call.arguments[1].body.type === 'BlockStatement',
  );
  const body = call.arguments[1].body.body,
    tests = body.filter((n) => n.type === 'ExpressionStatement' && n.expression?.callee?.name === 'it');
  const targetIndex = body.findIndex(
    (n) =>
      n.type === 'ExpressionStatement' &&
      n.expression?.callee?.name === 'it' &&
      n.expression.arguments[0]?.value === TITLE,
  );
  check(targetIndex >= 0);
  const target = body[targetIndex].expression;
  check(
    target.arguments.length === 2 &&
      target.arguments[1].type === 'ArrowFunctionExpression' &&
      target.arguments[1].async &&
      apiRouterSliceAstHash(target.arguments[1]) === TARGET_AST,
  );
  const earlier = body
    .slice(0, targetIndex)
    .filter((n) => n.type === 'ExpressionStatement' && n.expression?.callee?.name === 'it');
  check(earlier.length === 34 && apiRouterSliceAstHash(earlier) === EARLIER_AST && tests.includes(body[targetIndex]));
  const before = body.find((n) => n.type === 'ExpressionStatement' && n.expression?.callee?.name === 'before'),
    after = body.find((n) => n.type === 'ExpressionStatement' && n.expression?.callee?.name === 'after');
  check(
    before &&
      after &&
      apiRouterSliceAstHash(before) === BEFORE_AST[stage] &&
      apiRouterSliceAstHash(after) === AFTER_AST[stage],
  );
  const beforeCallback = before.expression.arguments[0];
  check(
    before.expression.arguments.length === 1 &&
      beforeCallback?.type === 'ArrowFunctionExpression' &&
      beforeCallback.async,
  );
  let rowFound = false,
    roleFound = false,
    hostFound = false;
  walk(beforeCallback, (n) => {
    if (n.type === 'ObjectExpression' && stringValue(property(n, 'widgetid')?.value) === ROW) rowFound = true;
    const roles = property(n, 'roles')?.value;
    if (roles?.type === 'ArrayExpression' && roles.elements.some((x) => stringValue(x) === 'System Administrator'))
      roleFound = true;
    if (n.type === 'CallExpression' && n.callee?.name === 'startDataverseApi') {
      const host = property(n.arguments[0], 'host');
      if (stage === 'current' && stringValue(host?.value) === '127.0.0.1') hostFound = true;
      if (stage === 'baseline' && !host) hostFound = true;
    }
  });
  check(rowFound && roleFound && hostFound);
  const statements = target.arguments[1].body.body;
  check(statements.length === 7);
  const pathInit = statements[0]?.declarations?.[0]?.init;
  check(
    pathInit?.type === 'TemplateLiteral' &&
      pathInit.expressions.length === 2 &&
      pathInit.expressions[0].name === 'origin' &&
      pathInit.expressions[1]?.callee?.name === 'apiPath' &&
      stringValue(pathInit.expressions[1].arguments[0]) === TARGET,
  );
  for (const [i, method] of [
    [1, 'HEAD'],
    [4, 'OPTIONS'],
  ]) {
    const init = statements[i]?.declarations?.[0]?.init,
      fetch = init?.argument,
      options = fetch?.arguments?.[1];
    check(
      init?.type === 'AwaitExpression' &&
        fetch?.callee?.name === 'fetch' &&
        fetch.arguments[0]?.name === 'path' &&
        stringValue(property(options, 'method')?.value) === method &&
        property(options, 'headers')?.value?.callee?.name === 'auth',
    );
  }
  let directSharedWrite = false;
  for (const sibling of earlier)
    walk(sibling, (n) => {
      if (
        (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') &&
        ['origin', 'token', 'api', 'tenantId', 'organizationId', 'appUserId'].includes((n.left ?? n.argument)?.name)
      )
        directSharedWrite = true;
    });
  check(!directSharedWrite);
  return {
    programAstSha256: apiRouterSliceAstHash(ast),
    selectedCallbackAstSha256: TARGET_AST,
    earlierSiblingAstSha256: EARLIER_AST,
    earlierSiblingCount: earlier.length,
    beforeAstSha256: BEFORE_AST[stage],
    afterAstSha256: AFTER_AST[stage],
  };
}

// This exact snapshot whitelist is intentionally not a generic harness review.
// The 34 prior sibling registrations are serial and individually source-bound.
// Their reviewed effects include team/team-role rows, grants/revocations, and an
// audit flag restored in finally. They do not directly reassign the selected
// origin/token/API bindings; the fixture's record stub only records calls and
// returns responses. This is not a claim that arbitrary SUT handlers are pure.
export function reviewApiRouterSlice({ baselineAst, currentAst, baselineId }) {
  check(baselineId === BASELINE_ID);
  const baseline = inspect(baselineAst, 'baseline'),
    current = inspect(currentAst, 'current');
  return {
    baselineId: BASELINE_ID,
    baseline,
    current,
    context:
      'Exact serial first-suite fixture and 34 source-bound earlier sibling registrations; authenticated synthetic admin application, explicit current loopback listener, owned keyed widget, HEAD/OPTIONS and original Allow assertions.',
    limitations: [
      'Known sibling team/share/audit effects are retained, not treated as absent.',
      'SUT implementation side effects are not assumed pure.',
      'Native principal and source-role proof remains a separate semantic review.',
    ],
  };
}

export const apiRouterSliceSourceSnapshots = Object.freeze({
  baselineSha256: '5c31e4a128762d525d81678a31672e31e6c370d5160112381c1e5cb63b378d31',
  currentSha256: '6b4c1ea2ae46c23969cfc08ea2a3854bfc214377fbd3e31b13576013fa73c9d4',
  baselineAstSha256: BASE_AST,
  currentAstSha256: CURRENT_AST,
});
