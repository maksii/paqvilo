// Standalone volume gate; the same check ships as paqvilo mirage verify-storage.
import { verifyStateStorage } from '../lib/state-storage-check.mjs';
console.log(JSON.stringify(await verifyStateStorage()));
