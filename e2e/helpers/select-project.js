// Filters the picker by name and clicks the sole match, so a bare first-row
// click can never land real claude turns in whatever sorts first (todo 865).
export async function selectProjectRow(name) {
  const search = await $("#project-picker-search");
  await search.waitForExist({ timeout: 10000 });
  await search.setValue(name);

  // Spread first: wdio v9's element array has its own chainable `map`, which
  // returns a thenable Promise.all cannot iterate. Same pattern as
  // multi-account.e2e.js:149.
  const rows = [...(await $$(".project-picker-row"))];
  const names = await Promise.all(
    rows.map((row) => row.$(".project-picker-name").then((el) => el.getText()))
  );
  const idx = names.indexOf(name);
  if (idx === -1) {
    throw new Error(
      `selectProjectRow: no project-picker row named "${name}" after filtering; saw: ${JSON.stringify(names)}`
    );
  }
  await rows[idx].click();
}
