/** Answer a route with `action()`. A failure is ignored only when its context is closed, or when the route's page was
 * reached and reports `isClosed() === true`. A page that cannot be reached, or whose closed state cannot be read, is not
 * treated as closed, so the failure is rethrown. Any other failure is rethrown. */
const pageIsClosed = (route) => {
  try {
    return route.request().frame().page().isClosed() === true;
  } catch {
    return false;
  }
};

export async function answerRoute(route, action, { contextClosed = () => false } = {}) {
  try {
    await action();
  } catch (error) {
    if (!pageIsClosed(route) && !contextClosed()) throw error;
  }
}
