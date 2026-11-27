// English suffix stripping for portal search in Dataverse search mode (portal-search-query.mjs). The algorithm is the
// Porter stemmer (M. F. Porter, "An algorithm for suffix stripping", Program 14(3), 1980), followed by one fold: a stem
// ending in "-ogu" (the British "-ogue" spelling) loses its final "u", so "catalogue" and "catalog" share a stem.
// Hosted Dataverse search runs its own language analysis. Hosted session F3 (summary-F3.md PAGE-04f) captured these
// equivalences, which this stemmer reproduces: lantern = lanterns, run = running, catalog = catalogue, and runner is not
// run. Other words are stemmed by the same rules; their hosted equivalence is not captured.

const MAX_CACHE = 10_000;
const cache = new Map();

function consonant(word, index) {
  const char = word[index];
  if ('aeiou'.includes(char)) return false;
  if (char === 'y') return index === 0 || !consonant(word, index - 1);
  return true;
}

/** Porter's m: the number of vowel-consonant sequences in `stem`. */
function measure(stem) {
  let count = 0;
  let index = 0;
  while (index < stem.length && consonant(stem, index)) index++;
  while (index < stem.length) {
    while (index < stem.length && !consonant(stem, index)) index++;
    if (index >= stem.length) break;
    while (index < stem.length && consonant(stem, index)) index++;
    count++;
  }
  return count;
}

const hasVowel = (stem) => [...stem].some((_, index) => !consonant(stem, index));
const doubleConsonant = (word) => word.length > 1 && word.at(-1) === word.at(-2) && consonant(word, word.length - 1);
// Consonant-vowel-consonant at the end, the last consonant not w, x or y.
const cvc = (word) => {
  const n = word.length;
  return (
    n > 2 && consonant(word, n - 3) && !consonant(word, n - 2) && consonant(word, n - 1) && !'wxy'.includes(word[n - 1])
  );
};

/** Replace the longest listed suffix whose stem satisfies `condition`; the first matching suffix decides. */
function replaceSuffix(word, rules, condition) {
  for (const [suffix, replacement] of rules) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    return condition(stem, suffix) ? stem + replacement : word;
  }
  return word;
}

const byLength = (rules) => rules.toSorted(([a], [b]) => b.length - a.length);
const STEP2 = byLength([
  ['ational', 'ate'],
  ['tional', 'tion'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['izer', 'ize'],
  ['abli', 'able'],
  ['alli', 'al'],
  ['entli', 'ent'],
  ['eli', 'e'],
  ['ousli', 'ous'],
  ['ization', 'ize'],
  ['ation', 'ate'],
  ['ator', 'ate'],
  ['alism', 'al'],
  ['iveness', 'ive'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['aliti', 'al'],
  ['iviti', 'ive'],
  ['biliti', 'ble'],
]);
const STEP3 = byLength([
  ['icate', 'ic'],
  ['ative', ''],
  ['alize', 'al'],
  ['iciti', 'ic'],
  ['ical', 'ic'],
  ['ful', ''],
  ['ness', ''],
]);
const STEP4 = byLength(
  [
    'al',
    'ance',
    'ence',
    'er',
    'ic',
    'able',
    'ible',
    'ant',
    'ement',
    'ment',
    'ent',
    'ion',
    'ou',
    'ism',
    'ate',
    'iti',
    'ous',
    'ive',
    'ize',
  ].map((suffix) => [suffix, '']),
);

// Step 1a: plurals.
function step1a(word) {
  if (word.endsWith('sses') || word.endsWith('ies')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// Step 1b: -eed, -ed and -ing, then the stem's repair (-ate, -ble, -ize; a double consonant; a short cvc stem).
function step1b(word) {
  if (word.endsWith('eed')) return measure(word.slice(0, -3)) > 0 ? word.slice(0, -1) : word;
  const ending = ['ed', 'ing'].find((suffix) => word.endsWith(suffix) && hasVowel(word.slice(0, -suffix.length)));
  if (!ending) return word;
  const stem = word.slice(0, -ending.length);
  if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) return stem + 'e';
  if (doubleConsonant(stem) && !'lsz'.includes(stem.at(-1))) return stem.slice(0, -1);
  if (measure(stem) === 1 && cvc(stem)) return stem + 'e';
  return stem;
}

function step1(word) {
  const stem = step1b(step1a(word));
  // Step 1c: a final y becomes i when the stem before it has a vowel.
  return stem.endsWith('y') && hasVowel(stem.slice(0, -1)) ? stem.slice(0, -1) + 'i' : stem;
}

function step5(word) {
  if (word.endsWith('e')) {
    const stem = word.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !cvc(stem))) word = stem;
  }
  if (measure(word) > 1 && word.endsWith('ll')) word = word.slice(0, -1);
  return word;
}

function porter(word) {
  if (word.length <= 2) return word;
  word = step1(word);
  word = replaceSuffix(word, STEP2, (stem) => measure(stem) > 0);
  word = replaceSuffix(word, STEP3, (stem) => measure(stem) > 0);
  word = replaceSuffix(word, STEP4, (stem, suffix) => measure(stem) > 1 && (suffix !== 'ion' || /[st]$/.test(stem)));
  word = step5(word);
  return word.endsWith('ogu') ? word.slice(0, -1) : word;
}

/** The search stem of one lower-case indexed token; a token with characters outside a-z is its own stem. */
export function searchStem(token) {
  if (!/^[a-z]+$/.test(token)) return token;
  let stem = cache.get(token);
  if (stem === undefined) {
    stem = porter(token);
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(token, stem);
  }
  return stem;
}
