// Ordinary original-DLL cases include CLR startup and nested SDK observer RPCs.
// Give those semantic checks the existing runtime's maximum supported budget
// under parallel Windows CI. Intentional timeout cases override this explicitly.
export const ORDINARY_CLR_TIMEOUT_MS = 10_000;
