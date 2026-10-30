// Cascade Assign writes the child's ownership columns through the direct Assign pipeline (dataverse-cascade.mjs
// ownershipOptions -> principals.systemColumns): Assign gives the related rows the referenced row's new owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION } from '../lib/dataverse-cascade.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { cascadeMappings } from './support/parent-child-tables.mjs';

const PARENT = '55555555-5555-4555-8555-555555555511',
  CHILD = '55555555-5555-4555-8555-555555555512';
const ONE = '66666666-6666-4666-8666-666666666611',
  TWO = '66666666-6666-4666-8666-666666666612';
const TEAM = '66666666-6666-4666-8666-666666666613';
const owner = (id) => ({ id, logical_name: 'systemuser', name: 'Invented' });

async function setup(t) {
  const fixture = await contractModuleFixture(t, {
    extension: EXTENSION,
    mappings: cascadeMappings({ assign: 'Cascade' }),
    tables: {
      x_parent: [{ x_parentid: PARENT, x_name: 'Invented parent', ownerid: owner(ONE) }],
      x_child: [
        {
          x_childid: CHILD,
          x_name: 'Invented child',
          x_parentid: { id: PARENT, logical_name: 'x_parent' },
          ownerid: owner(ONE),
        },
      ],
    },
  });
  const { store } = fixture;
  const bu = store.state.tables.businessunit[0].businessunitid;
  const unit = { id: bu, logical_name: 'businessunit' };
  store.state.tables.systemuser.push(
    { systemuserid: ONE, fullname: 'Invented one', businessunitid: unit },
    { systemuserid: TWO, fullname: 'Invented two', businessunitid: unit },
  );
  store.state.tables.team.push({ teamid: TEAM, name: 'Invented team', teamtype: 0, businessunitid: unit });
  const child = () => store.state.tables.x_child.find((row) => row.x_childid === CHILD);
  return { ...fixture, bu, child };
}

test("a cascaded Assign to a user sets the child's ownerid, owninguser and owningbusinessunit as a direct Assign does", async (t) => {
  const { request, json, bu, child } = await setup(t);
  await json(await request('PATCH', `/x_parents(${PARENT})`, { 'ownerid@odata.bind': `/systemusers(${TWO})` }), 200);
  assert.equal(child().ownerid.id, TWO);
  assert.equal(child().owninguser?.id, TWO);
  assert.equal(child().owningteam ?? null, null);
  assert.equal(child().owningbusinessunit?.id, bu);
});

test("a cascaded Assign to a team sets the child's owningteam and clears owninguser", async (t) => {
  const { request, json, bu, child } = await setup(t);
  await json(await request('PATCH', `/x_parents(${PARENT})`, { 'ownerid@odata.bind': `/teams(${TEAM})` }), 200);
  assert.equal(child().ownerid.id, TEAM);
  assert.equal(child().owningteam?.id, TEAM);
  assert.equal(child().owninguser ?? null, null);
  assert.equal(child().owningbusinessunit?.id, bu);
});

// The synchronous drive: a plug-in's own SDK call (local-organization-service.mjs, sync: true) that assigns the
// parent to a team cascades on the same synchronous call: the child carries the team ownership when the call returns.
test("a cascaded Assign to a team through a synchronous SDK call sets the child's ownership before the call returns", async (t) => {
  const { store, bu, child } = await setup(t);
  const { localOrganizationService } = await import('../lib/local-organization-service.mjs');
  // The plug-in runs as the fixture's application user (System Administrator), as the Web API cases do.
  const app = store.tableRows('systemuser').find((row) => row.applicationid);
  const sdk = localOrganizationService(store, {
    userId: app.systemuserid,
    evidence: 'invented plug-in grants',
    grants: [
      { entity: 'x_parent', operations: ['read', 'update'] },
      { entity: 'x_child', operations: ['read', 'update'] },
      { entity: 'team', operations: ['read'] },
    ],
  });
  assert.equal(sdk.profile.pipeline.level, 'behaviour', 'the SDK service runs on the organization record pipeline');
  const answer = sdk.update('x_parent', PARENT, { ownerid: { id: TEAM, logical_name: 'team' } });
  assert.equal(typeof answer?.then, 'undefined', 'the SDK update is synchronous');
  assert.equal(child().ownerid.id, TEAM);
  assert.equal(child().owningteam?.id, TEAM);
  assert.equal(child().owninguser ?? null, null);
  assert.equal(child().owningbusinessunit?.id, bu);
});
