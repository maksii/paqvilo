import test from 'node:test';
import assert from 'node:assert/strict';
import {runAcceptance} from '../acceptance.mjs';

test('acceptance rejects unbounded action timeouts and invalid explicit reserves before launching a browser',async()=>{
  for(const timeout of [0,-1,NaN,Infinity,'15000'])await assert.rejects(runAcceptance({timeout}),/timeout must be a positive finite number/);
  for(const navigationCommitReserveMs of [-1,NaN,Infinity,15000,'3000',null])await assert.rejects(runAcceptance({navigationCommitReserveMs}),/navigationCommitReserveMs must be nonnegative and smaller than timeout/);
});
