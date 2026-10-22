// The shared storage contract against the core Azurite transport, served by the loopback fake with real Shared Key checks.
import test from 'node:test';
import { runStorageContract } from '../testing/storage-contract.mjs';
import { startAzuriteFake } from '../testing/azurite-fake.mjs';
import { createAzuriteStorage } from '../lib/storage-azurite.mjs';

const fake = await startAzuriteFake();
test.after(() => fake.close());
let containers = 0;

runStorageContract(test, async () => createAzuriteStorage({ id: 'fxblob',
  settings: { connectionString: 'env:FX_AZURITE', container: `fx-contract-${++containers}` }, env: { FX_AZURITE: fake.connectionString() } }),
{ label: 'azurite storage contract' });
