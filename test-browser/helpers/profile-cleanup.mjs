// fs.rm options for a directory that held a Chromium profile. With the Windows sandbox
// (lense launches owned browsers sandboxed on win32), browser processes keep profile files
// such as chrome_debug.log open for seconds after close() resolves; 2-12 s was measured on a
// loaded Windows host. Node retries EBUSY/EPERM/ENOTEMPTY with a linearly growing delay, so
// these values allow up to ~32 s before the cleanup reports the directory as still in use.
export const PROFILE_RELEASE_RETRIES = Object.freeze({ maxRetries: 25, retryDelay: 100 });
