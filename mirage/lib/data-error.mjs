/** Store and query failures carry an HTTP-style status and a stable code. */
export class DataError extends Error {
  constructor(message, status = 400, code = "InvalidRequest", details) {
    super(message);
    this.name = "DataError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    // Optional Dataverse-style diagnostics (for example an inner error code)
    // used only by the public Web API error envelope.
    if (details !== undefined) this.details = details;
  }
}
