// Ordinary original-DLL cases run under the product's own limit, the native two minutes: a shorter budget would
// race CLR start-up and nested host starts. Intentional timeout cases pass their own small value.
export const ORDINARY_CLR_TIMEOUT_MS = 120_000;
