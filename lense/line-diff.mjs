// Common prefix/suffix trim + bounded Myers diff. Sparse edits remain separate even in large
// templates; unrelated rewrites fall back to one hunk without allocating a quadratic LCS table.
const MAX_TRACE_CELLS = 1_000_000; // at most 4 MB of typed-array trace, independent of file length
const MAX_COMPARISONS = 4_000_000;

/**
 * @param {string[]} a old lines
 * @param {string[]} b new lines
 * @returns {Array<{aStart:number, aEnd:number, bStart:number, bEnd:number}>} half-open ranges
 */
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 && m === 0) return [];
  const fallback = () => [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
  if (n === 0 || m === 0) return fallback();
  const trace = [];
  let comparisons = 0;
  const get = (row, depth, diagonal) => diagonal < -depth || diagonal > depth ? -1 : row[diagonal + depth];
  for (let depth = 0; (depth + 1) * (depth + 1) <= MAX_TRACE_CELLS; depth++) {
    const row = new Int32Array(depth * 2 + 1);
    const previous = trace.at(-1);
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = depth ? get(previous, depth - 1, diagonal + 1) : 0;
      const right = depth ? get(previous, depth - 1, diagonal - 1) : -1;
      let x = diagonal === -depth || (diagonal !== depth && right < down) ? down : right + 1;
      let y = x - diagonal;
      while (x < n && y < m) {
        if (++comparisons > MAX_COMPARISONS) return fallback();
        if (a[start + x] !== b[start + y]) break;
        x++;
        y++;
      }
      row[diagonal + depth] = x;
      if (x >= n && y >= m) {
        // Walk only edit steps back through the compact trace, then group adjacent steps.
        const edits = [];
        for (let d = depth; d > 0; d--) {
          const prev = trace[d - 1];
          const k = x - y;
          const downX = get(prev, d - 1, k + 1);
          const rightX = get(prev, d - 1, k - 1);
          const insert = k === -d || (k !== d && rightX < downX);
          const prevK = insert ? k + 1 : k - 1;
          const prevX = get(prev, d - 1, prevK);
          const prevY = prevX - prevK;
          edits.push({ aStart: start + prevX, aEnd: start + prevX + (insert ? 0 : 1), bStart: start + prevY, bEnd: start + prevY + (insert ? 1 : 0) });
          x = prevX;
          y = prevY;
        }
        const hunks = [];
        for (const edit of edits.reverse()) {
          const last = hunks.at(-1);
          if (last && last.aEnd === edit.aStart && last.bEnd === edit.bStart) {
            last.aEnd = edit.aEnd;
            last.bEnd = edit.bEnd;
          } else hunks.push(edit);
        }
        return hunks;
      }
    }
    trace.push(row);
  }
  return fallback();
}
