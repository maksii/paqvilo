// @test-kind contract: Paqvilo configuration design: a refused simulation setting names the offending key (mirage/docs/simulation-levels.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulationSettings } from '../lib/simulation-settings.mjs';

test('a refused simulation setting names the offending key', () => {
  const prefix = 'mirage.simulation requires level: dry-run, simulation, deep. ';
  for (const [value, detail] of [
    [{ level: 'dry-run', persist: true }, 'Unknown key mirage.simulation.persist: only level is accepted.'],
    [{ level: 'bogus' }, 'mirage.simulation.level is "bogus".'],
    [{}, 'mirage.simulation.level is missing.'],
    ['deep', 'mirage.simulation must be an object such as { level: dry-run }.'],
  ])
    assert.throws(() => simulationSettings(value, 'mirage.simulation'), { message: prefix + detail });
  assert.deepEqual(simulationSettings({ level: 'deep' }), { level: 'deep' });
});
