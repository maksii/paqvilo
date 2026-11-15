// @test-kind parity: replays recorded oracle cases from mirage/test/parity/cases; every expected value is read from a case file built from two or more captures
import { replayParityDirectory } from '../testing/parity-cases.mjs';

await replayParityDirectory({
  cases: new URL('./parity/cases/', import.meta.url),
  adapters: new URL('./parity/adapters/', import.meta.url),
  knownGaps: new URL('./parity/known-gaps/', import.meta.url),
});
