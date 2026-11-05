import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { closeClrHostPool } from '../../lib/plugin-clr.mjs';
import { ownedFixture } from '../../testing/owned-fixture.mjs';

export function pooledClrLifecycle(t, root, getRuntime) {
  let lifecycleFailure = false;
  const owner = ownedFixture(t);
  owner.add(async () => {
    const runtime = getRuntime();
    if (runtime) {
      let result;
      try {
        result = closeClrHostPool({ runtime });
      } catch (error) {
        lifecycleFailure = true;
        throw error;
      }
      if (result.allAbsenceVerified !== true) lifecycleFailure = true;
      assert.equal(result.allAbsenceVerified, true, 'parent fallback verified runtime host absence');
    }
    assert.equal(lifecycleFailure, false, 'child lifecycle verification succeeded');
  });
  owner.remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));

  return {
    child(label) {
      const hostEvents = { started: 0, stopped: 0, allAbsenceVerified: true };
      const diagnostic = (event) => {
        if (event.code === 'PLUGIN_CLR_HOST_STARTED') hostEvents.started++;
        if (event.code === 'PLUGIN_CLR_HOST_STOPPED') {
          hostEvents.stopped++;
          if (event.absenceVerified !== true) {
            hostEvents.allAbsenceVerified = false;
            lifecycleFailure = true;
          }
        }
      };
      const verifyClose = async (backend) => {
        let closeError;
        try {
          await backend.close();
        } catch (error) {
          lifecycleFailure = true;
          closeError = error;
        }
        if (
          hostEvents.started === 0 ||
          hostEvents.stopped === 0 ||
          hostEvents.started !== hostEvents.stopped ||
          !hostEvents.allAbsenceVerified
        )
          lifecycleFailure = true;
        if (closeError) throw closeError;
        assert.ok(hostEvents.started > 0, `${label} reports a started CLR host`);
        assert.ok(hostEvents.stopped > 0, `${label} reports a stopped CLR host`);
        assert.equal(hostEvents.started, hostEvents.stopped);
        assert.equal(hostEvents.allAbsenceVerified, true);
      };
      return { diagnostic, verifyClose };
    },
  };
}
