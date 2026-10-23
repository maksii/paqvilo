import { parseDataverseDecimalString } from "./dataverse-decimal-input.mjs";
import {
  decimalParts,
  decimalText,
} from "./exact-numeric.mjs";

// The HTTP OData lexer infers numeric primitive kinds independently of column
// types, including the token named in an extra unary-minus diagnostic.
// The classic CLR round-trip formats use 7/9 (Single) and 15/17 (Double) digits.
// Primitive precedence: OData/odata.net 8.3.0, UriParser/ExpressionLexer.cs.
function roundTrip(value, shortDigits, longDigits, convert = Number) {
  const short = value.toPrecision(shortDigits);
  return convert(Number(short)) === value
    ? Number(short)
    : Number(value.toPrecision(longDigits));
}

function sameDecimal(left, right) {
  const a = decimalParts(left),
    b = decimalParts(right);
  return a && b && a.coefficient === b.coefficient && a.scale === b.scale;
}

export function dataverseNumberLiteralKind(raw) {
  // Only the lexer's signed numeric tokens enter here. Oversized tokens keep
  // the existing bounded unsupported diagnostic rather than guessing a type.
  if (raw.length > 160) return undefined;
  const suffix = /[mMdDfFlL]$/.exec(raw)?.[0]?.toLowerCase();
  if (suffix)
    return {
      m: "Edm.Decimal",
      d: "Edm.Double",
      f: "Edm.Single",
      l: "Edm.Int64",
    }[suffix];
  if (/^-?\d+$/.test(raw)) {
    const integer = BigInt(raw);
    if (integer >= -2147483648n && integer <= 2147483647n) return "Edm.Int32";
    if (integer >= -9223372036854775808n && integer <= 9223372036854775807n)
      return "Edm.Int64";
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) return null;
  const decimal = parseDataverseDecimalString(raw);
  if (decimal !== null) {
    const doubleDecimal =
      parseDataverseDecimalString(String(roundTrip(number, 15, 17))) ??
      parseDataverseDecimalString(
        decimalText(decimalParts(number.toPrecision(15))),
      );
    if (doubleDecimal !== null && !sameDecimal(decimal, doubleDecimal))
      return "Edm.Decimal";
  }
  const single = Math.fround(number);
  if (!Number.isFinite(single)) return "Edm.Double";
  return roundTrip(single, 7, 9, Math.fround) === number
    ? "Edm.Single"
    : "Edm.Double";
}
