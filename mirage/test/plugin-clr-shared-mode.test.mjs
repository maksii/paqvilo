// @test-kind contract: Paqvilo admin operation modes keep a CLR runtime's shared host while another step still uses it
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLR_SKIP } from './fixtures/clr-sdk.mjs';
import { disableSteps, originalStepSimulator, pluginFixture, pluginId } from './plugin-fixture.mjs';

test(
  'switching one step off CLR keeps the host the other step of its assembly still uses',
  { skip: CLR_SKIP },
  async (t) => {
    const fixture = await pluginFixture(t),
      initial = fixture.app.store.snapshot();
    await fixture.app.close();
    await disableSteps(fixture.solution, 4, 7);
    await disableSteps(fixture.solution, 9, 11);
    const app = await originalStepSimulator(t, fixture, initial, {
      source:
        'using System;using Microsoft.Xrm.Sdk;namespace Invented.WidgetRules {public sealed class Validate:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));((Entity)c.InputParameters["Target"])["fx_note"]="clr ran";}}}',
      evidence: 'Invented shared CLR runtime',
      steps: [3, 8],
    });
    const admin = (number, body) =>
      fetch(app.url + '/__sim/api/operations/' + encodeURIComponent('plugin-step:' + pluginId(number)), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
        body: JSON.stringify(body),
      });
    const create = async (title) => {
      const response = await fetch(app.url + '/_api/fx_widgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
        body: JSON.stringify({ fx_title: title }),
      });
      assert.equal(response.status, 204, await response.text());
    };
    const count = (code) => app.state().diagnostics.filter((n) => n.code === code).length;
    assert.equal((await admin(3, { mode: 'clr' })).status, 200);
    assert.equal((await admin(8, { mode: 'clr' })).status, 200);
    await create('first');
    assert.equal(count('PLUGIN_CLR_HOST_STARTED'), 1);
    const disabled = await admin(8, { mode: 'disabled' });
    assert.equal(disabled.status, 200, await disabled.text());
    assert.equal(count('PLUGIN_CLR_HOST_STOPPED'), 0, 'step 3 still uses the shared host');
    await create('second');
    assert.equal(count('PLUGIN_CLR_HOST_STARTED'), 1, 'step 3 reuses the shared host');
    assert.ok(app.store.snapshot().tables.fx_widget.every((row) => row.fx_note === 'clr ran'));
  },
);
