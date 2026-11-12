// A minimal .xlsx workbook: one sheet of inline-string, number and decimal cells, in a stored (uncompressed) ZIP.
// Inline strings are never formulas, so text that looks like a formula stays text.
import { crc32 } from 'node:zlib';

const DECIMAL_TEXT = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const ILLEGAL_XML_CHARACTERS = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;
const FORBIDDEN_SHEET_NAME_CHARACTERS = /[[\]:*?/\\]/g;
const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const DOS_DATE_1980 = 0x0021;

const CONTENT_TYPES = `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
const ROOT_RELS = `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELS_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WORKBOOK_RELS = `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELS_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

/** Text as XML character data: illegal XML 1.0 characters removed, markup characters escaped. */
function xmlText(value) {
  return String(value)
    .replace(ILLEGAL_XML_CHARACTERS, '')
    .replace(/[&<>"']/g, (character) => XML_ESCAPES[character]);
}

// Excel refuses a cell with more than 32,767 characters. The cut follows the illegal-character removal, and a high
// surrogate left at the end of the kept text is dropped with its low surrogate, so no pair is split.
const CELL_TEXT_LIMIT = 32767;
function cellText(value) {
  const text = String(value).replace(ILLEGAL_XML_CHARACTERS, '');
  if (text.length <= CELL_TEXT_LIMIT) return text;
  const kept = text.slice(0, CELL_TEXT_LIMIT);
  return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
}

/** A sheet name of at most 31 characters without the characters Excel forbids in names. */
function workbookSheetName(value) {
  const plain = String(value ?? '')
    .replace(ILLEGAL_XML_CHARACTERS, '')
    .replace(FORBIDDEN_SHEET_NAME_CHARACTERS, '');
  return xmlText(Array.from(plain).slice(0, 31).join('')) || 'Sheet1';
}

/** The A1-style column letters of a zero-based column index. */
function columnName(index) {
  let name = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26))
    name = String.fromCharCode(65 + ((number - 1) % 26)) + name;
  return name;
}

/** A numeric cell written from its decimal text, so exact digits are never rounded through a binary float.
 * Null if the text is not a decimal. */
export function decimalCell(text) {
  if (!DECIMAL_TEXT.test(text)) return null;
  return { decimal: text.replace(/^\+/, '') };
}

function cellXml(value, reference) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === 'object' && 'decimal' in value) return `<c r="${reference}"><v>${value.decimal}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlText(cellText(value))}</t></is></c>`;
}

function sheetXml(rows) {
  const body = rows
    .map((cells, rowIndex) => {
      const number = rowIndex + 1;
      const row = cells.map((value, column) => cellXml(value, `${columnName(column)}${number}`)).join('');
      return `<row r="${number}">${row}</row>`;
    })
    .join('');
  return `${XML_HEADER}<worksheet xmlns="${SHEET_NS}"><sheetData>${body}</sheetData></worksheet>`;
}

function workbookXml(sheetName) {
  return `${XML_HEADER}<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

/** The local file header of a stored entry (version 2.0, UTF-8 names, the fixed date 1980-01-01). */
function localHeader(name, data, crc) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(DOS_DATE_1980, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return header;
}

function centralHeader(name, data, crc, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(DOS_DATE_1980, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  return header;
}

/** A ZIP archive of `files` ({ name, data: Buffer }) with every entry stored. */
function storedZip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    parts.push(localHeader(nameBytes, data, crc), nameBytes, data);
    directory.push(centralHeader(nameBytes, data, crc, offset), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

/** A .xlsx workbook (Buffer) with one sheet of `rows`, each an array of cell values; the first row is the header. */
export function xlsxWorkbook(rows, { sheetName } = {}) {
  const text = (value) => Buffer.from(value, 'utf8');
  return storedZip([
    { name: '[Content_Types].xml', data: text(CONTENT_TYPES) },
    { name: '_rels/.rels', data: text(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: text(workbookXml(workbookSheetName(sheetName))) },
    { name: 'xl/_rels/workbook.xml.rels', data: text(WORKBOOK_RELS) },
    { name: 'xl/worksheets/sheet1.xml', data: text(sheetXml(rows)) },
  ]);
}
