/**
 * Waits until the setup page's notice carries `text`. The page hides a confirmation five seconds after showing it and
 * keeps its text until the next notice, so the wait reads the text and not the visibility: a host that takes longer
 * than that to look still finds the confirmation. Call it after the action whose notice replaces the previous one.
 */
export function setupNotice(page, text) {
  return page.locator('#notice').filter({ hasText: text }).waitFor({ state: 'attached' });
}
