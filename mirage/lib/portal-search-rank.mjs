// The local relevance model of portal global search (portal-search-query.mjs scores with it). It is built from the factors
// Learn documents for Power Pages global search (power-pages/configure/search/overview, "Global search"): "the better the
// match, the higher it appears", ranked by the number of words matched and their proximity to each other, and "the
// smaller the amount of text where the search words are found, the higher the relevancy"; a term boost `^` (default 1,
// may be below 1) makes a term more relevant; Search/Query "adds other weights" to the default search page. It follows the
// Lucene practical scoring shape those factors come from (Lucene 2.9 query parser and similarity, which the legacy Lucene
// .NET search used): a term in a column scores sqrt(frequency) / sqrt(column length), a sloppy phrase match counts
// 1 / (1 + extra positions), and wildcard and prefix terms ignore term frequency (Learn azure/search/search-lucene-query-
// architecture, "Scoring", the Azure AI Search rule; Learn does not say which engine Dataverse search scores with). Not
// modelled: inverse document
// frequency and every hosted index statistic, the hosted analyser and field configuration, synonyms and natural
// language interpretation. Its scores are local: no hosted score or exact order is claimed (PORTAL_SEARCH_RANKING_LOCAL).

/** An exact token match counts fully; a fuzzy expansion (`term~`) counts at this fraction of it. */
const FUZZY_MATCH_WEIGHT = 0.5;
/** The bonus for two adjacent matched query words in one column; it falls with the words' distance. */
const PROXIMITY_WEIGHT = 0.5;

/** Score of `frequency` matches in a column of `length` tokens: more matches score higher, longer text lower. */
const termFrequencyScore = (frequency, length) =>
  frequency > 0 && length > 0 ? Math.sqrt(frequency) / Math.sqrt(length) : 0;

/**
 * A plain or fuzzy query word in one row: its best column (the column where the word weighs most). Each column counts
 * exact matches fully and fuzzy expansions at FUZZY_MATCH_WEIGHT. null when no token matches.
 */
export function wordScore(row, word, match) {
  const matching = new Set(row.tokens.filter(match));
  if (!matching.size) return null;
  let best = 0;
  for (const column of row.columns) {
    let exact = 0;
    let fuzzy = 0;
    for (const token of column) {
      if (token === word) exact++;
      else if (matching.has(token)) fuzzy++;
    }
    best = Math.max(best, termFrequencyScore(exact + FUZZY_MATCH_WEIGHT * fuzzy, column.length));
  }
  return best;
}

/**
 * A wildcard or prefix word in one row: term frequency is ignored, so its best column scores as one match. null when no
 * token matches.
 */
export function partialWordScore(row, _word, match) {
  let best = null;
  for (const column of row.columns)
    if (column.some(match)) best = Math.max(best ?? 0, termFrequencyScore(1, column.length));
  return best;
}

/**
 * The shortest window of `column` that holds every label of `labelsAt` present in it: { present, window }, or null when
 * fewer than `minimum` labels occur. `labelsAt(token)` lists the labels a token carries.
 */
function smallestWindow(column, labelsAt, minimum = 1) {
  const positions = [];
  const present = new Set();
  column.forEach((token, position) => {
    const labels = labelsAt(token);
    if (!labels.length) return;
    positions.push({ position, labels });
    for (const label of labels) present.add(label);
  });
  if (present.size < minimum) return null;
  const counts = new Map();
  let covered = 0;
  let window = Infinity;
  let start = 0;
  for (const entry of positions) {
    covered += countLabels(counts, entry.labels, 1);
    while (covered === present.size) {
      window = Math.min(window, entry.position - positions[start].position + 1);
      covered += countLabels(counts, positions[start].labels, -1);
      start++;
    }
  }
  return { present: present.size, window };
}

/** Adds `delta` to each label's count; the change in the number of labels counted at least once. */
function countLabels(counts, labels, delta) {
  let change = 0;
  for (const label of labels) {
    const before = counts.get(label) ?? 0;
    counts.set(label, before + delta);
    if (!before) change++;
    else if (before + delta === 0) change--;
  }
  return change;
}

/**
 * A matched phrase in one row: its best column, each phrase word counting once, and a match that needs more position moves
 * (`movesIn(column)`, null where it does not match; the Lucene sloppy phrase distance) counting 1 / (1 + moves).
 */
export function phraseScore(row, words, movesIn) {
  let best = null;
  for (const column of row.columns) {
    const moves = movesIn(column);
    if (moves === null) continue;
    best = Math.max(best ?? 0, words.length * termFrequencyScore(1 / (1 + moves), column.length));
  }
  return best;
}

/**
 * The proximity bonus of a row: in its best column, how close the distinct matched query words are. Two adjacent words
 * score PROXIMITY_WEIGHT, each further word adds as much, and spreading them apart divides it by their distance.
 * `matchers` are the visible (not excluded) word matchers of the query; 0 when fewer than two of them meet in a column.
 */
export function proximityBonus(row, matchers) {
  if (matchers.length < 2) return 0;
  const labels = new Map(
    row.tokens.map((token) => [token, matchers.flatMap((match, index) => (match(token) ? [index] : []))]),
  );
  let bonus = 0;
  for (const column of row.columns) {
    const span = smallestWindow(column, (token) => labels.get(token) ?? [], 2);
    if (!span) continue;
    const closeness = (span.present - 1) / Math.max(span.window - 1, 1);
    bonus = Math.max(bonus, PROXIMITY_WEIGHT * (span.present - 1) * Math.min(closeness, 1));
  }
  return bonus;
}
