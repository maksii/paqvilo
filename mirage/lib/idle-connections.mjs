// An idle connection of a local listener is closed by its client, or by the listener's close(): never by the listener
// after an elapsed time. A timed close races the next request a client writes on the pooled connection (the request is
// reset, and a POST is not resent); a client whose own idle timer ran late on a busy host loses that race.
// Every listener that uses this ends its connections in close() (closeAllConnections), so no idle one holds it open.
export function keepIdleConnections(server) {
  server.keepAliveTimeout = 0;
  return server;
}
