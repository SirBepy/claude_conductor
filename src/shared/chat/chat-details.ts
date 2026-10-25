// Drillable details Claude attaches to a send_message / update_message call.
// Kept free of renderer imports so the event mappers can use it without a cycle
// through chat-transforms.

export interface ChatDetail {
  id: string;
  label: string;
  body_md: string;
}

/** Reads `details` off a tool_use input; malformed entries are dropped rather
 *  than failing the whole message, since the text itself still renders. */
export function parseDetails(input: unknown): ChatDetail[] | undefined {
  const raw = (input as { details?: unknown } | null)?.details;
  if (!Array.isArray(raw)) return undefined;
  const out: ChatDetail[] = [];
  for (const d of raw) {
    const { id, label, body_md } = (d ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || typeof body_md !== "string") continue;
    out.push({ id, label: typeof label === "string" ? label : id, body_md });
  }
  // An explicit empty list is kept (not undefined): update_message uses it to
  // clear earlier details, while an absent key keeps them.
  return out;
}
