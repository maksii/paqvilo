// @test-kind contract: forms:audit lists the solution memberships forms:apply adds, and only apply writes them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { membershipStep } from '../forms/deploy.mjs';

const solutions = [{ solutionid: '0f000000-0000-4000-8000-000000000001', uniquename: 'FictionalForms' }];
const fakeClient = (members) => {
  const writes = [];
  return {
    writes,
    list: async (route) => (members.some((id) => route.includes(`objectid eq ${id}`)) ? [{ objectid: 'x' }] : []),
    request: async (route, options) => writes.push({ route, body: options.body }),
  };
};

test('audit and apply list the same missing memberships; only apply adds them', async () => {
  const member = 'fa000000-0000-4000-8000-000000000001',
    missing = 'fa000000-0000-4000-8000-000000000002';
  const run = async (apply) => {
    const client = fakeClient([member]),
      additions = [];
    const include = membershipStep(client, solutions, { apply, additions });
    await include(member, 60, 'FictionalForms');
    await include(missing, 26, 'FictionalForms');
    return { additions, writes: client.writes };
  };
  const audit = await run(false),
    applied = await run(true);
  assert.deepEqual(audit.additions, [{ id: missing, componentType: 26, solution: 'FictionalForms' }]);
  assert.deepEqual(applied.additions, audit.additions);
  assert.deepEqual(audit.writes, [], 'the audit writes nothing');
  assert.deepEqual(
    applied.writes.map((w) => [w.route, w.body.ComponentId]),
    [['AddSolutionComponent', missing]],
  );
  await assert.rejects(
    membershipStep(fakeClient([]), solutions, { apply: false, additions: [] })(missing, 26, 'Other'),
    {
      message: 'Missing form solution Other',
    },
  );
});
