// @vitest-environment jsdom

// The chip's Edit row hands the item to the composer and leaves it scheduled:
// it must never delete it (the old edit flow deleted first, so abandoning the
// edit lost the message). Delete is the only row that calls schedule_delete.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));

const { ScheduledChip } = await import("../src/shared/chat/scheduled-chip.ts");

const ITEM = {
  id: "s1",
  prompt: "remind me",
  fire_at: "2030-01-01T10:00:00Z",
  status: { type: "pending" },
  recurrence: null,
  kind: { type: "message", session_id: "sess-1", cwd: "." },
};

let root;
let chip;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd) => (cmd === "schedule_list" ? [ITEM] : undefined));
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  chip?.destroy();
  root.remove();
});

async function openDropdown(onEdit) {
  chip = new ScheduledChip({ root, sessionId: "sess-1", onEdit });
  await vi.waitFor(() => expect(root.querySelector(".scheduled-chip")).not.toBeNull());
  root.querySelector(".scheduled-chip").click();
  await vi.waitFor(() => expect(document.querySelector(".scheduled-row")).not.toBeNull());
}

const deleteCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "schedule_delete");

describe("ScheduledChip Edit row", () => {
  it("hands the item to onEdit, closes the dropdown and never deletes it", async () => {
    const onEdit = vi.fn();
    await openDropdown(onEdit);

    document.querySelector(".scheduled-row-edit").click();

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0]).toMatchObject({ id: "s1", prompt: "remind me" });
    expect(deleteCalls()).toEqual([]);
    expect(document.querySelector(".scheduled-dropdown")).toBeNull();
  });

  it("the Delete row is what calls schedule_delete", async () => {
    const onEdit = vi.fn();
    await openDropdown(onEdit);

    document.querySelector(".scheduled-row-delete").click();

    await vi.waitFor(() => expect(deleteCalls()).toEqual([["schedule_delete", { id: "s1" }]]));
    expect(onEdit).not.toHaveBeenCalled();
  });
});
