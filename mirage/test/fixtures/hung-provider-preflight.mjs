import { preflightProvider } from '../../lib/storage-provider.mjs';

const result = await preflightProvider({ preflight: () => new Promise(() => {}) }, { timeoutMs: 20 });
process.stdout.write(JSON.stringify(result));
