// Starts a new chat the way the sessions view does on the desktop: the header's three dots
// (#viewMoreBtn) exist on the phone only, so the wdio specs click the dormant #newSessionBtn
// node directly (its handler is bound at mount, same draft as Ctrl+N), once the daemon has
// enabled it. The project picker opens next; selectProjectRow picks the project.
export async function openNewChatPicker() {
  await browser.waitUntil(
    async () => browser.execute(() => {
      const b = document.getElementById("newSessionBtn");
      return !!b && !b.disabled;
    }),
    { timeout: 30000, interval: 500, timeoutMsg: "#newSessionBtn never got enabled" }
  );
  await browser.execute(() => document.getElementById("newSessionBtn").click());
}

// 2+ accounts with no default or binding: the first send is refused and the account picker opens
// (pending-pane-composer.ts), and the refused text is put back in the composer. Pick the first
// chip and resend. A no-op when no picker shows up within 2s.
export async function pickAccountIfAsked() {
  const modalChip = await $(".cam-modal-card [data-acc-id]");
  if (await modalChip.waitForExist({ timeout: 2000 }).then(() => true, () => false)) {
    await modalChip.click();
    await (await $(".session-composer .composer-send")).click();
  }
}

// A new draft starts with "Use subchats" on (draft-subchats.ts): a quiet chat that draws only
// send_message cards, with the model moved to Opus. The specs that exercise a plain chat (a text
// reply, the transcript rows) switch it off for their one chat, the way a user would.
export async function turnSubchatsOff() {
  const sel = "#session-pane .draft-subchats input, .draft-subchats-card input";
  await browser.waitUntil(async () => browser.execute((s) => !!document.querySelector(s), sel), {
    timeout: 20000,
    timeoutMsg: "the draft's Use subchats switch never appeared",
  });
  await browser.execute((s) => {
    for (const input of document.querySelectorAll(s)) if (input.checked) input.click();
  }, sel);
}
