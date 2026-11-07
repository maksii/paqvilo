// @test-kind contract: Paqvilo bypass ownership: only evidence-backed observed settings protect steps; unknown ownership is diagnosed without exposing evidence
import test from 'node:test';
import assert from 'node:assert/strict';
import { observedConfig } from '../lib/project-config.mjs';
import { parsePluginDocument, importSolutionPlugins } from '../lib/exported-plugins.mjs';
import { pluginBypassOwnership, pluginStepBypassed } from '../lib/plugin-bypass.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { composeOrganizationHost } from '../lib/organization-host.mjs';

const id = '30000000-0000-0000-0000-000000000001';
const source = () => [
  {
    documents: [
      {
        file: '/invented/step.xml',
        facts: {
          plugins: parsePluginDocument(
            `<SdkMessageProcessingStep SdkMessageProcessingStepId="${id}" Name="Microsoft-looking local name" SdkMessageName="Create" PrimaryEntity="x_item" Stage="20" Rank="1" Mode="0" SupportedDeployment="0" CustomizationLevel="0"/>`,
          ),
        },
      },
    ],
  },
];
test('source customization metadata is retained but only evidenced ownership controls protected bypass', () => {
  const unknown = importSolutionPlugins(source()).steps[0];
  assert.equal(unknown.customizationLevel, 0);
  assert.equal(pluginBypassOwnership(unknown).kind, 'unknown');
  const diagnostics = [];
  assert.equal(
    pluginStepBypassed(unknown, { bypassCustomPlugins: true }, (entry) => diagnostics.push(entry)),
    true,
  );
  assert.equal(diagnostics[0].code, 'PLUGIN_BYPASS_OWNERSHIP_UNKNOWN');
  const observed = observedConfig({
    evidence: 'Invented ownership capture',
    businessLogicOwnership: { [id]: { kind: 'microsoft', evidence: 'Invented exact publisher ownership evidence' } },
  });
  const protectedStep = importSolutionPlugins(source(), { businessLogicOwnership: observed.businessLogicOwnership })
    .steps[0];
  assert.equal(pluginBypassOwnership(protectedStep).kind, 'microsoft');
  assert.equal(pluginStepBypassed(protectedStep, { bypassCustomPlugins: true, bypassStepIds: [id] }), false);
  assert.throws(
    () => observedConfig({ evidence: 'Invented', businessLogicOwnership: { [id]: { kind: 'microsoft' } } }),
    /evidence/,
  );
});

test('the existing host capability inventory exposes unqualified ownership without leaking evidence values', async (t) => {
  const store = await new DataStore({ state: emptyState() }).init();
  const plugins = importSolutionPlugins(source());
  const host = await composeOrganizationHost({
    store,
    sources: { plugins: () => plugins, workflows: () => [], layers: () => [] },
  });
  t.after(() => host.close());
  const record = host
    .capabilities()
    .list()
    .find((item) => item.name === 'source-plugin-bypass-ownership');
  assert.equal(record.level, 'contract');
  assert.equal(record.seams.diagnostic, 'PLUGIN_BYPASS_OWNERSHIP_UNKNOWN');
  assert.equal(record.seams.steps[0].kind, 'unknown');
  assert.equal(record.seams.steps[0].customizationLevel, 0);
});
