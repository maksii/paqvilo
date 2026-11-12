// Route bookkeeping for a hand-written browser context fake: route and unroute store and remove handlers by pattern and
// handler, as Playwright's BrowserContext does. Routing order and fallback are the caller's to play, as in a test's own fire().
export function withContextRoutes(context) {
  const routes = [];
  return Object.assign(context, {
    routes,
    async route(pattern, handler) {
      routes.push({ pattern, handler });
    },
    async unroute(pattern, handler) {
      const index = routes.findIndex((item) => item.pattern === pattern && item.handler === handler);
      if (index >= 0) routes.splice(index, 1);
    },
  });
}
