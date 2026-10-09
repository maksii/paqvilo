// `paqvilo status`: how far the local web files and the environment have drifted apart.
import { OverlaySession } from '../session.mjs';
import { compareWebFile, mapLimit } from '../online.mjs';

/**
 * Compares every overridden web file with the copy the environment serves (anonymously).
 * @param {(row: {url: string, local: string, state: string}) => void} [onRow] called as each result comes in
 */
export function compareWebFiles(session, onRow) {
  const files = [...session.model.webFileByUrl.values()].filter((w) => session.resolver.resolve(w.url)?.file === w.file);
  return mapLimit(files, 6, async (w) => {
    let result;
    try { result = await compareWebFile(session.cfg.origin, w); }
    catch (err) { result = { state: 'comparison failed', detail: err.message }; }
    const row = { url: w.url, local: session.rel(w.file), ...result };
    onRow?.(row);
    return row;
  });
}

/** Differences and new local assets are valid results; unreadable/unreachable assets are incomplete. */
export function comparisonExitCode(results) {
  return results.some((row) => !['same', 'different', 'not online (local only)'].includes(row.state)) ? 1 : 0;
}

export default async function status(cfg, args) {
  const session = await OverlaySession.create(cfg);
  const results = await compareWebFiles(session);
  const exitCode = comparisonExitCode(results);

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return exitCode;
  }
  const groups = Map.groupBy(results, (r) => r.state);
  console.log(`${cfg.siteName} @ ${cfg.envName}  ${cfg.origin}\n`);
  if (!results.length) console.log('No mapped web files are currently overridden in this scope.');
  for (const [state, rows] of groups) {
    if (state === 'same') continue;
    console.log(`${state.toUpperCase()} (${rows.length})`);
    for (const r of rows) console.log(`  ${r.url}  <-  ${r.local}${r.detail ? `   (${r.detail})` : ''}`);
    console.log('');
  }
  console.log([...groups].map(([state, rows]) => `${rows.length} ${state}`).join(', '));
  if (groups.has('different')) {
    console.log(`\n"different" means the browser shows your local version where the environment has another one.`);
    console.log(`If you did not change those files, your branch and the environment are out of step:`);
    console.log(`use --scope changed (only your changes override) or download the site again.`);
  }
  if (exitCode) console.log('\nComparison incomplete: some resources could not be read or returned no comparable online content.');
  return exitCode;
}
