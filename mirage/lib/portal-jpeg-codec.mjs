// A bounded baseline JPEG codec (ITU-T T.81 with the JFIF colour model) for portal image thumbnails, in plain
// JavaScript so the runtime needs no image dependency. decodeJpeg reads sequential (SOF0, SOF1) and progressive (SOF2,
// Annex G spectral selection and successive approximation, at most MAX_PROGRESSIVE_SCANS scans) Huffman frames with
// 8-bit samples and one (grayscale) or three (YCbCr, or RGB per Adobe APP14) components, any integral sampling factors
// and restart intervals. Every other process (lossless, arithmetic, 12-bit, CMYK) and every malformed stream answers
// null, so callers keep the original bytes. encodeJpeg writes baseline JFIF with the Annex K tables.

const DEFAULT_LIMITS = Object.freeze({ maxPixels: 8 * 1024 * 1024, maxDimension: 8192 });
const FAST_BITS = 9;
const MAX_BLOCKS_PER_MCU = 10;
// Each progressive scan walks every block of its components, so the scan count bounds the decode work (the libjpeg
// progressive scripts use about ten scans).
const MAX_PROGRESSIVE_SCANS = 64;

/** Natural (row-major) index of each zigzag position. */
const ZIGZAG = (() => {
  const order = [];
  for (let sum = 0; sum < 15; sum++)
    for (let i = 0; i <= sum; i++) {
      const row = sum % 2 ? i : sum - i;
      const column = sum - row;
      if (row < 8 && column < 8) order.push(row * 8 + column);
    }
  return Uint8Array.from(order);
})();

/** COSINES[x * 8 + u] = C(u) / 2 * cos((2x + 1)uπ / 16): the orthonormal 8-point DCT basis. */
const COSINES = (() => {
  const table = new Float64Array(64);
  for (let x = 0; x < 8; x++)
    for (let u = 0; u < 8; u++)
      table[x * 8 + u] = ((u ? 1 : Math.SQRT1_2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;
  return table;
})();

// Annex K.1 quantization tables, natural order.
const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_QUANT = [
  17,
  18,
  24,
  47,
  99,
  99,
  99,
  99,
  18,
  21,
  26,
  66,
  99,
  99,
  99,
  99,
  24,
  26,
  56,
  99,
  99,
  99,
  99,
  99,
  47,
  66,
  99,
  99,
  99,
  99,
  99,
  99,
  ...Array.from({ length: 32 }, () => 99),
];

// Annex K.3 Huffman tables. Each AC symbol list is its irregular head followed by the remaining (run, size) symbols in
// ascending order, exactly as the standard tabulates them.
function acSymbols(head) {
  const all = [0x00, 0xf0];
  for (let run = 0; run < 16; run++) for (let size = 1; size <= 10; size++) all.push((run << 4) | size);
  const rest = all.filter((symbol) => !head.includes(symbol)).sort((a, b) => a - b);
  return Uint8Array.from([...head, ...rest]);
}
const DC_SYMBOLS = Uint8Array.from({ length: 12 }, (_, i) => i);
const STANDARD_TABLES = Object.freeze({
  dcLuma: { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], symbols: DC_SYMBOLS },
  dcChroma: { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], symbols: DC_SYMBOLS },
  acLuma: {
    counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
    symbols: acSymbols([
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
      0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
      0x0a,
    ]),
  },
  acChroma: {
    counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
    symbols: acSymbols([
      0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
      0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16,
      0x24, 0x34, 0xe1, 0x25, 0xf1,
    ]),
  },
});

class MalformedJpeg extends Error {}

function check(condition) {
  if (!condition) throw new MalformedJpeg('Unsupported or malformed JPEG stream.');
}

const u16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];
const isRestart = (marker) => marker >= 0xd0 && marker <= 0xd7;

/** The marker segment at offset: standalone markers have start === end. */
function readSegment(bytes, offset) {
  check(bytes[offset] === 0xff);
  let at = offset + 1;
  while (bytes[at] === 0xff) at++;
  check(at < bytes.length);
  const marker = bytes[at++];
  if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || isRestart(marker)) return { marker, start: at, end: at };
  check(at + 2 <= bytes.length);
  const length = u16(bytes, at);
  check(length >= 2 && at + length <= bytes.length);
  return { marker, start: at + 2, end: at + length };
}

/** The offset of the next marker (0xFF not followed by a stuffed zero) at or after from, or the stream length. */
function nextMarker(bytes, from) {
  for (let at = bytes.indexOf(0xff, from); at !== -1 && at + 1 < bytes.length; at = bytes.indexOf(0xff, at + 1))
    if (bytes[at + 1] !== 0) return at;
  return bytes.length;
}

function readQuantTables(state, { start, end }) {
  const { bytes } = state;
  for (let at = start; at < end;) {
    const precision = bytes[at] >> 4;
    const id = bytes[at] & 15;
    const size = precision ? 2 : 1;
    check(precision <= 1 && id <= 3 && at + 1 + 64 * size <= end);
    const table = new Uint16Array(64);
    for (let k = 0; k < 64; k++) table[k] = precision ? u16(bytes, at + 1 + 2 * k) : bytes[at + 1 + k];
    state.quant[id] = table;
    at += 1 + 64 * size;
  }
}

/** Canonical decoding tables (Annex C, F.2.2.3) with a FAST_BITS lookahead; rejects codes that overflow their length. */
function buildHuffman(counts, symbols) {
  const fast = new Uint16Array(1 << FAST_BITS);
  const maxCode = new Int32Array(17).fill(-1);
  const offset = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1];
    offset[length] = k - code;
    for (let i = 0; i < count; i++) {
      if (length <= FAST_BITS) {
        const shift = FAST_BITS - length;
        fast.fill((length << 8) | symbols[k], code << shift, (code + 1) << shift);
      }
      code++;
      k++;
    }
    if (count) maxCode[length] = code - 1;
    // The all-ones code of any length is reserved (Annex C); libjpeg rejects such tables too.
    check(code < 1 << length);
    code <<= 1;
  }
  return { fast, maxCode, offset, symbols };
}

function readHuffmanTables(state, { start, end }) {
  const { bytes } = state;
  for (let at = start; at < end;) {
    check(at + 17 <= end);
    const tableClass = bytes[at] >> 4;
    const id = bytes[at] & 15;
    const counts = bytes.subarray(at + 1, at + 17);
    const total = counts.reduce((sum, count) => sum + count, 0);
    check(tableClass <= 1 && id <= 3 && total <= 256 && at + 17 + total <= end);
    const symbols = bytes.slice(at + 17, at + 17 + total);
    (tableClass ? state.ac : state.dc)[id] = buildHuffman(counts, symbols);
    at += 17 + total;
  }
}

function readComponents(bytes, start, count) {
  const components = [];
  for (let i = 0; i < count; i++) {
    const at = start + 6 + 3 * i;
    const component = { id: bytes[at], h: bytes[at + 1] >> 4, v: bytes[at + 1] & 15, tq: bytes[at + 2] };
    check(component.h >= 1 && component.h <= 4 && component.v >= 1 && component.v <= 4 && component.tq <= 3);
    check(!components.some((other) => other.id === component.id));
    components.push(component);
  }
  return components;
}

function readFrame(state, { marker, start, end }) {
  const { bytes, limits } = state;
  // SOF0 baseline, SOF1 extended sequential and SOF2 progressive Huffman; lossless and arithmetic processes are refused.
  check(!state.frame && (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && end - start >= 6);
  const height = u16(bytes, start + 1);
  const width = u16(bytes, start + 3);
  const count = bytes[start + 5];
  check(bytes[start] === 8 && width > 0 && height > 0 && (count === 1 || count === 3));
  check(end - start === 6 + 3 * count);
  check(Math.max(width, height) <= limits.maxDimension && width * height <= limits.maxPixels);
  const components = readComponents(bytes, start, count);
  const hMax = Math.max(...components.map((c) => c.h));
  const vMax = Math.max(...components.map((c) => c.v));
  check(components.every((c) => hMax % c.h === 0 && vMax % c.v === 0));
  const mcusX = Math.ceil(width / (8 * hMax));
  const mcusY = Math.ceil(height / (8 * vMax));
  for (const c of components) {
    c.stride = mcusX * c.h * 8;
    c.blocksX = Math.ceil(Math.ceil((width * c.h) / hMax) / 8);
    c.blocksY = Math.ceil(Math.ceil((height * c.v) / vMax) / 8);
    c.rows = mcusY * c.v * 8;
  }
  state.frame = { width, height, components, hMax, vMax, mcusX, mcusY, progressive: marker === 0xc2 };
}

function readAdobe(state, { start, end }) {
  const { bytes } = state;
  if (end - start >= 12 && String.fromCodePoint(...bytes.subarray(start, start + 5)) === 'Adobe')
    state.adobe = bytes[start + 11];
}

class BitReader {
  constructor(bytes, offset) {
    this.bytes = bytes;
    this.reset(offset);
  }

  reset(offset) {
    this.offset = offset;
    this.buffer = 0;
    this.count = 0;
    this.padding = 0;
    this.marker = false;
  }

  // Keeps at least 16 bits buffered. Past a marker or the end it supplies 1-bits and counts them as padding.
  fill() {
    while (this.count < 16) {
      let byte = 0xff;
      if (this.marker || this.offset >= this.bytes.length) this.padding += 8;
      else {
        byte = this.bytes[this.offset];
        if (byte !== 0xff) this.offset++;
        else if (this.bytes[this.offset + 1] === 0) this.offset += 2;
        else {
          this.marker = true;
          this.padding += 8;
        }
      }
      this.buffer = (this.buffer << 8) | byte;
      this.count += 8;
    }
  }

  peek(bits) {
    return (this.buffer >>> (this.count - bits)) & ((1 << bits) - 1);
  }

  skip(bits) {
    this.count -= bits;
    this.buffer &= (1 << this.count) - 1;
  }

  /** True once a decoded symbol used padding bits, i.e. the entropy-coded segment ended early. */
  overrun() {
    return this.padding > this.count;
  }

  /** size raw bits, unsigned. */
  bits(size) {
    this.fill();
    const value = this.peek(size);
    this.skip(size);
    return value;
  }

  receive(size) {
    if (!size) return 0;
    this.fill();
    const value = this.peek(size);
    this.skip(size);
    return value < 1 << (size - 1) ? value - (1 << size) + 1 : value;
  }

  decode(table) {
    this.fill();
    const entry = table.fast[this.peek(FAST_BITS)];
    if (entry) {
      this.skip(entry >> 8);
      return entry & 0xff;
    }
    for (let length = FAST_BITS + 1; length <= 16; length++) {
      const code = this.peek(length);
      if (code <= table.maxCode[length]) {
        this.skip(length);
        return table.symbols[table.offset[length] + code];
      }
    }
    throw new MalformedJpeg('Invalid Huffman code.');
  }
}

function decodeCoefficients(reader, component, block) {
  block.fill(0);
  const quant = component.quantTable;
  const category = reader.decode(component.dc);
  check(category <= 11);
  component.prediction += reader.receive(category);
  block[0] = component.prediction * quant[0];
  for (let k = 1; k < 64;) {
    const symbol = reader.decode(component.ac);
    const size = symbol & 15;
    const run = symbol >> 4;
    if (size) {
      k += run;
      check(k < 64 && size <= 10);
      block[ZIGZAG[k]] = reader.receive(size) * quant[k];
      k++;
    } else if (run === 15) k += 16;
    else break;
  }
}

function inverseRow(block, row, work) {
  let flat = true;
  for (let u = 1; u < 8 && flat; u++) flat = block[row + u] === 0;
  if (flat) {
    work.fill(block[row] * COSINES[0], row, row + 8);
    return;
  }
  for (let x = 0; x < 8; x++) {
    let sum = 0;
    for (let u = 0; u < 8; u++) sum += COSINES[x * 8 + u] * block[row + u];
    work[row + x] = sum;
  }
}

/** Inverse DCT of one dequantized block into a component plane (Uint8ClampedArray rounds and clamps). */
function inverseTransform(block, work, plane, stride, offset) {
  for (let row = 0; row < 64; row += 8) inverseRow(block, row, work);
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++) {
      let sum = 128;
      for (let v = 0; v < 8; v++) sum += COSINES[y * 8 + v] * work[v * 8 + x];
      plane[offset + y * stride + x] = sum;
    }
}

function decodeBlock(state, component, column, row) {
  decodeCoefficients(state.reader, component, state.block);
  inverseTransform(state.block, state.work, component.plane, component.stride, row * 8 * component.stride + column * 8);
}

function decodeUnit(state, scan, unit) {
  if (scan.components.length === 1) {
    const [component] = scan.components;
    decodeBlock(state, component, unit % component.blocksX, Math.floor(unit / component.blocksX));
    return;
  }
  const mcuX = unit % state.frame.mcusX;
  const mcuY = Math.floor(unit / state.frame.mcusX);
  for (const component of scan.components)
    for (let y = 0; y < component.v; y++)
      for (let x = 0; x < component.h; x++)
        decodeBlock(state, component, mcuX * component.h + x, mcuY * component.v + y);
}

function readScan(state, { start, end }) {
  const { bytes, frame } = state;
  check(frame);
  const count = bytes[start];
  check(count >= 1 && count <= frame.components.length && end - start === 4 + 2 * count);
  const components = [];
  for (let i = 0; i < count; i++) {
    const tables = bytes[start + 2 + 2 * i];
    const component = frame.components.find((c) => c.id === bytes[start + 1 + 2 * i]);
    check(component && !components.includes(component) && !state.scanned.has(component));
    component.dc = state.dc[tables >> 4];
    component.ac = state.ac[tables & 15];
    component.quantTable = state.quant[component.tq];
    check(component.dc && component.ac && component.quantTable);
    components.push(component);
  }
  const spectral = start + 1 + 2 * count;
  // Sequential scans code the whole spectrum without successive approximation.
  check(bytes[spectral] === 0 && bytes[spectral + 1] === 63 && bytes[spectral + 2] === 0);
  check(count === 1 || components.reduce((sum, c) => sum + c.h * c.v, 0) <= MAX_BLOCKS_PER_MCU);
  return { components };
}

function skipRestartMarker(reader) {
  const { bytes } = reader;
  let at = reader.marker ? reader.offset : nextMarker(bytes, reader.offset);
  while (bytes[at + 1] === 0xff) at++;
  check(bytes[at] === 0xff && isRestart(bytes[at + 1]));
  reader.reset(at + 2);
}

// ---- Progressive scans (Annex G.1.2): coefficients collect per block, in zigzag order, across the scans; the inverse
// transform runs once the last scan is read.

function readProgressiveScan(state, { start, end }) {
  const { bytes, frame } = state;
  const count = bytes[start];
  check(count >= 1 && count <= frame.components.length && end - start === 4 + 2 * count);
  const spectral = start + 1 + 2 * count;
  const ss = bytes[spectral];
  const se = bytes[spectral + 1];
  const ah = bytes[spectral + 2] >> 4;
  const al = bytes[spectral + 2] & 15;
  // DC scans may interleave components; AC scans hold one component (G.1.1.1.1). A refinement's Ah is the previous Al.
  check(ss <= se && se <= 63 && (ss === 0 ? se === 0 : count === 1) && al <= 13 && (ah === 0 || ah === al + 1));
  const components = [];
  for (let i = 0; i < count; i++) {
    const tables = bytes[start + 2 + 2 * i];
    const component = frame.components.find((c) => c.id === bytes[start + 1 + 2 * i]);
    check(component && !components.includes(component));
    // A DC refinement reads raw bits only; the other scans name the table they decode with.
    if (ss === 0 && ah === 0) {
      component.dc = state.dc[tables >> 4];
      check(component.dc);
    }
    if (ss > 0) {
      component.ac = state.ac[tables & 15];
      check(component.ac);
    }
    components.push(component);
  }
  check(count === 1 || components.reduce((sum, c) => sum + c.h * c.v, 0) <= MAX_BLOCKS_PER_MCU);
  return { components, ss, se, ah, al };
}

function decodeDcFirst(reader, component, block, scan) {
  const category = reader.decode(component.dc);
  check(category <= 11);
  component.prediction += reader.receive(category);
  block[0] = component.prediction * (1 << scan.al);
}

function decodeDcRefine(reader, _component, block, scan) {
  if (reader.bits(1)) block[0] |= 1 << scan.al;
}

function decodeAcFirst(reader, component, block, scan) {
  if (component.eobrun > 0) {
    component.eobrun--;
    return;
  }
  for (let k = scan.ss; k <= scan.se; k++) {
    const symbol = reader.decode(component.ac);
    const size = symbol & 15;
    const run = symbol >> 4;
    if (size) {
      k += run;
      check(k <= scan.se && size <= 10);
      block[k] = reader.receive(size) * (1 << scan.al);
    } else if (run === 15) k += 15;
    else {
      component.eobrun = (1 << run) - 1 + (run ? reader.bits(run) : 0);
      break;
    }
  }
}

/** One correction bit for a coefficient that is already nonzero. */
function refineNonzero(reader, block, k, p1) {
  if (reader.bits(1) && (block[k] & p1) === 0) block[k] += block[k] >= 0 ? p1 : -p1;
}

/**
 * Passes `run` zero coefficients from `start`, refining the nonzero ones on the way, and answers the index of the zero
 * coefficient that follows them (past `se` when the band ends first).
 */
function passZeroRun(reader, block, start, run, p1, se) {
  let left = run;
  let k = start;
  for (; k <= se; k++) {
    if (block[k] !== 0) refineNonzero(reader, block, k, p1);
    else if (--left < 0) break;
  }
  return k;
}

/**
 * Decodes one AC refinement symbol for the coefficients from `k`: answers the index after the coefficient it places, or
 * -1 for an end-of-band run (then component.eobrun holds the run).
 */
function decodeRefineSymbol(reader, component, block, k, scan, p1) {
  const symbol = reader.decode(component.ac);
  const run = symbol >> 4;
  let value = 0;
  if (symbol & 15) {
    check((symbol & 15) === 1);
    value = reader.bits(1) ? p1 : -p1;
  } else if (run !== 15) {
    component.eobrun = (1 << run) + (run ? reader.bits(run) : 0);
    return -1;
  }
  const at = passZeroRun(reader, block, k, run, p1, scan.se);
  if (value) {
    check(at <= scan.se);
    block[at] = value;
  }
  return at + 1;
}

function decodeAcRefine(reader, component, block, scan) {
  const p1 = 1 << scan.al;
  let k = scan.ss;
  while (component.eobrun === 0 && k <= scan.se) {
    const next = decodeRefineSymbol(reader, component, block, k, scan, p1);
    if (next < 0) break;
    k = next;
  }
  if (component.eobrun > 0) {
    for (; k <= scan.se; k++) if (block[k] !== 0) refineNonzero(reader, block, k, p1);
    component.eobrun--;
  }
}

function progressiveDecoder(scan) {
  if (scan.ss === 0) return scan.ah ? decodeDcRefine : decodeDcFirst;
  return scan.ah ? decodeAcRefine : decodeAcFirst;
}

function decodeProgressiveUnit(state, scan, unit, decodeCoefficientsOf) {
  const at = (component, column, row) => {
    const offset = (row * (component.stride >> 3) + column) * 64;
    decodeCoefficientsOf(state.reader, component, component.coefficients.subarray(offset, offset + 64), scan);
  };
  if (scan.components.length === 1) {
    const [component] = scan.components;
    at(component, unit % component.blocksX, Math.floor(unit / component.blocksX));
    return;
  }
  const mcuX = unit % state.frame.mcusX;
  const mcuY = Math.floor(unit / state.frame.mcusX);
  for (const component of scan.components)
    for (let y = 0; y < component.v; y++)
      for (let x = 0; x < component.h; x++) at(component, mcuX * component.h + x, mcuY * component.v + y);
}

/** Decodes one progressive scan into the coefficient buffers and answers the offset of the marker that follows it. */
function decodeProgressiveScan(state, segment) {
  state.scans++;
  check(state.scans <= MAX_PROGRESSIVE_SCANS);
  const scan = readProgressiveScan(state, segment);
  const { frame } = state;
  for (const c of frame.components) c.coefficients ??= new Int16Array((c.stride >> 3) * (c.rows >> 3) * 64);
  const decodeCoefficientsOf = progressiveDecoder(scan);
  const [first] = scan.components;
  const total = scan.components.length === 1 ? first.blocksX * first.blocksY : frame.mcusX * frame.mcusY;
  const interval = state.restart || total;
  const reader = new BitReader(state.bytes, segment.end);
  state.reader = reader;
  for (let begin = 0; begin < total; begin += interval) {
    if (begin) skipRestartMarker(reader);
    for (const c of scan.components) {
      c.prediction = 0;
      c.eobrun = 0;
    }
    const stop = Math.min(total, begin + interval);
    for (let unit = begin; unit < stop; unit++) decodeProgressiveUnit(state, scan, unit, decodeCoefficientsOf);
    check(!reader.overrun());
  }
  for (const c of scan.components) state.scanned.add(c);
  return reader.marker ? reader.offset : nextMarker(state.bytes, reader.offset);
}

/** The inverse transform of every collected block of a progressive frame, with the quantization tables at its end. */
function finishProgressive(state) {
  for (const c of state.frame.components) {
    const quant = state.quant[c.tq];
    check(quant && c.coefficients);
    c.quantTable = quant;
    c.plane = new Uint8ClampedArray(c.stride * c.rows);
    const blocksPerLine = c.stride >> 3;
    for (let index = 0; index < c.coefficients.length / 64; index++) {
      const coefficients = c.coefficients.subarray(index * 64, index * 64 + 64);
      state.block.fill(0);
      for (let k = 0; k < 64; k++) if (coefficients[k]) state.block[ZIGZAG[k]] = coefficients[k] * quant[k];
      const row = Math.floor(index / blocksPerLine);
      const column = index % blocksPerLine;
      inverseTransform(state.block, state.work, c.plane, c.stride, row * 8 * c.stride + column * 8);
    }
  }
}

/** Decodes one scan and answers the offset of the marker that follows it. */
function decodeScan(state, segment) {
  check(state.frame);
  if (state.frame.progressive) return decodeProgressiveScan(state, segment);
  const scan = readScan(state, segment);
  const { frame } = state;
  for (const c of frame.components) c.plane ??= new Uint8ClampedArray(c.stride * c.rows);
  const [first] = scan.components;
  const total = scan.components.length === 1 ? first.blocksX * first.blocksY : frame.mcusX * frame.mcusY;
  const interval = state.restart || total;
  const reader = new BitReader(state.bytes, segment.end);
  state.reader = reader;
  for (let begin = 0; begin < total; begin += interval) {
    if (begin) skipRestartMarker(reader);
    for (const c of scan.components) c.prediction = 0;
    const stop = Math.min(total, begin + interval);
    for (let unit = begin; unit < stop; unit++) decodeUnit(state, scan, unit);
    check(!reader.overrun());
  }
  for (const c of scan.components) state.scanned.add(c);
  return reader.marker ? reader.offset : nextMarker(state.bytes, reader.offset);
}

function readMarker(state, segment) {
  const { marker } = segment;
  if (marker === 0xdb) readQuantTables(state, segment);
  else if (marker === 0xc4) readHuffmanTables(state, segment);
  else if (marker >= 0xc0 && marker <= 0xcf) readFrame(state, segment);
  else if (marker === 0xdd) {
    check(segment.end - segment.start === 2);
    state.restart = u16(state.bytes, segment.start);
  } else if (marker === 0xee) readAdobe(state, segment);
  // Application data and comments are skipped; any other marker (DNL, hierarchical, a second SOI) is unsupported.
  else check((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe);
}

function parse(bytes, limits, frameOnly) {
  check(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8);
  const state = {
    bytes,
    limits: { ...DEFAULT_LIMITS, ...limits },
    frame: null,
    quant: [],
    dc: [],
    ac: [],
    restart: 0,
    adobe: null,
    scanned: new Set(),
    scans: 0,
    block: new Float64Array(64),
    work: new Float64Array(64),
  };
  for (let offset = 2; offset < bytes.length;) {
    const segment = readSegment(bytes, offset);
    if (segment.marker === 0xd9) break;
    if (segment.marker === 0xda) {
      check(!frameOnly);
      offset = decodeScan(state, segment);
    } else {
      readMarker(state, segment);
      if (frameOnly && state.frame) return state;
      offset = segment.end;
    }
  }
  check(state.scanned.size === state.frame?.components.length);
  if (state.frame.progressive) finishProgressive(state);
  return state;
}

function grayPixels({ width, height, components: [gray] }) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.set(gray.plane.subarray(y * gray.stride, y * gray.stride + width), y * width);
  return data;
}

function colorPixels({ width, height, components, hMax, vMax }, rgb) {
  const data = new Uint8ClampedArray(width * height * 3);
  const columns = components.map((c) => Int32Array.from({ length: width }, (_, x) => Math.floor((x * c.h) / hMax)));
  const [first, second, third] = components;
  for (let y = 0; y < height; y++) {
    const rows = components.map((c) => Math.floor((y * c.v) / vMax) * c.stride);
    for (let x = 0, out = y * width * 3; x < width; x++, out += 3) {
      const a = first.plane[rows[0] + columns[0][x]];
      const b = second.plane[rows[1] + columns[1][x]];
      const c = third.plane[rows[2] + columns[2][x]];
      if (rgb) {
        data[out] = a;
        data[out + 1] = b;
        data[out + 2] = c;
      } else {
        data[out] = a + 1.402 * (c - 128);
        data[out + 1] = a - 0.344136 * (b - 128) - 0.714136 * (c - 128);
        data[out + 2] = a + 1.772 * (b - 128);
      }
    }
  }
  return new Uint8Array(data.buffer);
}

function pixels(state) {
  const { frame, adobe } = state;
  const { width, height, components } = frame;
  if (components.length === 1)
    return { width, height, channels: 1, data: grayPixels(frame), quantTables: [components[0].quantTable.slice()] };
  // Adobe APP14 transform 0 marks RGB samples; without APP14, libjpeg's convention treats component ids R, G, B as RGB.
  const rgb = adobe === 0 || (adobe === null && components.map((c) => c.id).join() === '82,71,66');
  const [luma, ...chroma] = components;
  const sampling =
    chroma.every((c) => c.h === 1 && c.v === 1) && luma.h <= 2 && luma.v <= 2 ? { h: luma.h, v: luma.v } : null;
  return {
    width,
    height,
    channels: 3,
    data: colorPixels(frame, rgb),
    quantTables: [luma.quantTable.slice(), chroma[0].quantTable.slice()],
    sampling,
  };
}

/**
 * Decodes a baseline or extended sequential Huffman JPEG into 8-bit samples: { width, height, channels (1 gray or 3
 * RGB), data, quantTables (zigzag order), sampling }. Answers null for unsupported processes, malformed or truncated
 * streams and frames past limits ({ maxPixels, maxDimension }, default 8M pixels and 8192 per side); it never throws.
 */
export function decodeJpeg(bytes, limits = {}) {
  try {
    return pixels(parse(bytes, limits, false));
  } catch {
    return null;
  }
}

/** The frame size of a JPEG this codec can decode within limits, read from its headers only; otherwise null. */
export function jpegFrame(bytes, limits = {}) {
  try {
    const { width, height, components } = parse(bytes, limits, true).frame;
    return { width, height, channels: components.length };
  } catch {
    return null;
  }
}

class ByteWriter {
  constructor(size = 4096) {
    this.bytes = new Uint8Array(size);
    this.length = 0;
    this.bits = 0;
    this.count = 0;
  }

  byte(value) {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = value;
  }

  write(values) {
    for (const value of values) this.byte(value);
  }

  segment(marker, payload) {
    this.write([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
    this.write(payload);
  }

  /** Appends size bits of value to the entropy-coded data, stuffing a zero after every 0xFF byte. */
  put(value, size) {
    this.bits = (this.bits << size) | value;
    this.count += size;
    while (this.count >= 8) {
      this.count -= 8;
      const byte = (this.bits >> this.count) & 0xff;
      this.byte(byte);
      if (byte === 0xff) this.byte(0);
    }
    this.bits &= (1 << this.count) - 1;
  }

  /** Pads the entropy-coded data to a byte boundary with 1-bits. */
  align() {
    if (this.count) this.put((1 << (8 - this.count)) - 1, 8 - this.count);
  }

  result() {
    return Buffer.from(this.bytes.buffer, 0, this.length);
  }
}

function encoderTable({ counts, symbols }) {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let next = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++, k++) {
      code[symbols[k]] = next++;
      size[symbols[k]] = length;
    }
    next <<= 1;
  }
  return { code, size };
}
const ENCODER_TABLES = Object.freeze(
  Object.fromEntries(Object.entries(STANDARD_TABLES).map(([name, table]) => [name, encoderTable(table)])),
);

/** IJG quality scaling of an Annex K table, answered in zigzag order. */
function scaledQuant(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return Uint16Array.from(ZIGZAG, (index) => Math.min(255, Math.max(1, Math.floor((base[index] * scale + 50) / 100))));
}

const usableQuant = (table) => table?.length === 64 && table.every((value) => value >= 1 && value <= 255);

/** Level-shifted sample planes: luma at full size, chroma averaged over each hMax x vMax group of pixels. */
function samplePlanes({ width, height, channels, data }, hMax, vMax) {
  if (channels === 1) return [{ width, height, samples: Float32Array.from(data, (value) => value - 128) }];
  const luma = new Float32Array(width * height);
  const chromaWidth = Math.ceil(width / hMax);
  const chromaHeight = Math.ceil(height / vMax);
  const blue = new Float32Array(chromaWidth * chromaHeight);
  const red = new Float32Array(chromaWidth * chromaHeight);
  const weights = new Float32Array(chromaWidth * chromaHeight);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const [r, g, b] = [data[at], data[at + 1], data[at + 2]];
      const group = Math.floor(y / vMax) * chromaWidth + Math.floor(x / hMax);
      luma[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      blue[group] += -0.168736 * r - 0.331264 * g + 0.5 * b;
      red[group] += 0.5 * r - 0.418688 * g - 0.081312 * b;
      weights[group]++;
    }
  for (let i = 0; i < weights.length; i++) {
    blue[i] /= weights[i];
    red[i] /= weights[i];
  }
  return [
    { width, height, samples: luma },
    { width: chromaWidth, height: chromaHeight, samples: blue },
    { width: chromaWidth, height: chromaHeight, samples: red },
  ];
}

/** Forward DCT and quantization of one 8x8 block (edge samples repeated past the plane), in zigzag order. */
function forwardTransform(plane, left, top, quant, work, out) {
  for (let y = 0; y < 8; y++) {
    const row = Math.min(top + y, plane.height - 1) * plane.width;
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += COSINES[x * 8 + u] * plane.samples[row + Math.min(left + x, plane.width - 1)];
      work[y * 8 + u] = sum;
    }
  }
  for (let k = 0; k < 64; k++) {
    const index = ZIGZAG[k];
    const u = index & 7;
    const v = index >> 3;
    let sum = 0;
    for (let y = 0; y < 8; y++) sum += COSINES[y * 8 + v] * work[y * 8 + u];
    const level = Math.round(sum / quant[k]);
    out[k] = Math.max(-1023, Math.min(1023, level));
  }
}

const category = (value) => 32 - Math.clz32(Math.abs(value));

function putValue(writer, value, size) {
  if (size) writer.put(value < 0 ? value + (1 << size) - 1 : value, size);
}

function encodeBlock(writer, coefficients, component) {
  const { dc, ac } = component;
  const diff = coefficients[0] - component.prediction;
  component.prediction = coefficients[0];
  const dcSize = category(diff);
  writer.put(dc.code[dcSize], dc.size[dcSize]);
  putValue(writer, diff, dcSize);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const value = coefficients[k];
    if (value) {
      for (; run > 15; run -= 16) writer.put(ac.code[0xf0], ac.size[0xf0]);
      const size = category(value);
      const symbol = (run << 4) | size;
      writer.put(ac.code[symbol], ac.size[symbol]);
      putValue(writer, value, size);
      run = 0;
    } else run++;
  }
  if (run) writer.put(ac.code[0], ac.size[0]);
}

function writeHeaders(writer, { width, height, components, quants, restartInterval, dpi }) {
  writer.write([0xff, 0xd8]);
  // JFIF 1.01 with no density unit and a 1:1 aspect, or JFIF 1.1 at dpi dots per inch.
  if (dpi) writer.segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, dpi >> 8, dpi & 0xff, dpi >> 8, dpi & 0xff, 0, 0]);
  else writer.segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  quants.forEach((table, id) => writer.segment(0xdb, [id, ...table]));
  writer.segment(0xc0, [
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    components.length,
    ...components.flatMap((c) => [c.id, (c.h << 4) | c.v, c.tq]),
  ]);
  const tables = [
    [0x00, STANDARD_TABLES.dcLuma],
    [0x10, STANDARD_TABLES.acLuma],
    ...(components.length > 1
      ? [
          [0x01, STANDARD_TABLES.dcChroma],
          [0x11, STANDARD_TABLES.acChroma],
        ]
      : []),
  ];
  for (const [id, table] of tables) writer.segment(0xc4, [id, ...table.counts, ...table.symbols]);
  if (restartInterval) writer.segment(0xdd, [restartInterval >> 8, restartInterval & 0xff]);
  writer.segment(0xda, [components.length, ...components.flatMap((c) => [c.id, c.tables]), 0, 63, 0]);
}

function encoderComponents(channels, sampling, planes) {
  const luma = { id: 1, tq: 0, tables: 0x00, dc: ENCODER_TABLES.dcLuma, ac: ENCODER_TABLES.acLuma, plane: planes[0] };
  if (channels === 1) return [{ ...luma, h: 1, v: 1 }];
  const chroma = { h: 1, v: 1, tq: 1, tables: 0x11, dc: ENCODER_TABLES.dcChroma, ac: ENCODER_TABLES.acChroma };
  return [
    { ...luma, h: sampling.h, v: sampling.v },
    { id: 2, ...chroma, plane: planes[1] },
    { id: 3, ...chroma, plane: planes[2] },
  ];
}

function encodeUnit({ writer, components, quants, work, coefficients }, mcuX, mcuY) {
  for (const c of components)
    for (let y = 0; y < c.v; y++)
      for (let x = 0; x < c.h; x++) {
        forwardTransform(c.plane, (mcuX * c.h + x) * 8, (mcuY * c.v + y) * 8, quants[c.tq], work, coefficients);
        encodeBlock(writer, coefficients, c);
      }
}

/** The encoder's input limits: 1 or 3 channels, sampling factors of 1 or 2 and a size of 1 to 65535 pixels a side. */
function assertEncodable({ width, height, channels }, sampling) {
  if (!(channels === 1 || channels === 3) || ![sampling.h, sampling.v].every((f) => f === 1 || f === 2))
    throw new RangeError('encodeJpeg needs 1 or 3 channels and sampling factors of 1 or 2.');
  if (!(width >= 1 && height >= 1 && width <= 0xffff && height <= 0xffff)) throw new RangeError('Invalid JPEG size.');
}

/**
 * Encodes 8-bit samples ({ width, height, channels 1 or 3, data }) as a baseline JFIF JPEG. Options: quality (IJG scale,
 * default 90), sampling ({ h, v } luma factors 1 or 2 for colour; default 2x2, i.e. 4:2:0), quantTables ([luma, chroma]
 * in zigzag order, 8-bit values; replaces quality), restartInterval (MCUs between RST markers) and dpi (a JFIF density
 * in dots per inch; without it the density has no unit).
 */
export function encodeJpeg(
  image,
  { quality = 90, sampling = { h: 2, v: 2 }, quantTables = null, restartInterval = 0, dpi = 0 } = {},
) {
  assertEncodable(image, sampling);
  const { width, height, channels } = image;
  const quants = [LUMA_QUANT, CHROMA_QUANT]
    .slice(0, channels === 1 ? 1 : 2)
    .map((base, i) => (usableQuant(quantTables?.[i]) ? Uint16Array.from(quantTables[i]) : scaledQuant(base, quality)));
  const hMax = channels === 1 ? 1 : sampling.h;
  const vMax = channels === 1 ? 1 : sampling.v;
  const planes = samplePlanes(image, hMax, vMax);
  const components = encoderComponents(channels, sampling, planes);
  const restart = Math.max(0, Math.min(0xffff, Math.floor(restartInterval)));
  const writer = new ByteWriter();
  const density = Number.isInteger(dpi) && dpi > 0 && dpi <= 0xffff ? dpi : 0;
  writeHeaders(writer, { width, height, components, quants, restartInterval: restart, dpi: density });
  const scan = { writer, components, quants, work: new Float64Array(64), coefficients: new Int32Array(64) };
  const mcusX = Math.ceil(width / (8 * hMax));
  const mcuCount = mcusX * Math.ceil(height / (8 * vMax));
  for (const c of components) c.prediction = 0;
  for (let mcu = 0; mcu < mcuCount; mcu++) {
    if (restart && mcu && mcu % restart === 0) {
      writer.align();
      writer.write([0xff, 0xd0 + ((mcu / restart - 1) & 7)]);
      for (const c of components) c.prediction = 0;
    }
    encodeUnit(scan, mcu % mcusX, Math.floor(mcu / mcusX));
  }
  writer.align();
  writer.write([0xff, 0xd9]);
  return writer.result();
}
