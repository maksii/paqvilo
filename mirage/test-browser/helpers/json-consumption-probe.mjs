/** Test-only observer for proving that a matched response body was consumed. */
export async function installJsonConsumptionProbe(page, { key, pathname, query, ignoreSignal = false }) {
  if (typeof key !== 'string' || !key) throw new TypeError('A unique browser probe key is required.');
  if (typeof pathname !== 'string' || !pathname.startsWith('/'))
    throw new TypeError('The probe pathname must be absolute.');
  if (!query || typeof query !== 'object' || Array.isArray(query))
    throw new TypeError('The probe query must be a JSON object subset.');

  await page.evaluate(
    ({ key, pathname, query, ignoreSignal }) => {
      if (window[key]) throw new Error(`JSON consumption probe already exists: ${key}`);
      const probe = {
        armed: false,
        matchedFetches: 0,
        successfulJsonConsumptions: 0,
        consumedAfterContinuations: 0,
        errors: 0,
        pathname,
        query,
        ignoreSignal,
        originalFetch: window.fetch,
      };
      probe.matches = (input, init) => {
        try {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
            location.href,
          );
          const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
          if (method !== 'GET' || url.pathname !== probe.pathname) return false;
          const actual = JSON.parse(url.searchParams.get('query') ?? 'null');
          return (
            actual &&
            typeof actual === 'object' &&
            Object.entries(probe.query).every(([name, value]) => actual[name] === value)
          );
        } catch {
          return false;
        }
      };
      window.fetch = function (...args) {
        const init = args[1];
        if (!probe.armed || !probe.matches(args[0], init)) return Reflect.apply(probe.originalFetch, this, args);

        probe.matchedFetches++;
        if (probe.ignoreSignal && init && typeof init === 'object') {
          args[1] = { ...init };
          delete args[1].signal;
        }
        return Reflect.apply(probe.originalFetch, this, args).then(
          (response) => {
            const originalJson = response.json;
            response.json = function (...jsonArgs) {
              const jsonPromise = Reflect.apply(originalJson, this, jsonArgs);
              jsonPromise.then(
                () => {
                  probe.successfulJsonConsumptions++;
                  setTimeout(() => probe.consumedAfterContinuations++, 0);
                },
                () => probe.errors++,
              );
              return jsonPromise;
            };
            return response;
          },
          (error) => {
            probe.errors++;
            throw error;
          },
        );
      };
      window[key] = probe;
    },
    { key, pathname, query, ignoreSignal },
  );

  const invoke = (operation) =>
    page.evaluate(
      ({ key, operation }) => {
        const probe = window[key];
        if (!probe) return null;
        if (operation === 'arm') probe.armed = true;
        else if (operation === 'disarm') probe.armed = false;
        else if (operation === 'counts')
          return {
            matchedFetches: probe.matchedFetches,
            successfulJsonConsumptions: probe.successfulJsonConsumptions,
            consumedAfterContinuations: probe.consumedAfterContinuations,
            errors: probe.errors,
          };
        else if (operation === 'restore') {
          probe.armed = false;
          window.fetch = probe.originalFetch;
          delete window[key];
        }
        return true;
      },
      { key, operation },
    );

  return {
    arm: () => invoke('arm'),
    disarm: () => invoke('disarm'),
    counts: () => invoke('counts'),
    waitForCompletion: () =>
      page.waitForFunction((probeKey) => {
        const probe = window[probeKey];
        return probe && probe.matchedFetches > 0 && (probe.errors > 0 || probe.consumedAfterContinuations > 0);
      }, key),
    restore: async () => {
      if (!page.isClosed()) await invoke('restore');
    },
  };
}
