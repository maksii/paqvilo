// A finite draft-only browser probe. Drivers bind source-authored controls; no save or submission is performed.
export async function captureCanvasDraftInputContract(driver, fixture) {
  await driver.open();
  const rows = [
    { id: 'initial.single', value: await driver.read('single') },
    { id: 'initial.multi', value: await driver.read('multi') },
    { id: 'single.maxLength', value: await driver.maxLength('single') },
    { id: 'multi.maxLength', value: await driver.maxLength('multi') },
  ];
  await driver.write('single', fixture.single);
  await driver.write('multi', fixture.multi);
  rows.push(
    { id: 'edited.single', value: await driver.read('single') },
    { id: 'edited.multi', value: await driver.read('multi') },
  );
  await driver.cancel();
  rows.push({ id: 'cancel.requiresConfirmation', value: await driver.confirmationVisible() });
  await driver.keepEditing();
  rows.push(
    { id: 'retained.single', value: await driver.read('single') },
    { id: 'retained.multi', value: await driver.read('multi') },
  );
  await driver.cancel();
  await driver.discard();
  await driver.open();
  rows.push(
    { id: 'reset.single', value: await driver.read('single') },
    { id: 'reset.multi', value: await driver.read('multi') },
  );
  await driver.cancel();
  return rows;
}
