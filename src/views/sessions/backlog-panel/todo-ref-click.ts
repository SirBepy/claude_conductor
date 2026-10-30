// A todo id mentioned in chat (`pc-0007`) opens that todo in the Backlog panel.
// The markdown pass (markTodoRefs in shared/chat/markdown-highlight.ts) wraps
// every id-shaped word in a span; one delegated listener, installed by the
// sessions view, turns a click on it into the open request. Whether the id
// names a real todo is only known to the panel, which says so quietly when it
// does not.

import { requestTodoOpen } from "./backlog-open-event";

export function handleTodoRefClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0) return;
  const el = (e.target as Element | null)?.closest<HTMLElement>(".todo-ref");
  const id = el?.dataset.todoId;
  if (!id) return;
  // A selection drag that ends on the id is not a click on it.
  if (window.getSelection()?.toString()) return;
  e.preventDefault();
  requestTodoOpen(id);
}
