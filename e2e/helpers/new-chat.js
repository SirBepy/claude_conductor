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
