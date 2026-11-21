// Sets the address of the frame element matched by selector and returns the navigated frame once its document is
// parsed. The navigation listener is registered before the address changes, so the event cannot be missed. Markup
// written into the frame before this returns goes to the document the navigation replaces, and a wait for that
// markup never ends.
export async function navigateFrame(page, selector, address) {
  const target = new URL(address, page.url()).href;
  const navigated = page.waitForEvent('framenavigated', { predicate: (frame) => frame.url() === target });
  await page.locator(selector).evaluate((frame, address) => (frame.src = address), address);
  const frame = await navigated;
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}
