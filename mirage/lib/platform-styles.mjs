export function platformStylesStatus(profile) {
  return profile?.platformStyles ?? { mode: 'placeholder', structuralDefault: true, missingHeadStylesheets: [] };
}

export function formStyleDiagnostics(html, profile) {
  if (!/crmEntityFormView|<!--pp-native-form-->/.test(html)) return [];
  const status = platformStylesStatus(profile);
  return status.mode === 'captured'
    ? []
    : [
        {
          code: 'PLATFORM_STYLES_PLACEHOLDER',
          severity: 'warning',
          message:
            'Platform stylesheets are placeholders with local structural form rules. Use paqvilo mirage capture-shell to capture the site styles.',
        },
      ];
}
