// Public upstream provenance, not a local test receipt or native-platform evidence.
export const analysisSources = Object.freeze(
  [
    {
      repository: 'microsoft/power-cat-skills',
      commit: 'efa90b315bb4e2897f24ad12eb7a8391944b09a4',
      reviewedDate: '2026-11-06',
      license: 'MIT',
      use: 'review guidance; independently implemented rules',
    },
    {
      repository: 'microsoft/power-platform-skills',
      commit: '3ffa5b8fca9016ae9635a4690eece1cd18ab295f',
      reviewedDate: '2026-11-06',
      license: 'MIT',
      use: 'review guidance and performance catalogue; independently implemented rules',
    },
    {
      repository: 'OOlashyn/pageslens',
      commit: '7e0cb81890b0421c23f5dca905e7e811a34c8b1a',
      reviewedDate: '2026-11-05',
      license: 'MIT',
      use: 'ecosystem comparison; no code imported',
    },
    {
      repository: 'DFE-Digital/power-pages-security-utils',
      commit: 'a50240b58081ec9ae2be362da589dd3bbc4466ab',
      reviewedDate: '2026-11-05',
      license: 'not-detected',
      use: 'research only; no code imported or scanner executed',
    },
    {
      repository: 'djwmobley/dataverse-linter',
      commit: '5403f81011b096d00ca7139f0e6fe92499551b34',
      reviewedDate: '2026-11-05',
      license: 'MIT',
      use: 'ecosystem comparison; no code imported',
    },
    {
      repository: 'microsoft/power-platform-playwright-samples',
      commit: '3233f3e73e30960e8ab7349f1cb06b520ca010e4',
      reviewedDate: '2026-11-05',
      license: 'MIT',
      use: 'testing guidance; no code imported',
    },
    {
      repository: 'microsoft/powerplatform-actions',
      commit: '6e91314a9c6e694ea5c894fe8c40e09d73aa892b',
      reviewedDate: '2026-11-05',
      license: 'MIT',
      use: 'external checker and ALM boundaries; no action executed',
    },
    {
      repository: 'microsoft/powerplatform-cli-wrapper',
      commit: '961514655ca3b00d45f6dfff42b12806b6480257',
      reviewedDate: '2026-11-05',
      license: 'MIT',
      use: 'tool/version guidance; no package imported',
    },
    {
      repository: 'microsoft/PowerApps-Tooling',
      commit: '27c396b37f2f6c8b1f011a267594176c09559584',
      reviewedDate: '2026-11-05',
      license: 'MIT',
      use: 'legacy tooling caveats; no code imported',
    },
  ].map((source) => Object.freeze(source)),
);
