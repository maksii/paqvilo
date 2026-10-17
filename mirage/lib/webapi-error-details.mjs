// Stable OData reader diagnostics observed on a reference site. Generated CLR
// stacks are absent by default: these templates describe the reader error,
// not a simulated .NET execution stack. Trusted response-format packs are a
// separate, explicit site option. Enable only with site evidence.
import { isExactNumeric, decimalParts } from "./exact-numeric.mjs";

const readerDetails = Symbol("WebApiODataReaderDetails");
const numberLexemes = Symbol("WebApiJsonNumberLexemes");
const TYPES = new Set(["Edm.String", "Edm.Int32", "Edm.Decimal", "Edm.Double", "Edm.Boolean", "Edm.DateTimeOffset", "Edm.Guid"]);
const PREFIX = "Error identified in Payload provided by the user for Entity :'', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : ";

/** Non-enumerable, request-only facts never become SDK/flow error details. */
export function attachODataReaderDetails(error, details) {
  if (details) Object.defineProperty(error, readerDetails, { value: details });
  return error;
}

/** Value-free reader facts for an explicitly registered response formatting pack. */
export function odataReaderTemplateDescriptor(error) {
  const details = error?.[readerDetails];
  if (!details) return null;
  return Object.fromEntries(["kind", "sourceType", "expectedType", "actualNode", "expectedNode"]
    .filter(key => Object.hasOwn(details, key)).map(key => [key, details[key]]));
}

/** Preserve only root numeric lexical facts for the request formatter. */
export function attachODataJsonSource(body, source) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const numericToken = Symbol("numberToken");
  const parsed = JSON.parse(source, (_key, value, context) =>
    typeof value === "number" && context?.source ? { [numericToken]: context.source } : value);
  const lexemes = Object.create(null);
  for (const key of Object.keys(body)) {
    const token = parsed?.[key]?.[numericToken];
    if (typeof token === "string") lexemes[key] = token;
  }
  Object.defineProperty(body, numberLexemes, { value: lexemes });
  return body;
}
export const odataNumberLexemes = body => body?.[numberLexemes];

const literal = value => isExactNumeric(value) ? value.value : typeof value === "object" ? JSON.stringify(value) : String(value);
function inputType(value, numericLexeme) {
  if (typeof value === "string") return "Edm.String";
  if (typeof value === "boolean") return "Edm.Boolean";
  if (typeof value === "number" || isExactNumeric(value)) {
    if (isExactNumeric(value) && value.numericType !== "Literal") return null;
    // The reference cases establish plain Int32/Decimal tokens. Exponent,
    // Int64/Double, and values beyond CLR Decimal remain unqualified.
    if (typeof numericLexeme !== "string" || !/^-?\d+(?:\.\d+)?$/.test(numericLexeme)) return null;
    const parts = decimalParts(numericLexeme);
    if (!parts || parts.scale > 28 || (parts.coefficient < 0n ? -parts.coefficient : parts.coefficient) > 79228162514264337593543950335n) return null;
    if (parts.scale === 0 && (parts.coefficient < -9007199254740991n || parts.coefficient > 9007199254740991n)) return null;
    if (parts.scale === 0 && parts.coefficient >= -2147483648n && parts.coefficient <= 2147483647n) return "Edm.Int32";
    return "Edm.Decimal";
  }
  return null;
}

/** Facts from the original JSON value and the imported column's Edm type. */
export function odataConversionDetails(value, expectedType, property, { ieee754Compatible = false, numericLexeme } = {}) {
  if (!TYPES.has(expectedType)) return null;
  if (Array.isArray(value)) return null;
  if (value && typeof value === "object" && !isExactNumeric(value))
    return { kind: "property-node", actualNode: "StartObject", expectedNode: "PrimitiveValue", property };
  if (expectedType === "Edm.Decimal" && typeof value === "string")
    return ieee754Compatible ? null : { kind: "decimal-string", expectedType };
  const sourceType = inputType(value, numericLexeme);
  if (!sourceType) return null;
  if (sourceType === "Edm.String" && ["Edm.Int32", "Edm.Double", "Edm.DateTimeOffset", "Edm.Guid"].includes(expectedType))
    return { kind: "primitive-format", literal: literal(value), expectedType };
  if (!(sourceType === "Edm.Int32" && ["Edm.String", "Edm.Boolean"].includes(expectedType) || sourceType === "Edm.Decimal" && expectedType === "Edm.Int32")) return null;
  return { kind: "primitive-type", literal: literal(value), sourceType, expectedType };
}

/** The observed truncated-object stream cases; other JSON grammar stays diagnostic. */
export function odataInvalidJsonDetails(source) {
  const text = String(source).trim();
  if (text.length <= 131072 && (text === "{" || /^\{\s*"(?:[^"\\]|\\.)*"\s*:\s*$/.test(text)))
    return { kind: "unreadable-stream" };
  return null;
}

/** Root shapes rejected before any record write. Nonempty arrays remain unqualified. */
export function odataRootDetails(value) {
  if (value === null || Array.isArray(value) && value.length === 0)
    return { kind: "root-node", actualNode: "EndOfInput", expectedNode: "StartObject" };
  if (typeof value === "number" || isExactNumeric(value))
    return { kind: "root-node", actualNode: "PrimitiveValue", expectedNode: "StartObject" };
  if (typeof value === "string") return { kind: "unexpected-token", token: value };
  if (value === true) return { kind: "unrecognized-token" };
  return null;
}

/** Only the explicit observed mode changes a supported reader's inner message. */
export function observedODataInnerMessage(error, mode = "diagnostic") {
  if (mode !== "odata-wrapper") return null;
  if (!["InvalidValue", "InvalidRequest", "INVALID_REQUEST"].includes(error?.code)) return null;
  const d = error?.[readerDetails];
  if (!d) return null;
  let message;
  switch (d.kind) {
    case "unreadable-stream": return PREFIX + "System.ArgumentException: Stream was not readable.";
    case "decimal-string":
      message = `Cannot convert a value to target type '${d.expectedType}' because of conflict between input format string/number and parameter 'IEEE754Compatible' false/true.`;
      break;
    case "property-node":
      message = `An unexpected '${d.actualNode}' node was found for property named '${d.property}' when reading from the JSON reader. A '${d.expectedNode}' node was expected.`;
      break;
    case "root-node":
      message = `An unexpected '${d.actualNode}' node was found when reading from the JSON reader. A '${d.expectedNode}' node was expected.`;
      break;
    case "unexpected-token": message = `Invalid JSON. Unexpected token '${d.token}'.`; break;
    case "unrecognized-token": message = "Invalid JSON. A token was not recognized in the JSON content."; break;
    case "primitive-type":
      message = `Cannot convert the literal '${d.literal}' to the expected type '${d.expectedType}'. ---> Microsoft.OData.ODataException: Cannot convert a value of type '${d.sourceType}' to the expected target type '${d.expectedType}'.`;
      break;
    case "primitive-format": {
      const cause = d.expectedType === "Edm.Guid"
        ? "Guid should contain 32 digits with 4 dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)."
        : d.expectedType === "Edm.DateTimeOffset"
          ? `The string '${d.literal}' is not a valid AllXsd value.`
          : "Input string was not in a correct format.";
      message = `Cannot convert the literal '${d.literal}' to the expected type '${d.expectedType}'. ---> System.FormatException: ${cause}`;
      break;
    }
    default: return null;
  }
  return PREFIX + "Microsoft.OData.ODataException: " + message;
}
