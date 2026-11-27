// A code site (Power Pages single-page application) built locally, laid over the live site.
//
// `pac pages upload-code-site` deploys the files of `powerpages.config.json` `compiledPath` as web files, so a file of
// the local build answers its own address in place of the online copy and of the exported `.powerpages-site` web file
// at the same address (Mirage gives the build the same precedence, mirage/server.mjs). Microsoft Learn ("Create and
// deploy a single-page application") says a server-side refresh of any route returns the site's root page and the
// client router renders the route; the root page is the configured landing page, and the portal adds its own client
// context (`Microsoft.Dynamic365.Portal`). The document the portal serves is therefore the deployed landing page plus
// what the platform adds. Hosted sites nest it in a whole portal page (hosted session F5: the Home page copy on the root,
// the place of the page content on an application route), so a large served page is merged on the lines that hold it. The local landing page replaces the deployed one by a line merge: the platform's additions to
// the deployed landing page and the local build's changes to it are applied together where they touch different lines.
// The deployed landing page is the exported web file at its address (pac pages download-code-site).
import path from 'node:path';
import { diffLines } from './line-diff.mjs';
import { samePath } from './command-payload.mjs';
import { readLocalFileSync } from './local-file.mjs';

const SPLIT = /\n/;
const keyOf = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

/**
 * Lays the local landing page over the document the portal served for the deployed one.
 * @param {{deployed: string|null, served: string, local: string}} texts the exported (deployed) landing page, the
 *   served document and the local build's landing page
 * @returns {{html: string, outcome: 'unchanged'|'applied'|'unknown-deployed'|'not-entry'|'conflict', lines?: number[]}}
 *   `html` is the served document when nothing was laid; `lines` names the deployed-page lines (1-based) both sides
 *   changed for a conflict
 */
export function mergeCompiledEntry({ deployed, served, local }) {
  if (deployed == null) return { html: served, outcome: 'unknown-deployed' };
  const merged = mergeLines({ deployed, served, local });
  if (merged.outcome !== 'not-entry') return merged;
  // A portal page around the landing page: merge the served lines from the first to the last deployed line found in
  // order, and keep the lines around them as served.
  const theirs = served.split(SPLIT);
  const window = landingWindow(deployed.split(SPLIT).map(keyOf), theirs.map(keyOf));
  if (!window || (window.start === 0 && window.end === theirs.length)) return merged;
  const inner = mergeLines({ deployed, served: theirs.slice(window.start, window.end).join('\n'), local });
  if (inner.outcome !== 'applied') return { ...inner, html: served };
  const tail = theirs[window.end - 1].endsWith('\r') ? '\r' : '';
  return {
    html: [...theirs.slice(0, window.start), inner.html + tail, ...theirs.slice(window.end)].join('\n'),
    outcome: 'applied',
  };
}

/**
 * The served lines [start, end) that hold the deployed landing page, or null: around the deployed line that the served
 * document repeats least, the nearest earlier and later deployed lines in their order, each within a few page lengths,
 * so that a shell line equal to a landing line (a bare <head>) elsewhere in the portal page does not widen the window.
 */
function landingWindow(baseKeys, theirKeys) {
  const lines = baseKeys.filter((line) => line.trim());
  const counts = lines.map((line) => theirKeys.reduce((sum, key) => sum + (key === line ? 1 : 0), 0));
  let anchor = -1;
  counts.forEach((count, at) => {
    if (count && (anchor < 0 || count < counts[anchor])) anchor = at;
  });
  if (anchor < 0) return null;
  const reach = baseKeys.length * 4 + 16;
  const position = theirKeys.indexOf(lines[anchor]);
  let start = position,
    end = position + 1;
  for (let at = anchor - 1; at >= 0; at--)
    for (let candidate = start - 1; candidate >= Math.max(0, start - reach); candidate--)
      if (theirKeys[candidate] === lines[at]) {
        start = candidate;
        break;
      }
  for (let at = anchor + 1; at < lines.length; at++)
    for (let candidate = end; candidate < Math.min(theirKeys.length, end + reach); candidate++)
      if (theirKeys[candidate] === lines[at]) {
        end = candidate + 1;
        break;
      }
  return { start, end };
}

function mergeLines({ deployed, served, local }) {
  const base = deployed.split(SPLIT);
  const mine = local.split(SPLIT);
  const theirs = served.split(SPLIT);
  const baseKeys = base.map(keyOf);
  const localChanges = diffLines(baseKeys, mine.map(keyOf));
  if (!localChanges.length) return { html: served, outcome: 'unchanged' };
  const platform = diffLines(baseKeys, theirs.map(keyOf));
  // The served document is the deployed landing page when most of its lines are still there: another document (a
  // sign-in page, an error page) shares little with it and is never merged.
  const changedBase = platform.reduce((sum, hunk) => sum + (hunk.aEnd - hunk.aStart), 0);
  const significant = baseKeys.filter((line) => line.trim()).length;
  if (!significant || (base.length - changedBase) * 2 < base.length) return { html: served, outcome: 'not-entry' };
  const conflicts = [];
  for (const hunk of localChanges)
    for (const other of platform) if (overlaps(hunk, other)) conflicts.push(Math.min(hunk.aStart, other.aStart) + 1);
  if (conflicts.length) return { html: served, outcome: 'conflict', lines: [...new Set(conflicts)] };
  // Walk the deployed lines once, taking each change from the side that made it.
  const eol = served.includes('\r\n') ? '\r\n' : '\n';
  const edits = [
    ...localChanges.map((hunk) => ({ ...hunk, lines: mine.slice(hunk.bStart, hunk.bEnd).map(keyOf), side: 0 })),
    ...platform.map((hunk) => ({ ...hunk, lines: theirs.slice(hunk.bStart, hunk.bEnd).map(keyOf), side: 1 })),
  ].sort((a, b) => a.aStart - b.aStart || a.aEnd - b.aEnd || a.side - b.side);
  const out = [];
  let at = 0;
  for (const edit of edits) {
    // A line outside every change is the same on all three sides.
    for (; at < edit.aStart; at++) out.push(baseKeys[at]);
    out.push(...edit.lines);
    at = Math.max(at, edit.aEnd);
  }
  for (; at < base.length; at++) out.push(baseKeys[at]);
  return { html: out.join(eol), outcome: 'applied' };
}

// Two changes touch the same deployed lines, or insert at the same place: their order cannot be decided.
function overlaps(a, b) {
  const aInsert = a.aStart === a.aEnd;
  const bInsert = b.aStart === b.aEnd;
  if (aInsert && bInsert) return a.aStart === b.aStart;
  if (aInsert) return a.aStart > b.aStart && a.aStart < b.aEnd;
  if (bInsert) return b.aStart > a.aStart && b.aStart < a.aEnd;
  return a.aStart < b.aEnd && b.aStart < a.aEnd;
}

const CONFIG = 'powerpages.config.json';
const MAX_CONFIG_BYTES = 64 * 1024;

/**
 * What a source watcher watches for a code-site project: its `powerpages.config.json` and the build folder it names
 * (also before the first build creates it), or nothing for another export. The configuration itself is read by
 * mirage/lib/code-site.mjs readCodeSite; this only names the paths.
 * @param {string} sourceDir the export (a project's .powerpages-site folder, or the project folder)
 * @returns {{configFile: string, compiledDir: string|null}|null}
 */
export function codeSiteWatchPaths(sourceDir) {
  if (!sourceDir) return null;
  const project = path.basename(sourceDir).toLowerCase() === '.powerpages-site' ? path.dirname(sourceDir) : sourceDir;
  const configFile = path.join(project, CONFIG);
  let options;
  try {
    // One descriptor is checked and read (lense/local-file.mjs): the bytes are the regular file that was checked.
    const text = readLocalFileSync(configFile, { root: project, maxBytes: MAX_CONFIG_BYTES, encoding: 'utf8' });
    options = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return error.code === 'ENOENT' ? null : { configFile, compiledDir: null };
  }
  const value = options?.compiledPath;
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || path.win32.isAbsolute(value))
    return { configFile, compiledDir: null };
  const compiledDir = path.resolve(project, value);
  const relative = path.relative(project, compiledDir);
  const inside = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return { configFile, compiledDir: inside ? compiledDir : null };
}

/**
 * What a saved file is to a code site's watch paths (codeSiteWatchPaths): 'config' for its powerpages.config.json,
 * 'build' for a file in its build folder, null for anything else. Windows paths compare without letter case, so a
 * watcher event that spells the configuration differently still rereads it.
 */
export function codeSiteChangeKind(watch, file, { platform = process.platform } = {}) {
  if (!watch) return null;
  if (samePath(file, watch.configFile, { platform })) return 'config';
  if (!watch.compiledDir) return null;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const relative = paths.relative(watch.compiledDir, file);
  const inside =
    relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
  return inside ? 'build' : null;
}
