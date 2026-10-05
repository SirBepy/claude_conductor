// WebView2 maps Ctrl+P to the browser print dialog, which only ever prints the
// app's own chrome. Capture phase, so a handler that stops propagation further
// down can't let it through; the shortcuts dispatcher still sees the key and
// runs Ctrl+P's own binding (Go to file).

export function installPrintBlock(): void {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "p") e.preventDefault();
  }, true);
}
