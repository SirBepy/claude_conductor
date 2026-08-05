interface ToastOptions {
  onClick?: () => void;
  ttlMs?: number;
}

/** Build, show, and auto-dismiss one clickable toast in `#toastStack` (static
 * host in index.html, so every window that loads it - main, chats, schedule,
 * detached sessions - gets one). Stacked, animated (rAF fade/slide-in, then
 * `.leaving` fade-out). No-op if the stack host isn't in the DOM. */
export function showToast(text: string, opts?: ToastOptions): void {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const ttlMs = opts?.ttlMs ?? 5000;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span class="toast-msg"></span>`;
  const msg = toast.querySelector(".toast-msg");
  if (msg) msg.textContent = text;
  if (opts?.onClick) toast.onclick = opts.onClick;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => toast.classList.add("leaving"), ttlMs);
  setTimeout(() => toast.remove(), ttlMs + 300);
}
