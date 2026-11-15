import type { Plugin } from 'vite';

export interface CodeAppsViteOptions {
  /** Registered project app name. mirage dev supplies PAQVILO_CODE_APP. */
  app?: string;
  /** Runtime origin. mirage dev supplies PAQVILO_MIRAGE_URL. */
  mirageUrl?: string;
  config?: string;
  /** Explicit development mode; defaults to mirage. Managed commands enable it through their environment. */
  mode?: string;
  enabled?: boolean;
}

/** Active for development serving only; production builds retain Microsoft's SDK integration. */
export function codeApps(options?: CodeAppsViteOptions): Plugin;
