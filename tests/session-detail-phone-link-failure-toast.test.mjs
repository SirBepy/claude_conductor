// @vitest-environment jsdom
//
// Todo 1017, caller-change half: session-detail.ts's phone-link action
// already has a try/catch around api.phoneLink() that shows a distinct
// "phone failed: ..." toast on rejection, but that catch was unreachable
// because phoneLink used to swallow a failed phone_link call to null -
// identical to the legitimate "no phone link yet" result, which shows
// "Phone link not available yet." instead. Now that phoneLink rejects, prove
// the two cases produce different toasts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toastMock(...a) }));

const { renderSessionDetailView } = await import("../src/views/session-detail/session-detail.ts");
const { setCurrentSessionRecord } = await import("../src/shared/state.ts");

const flush = () => new Promise((r) => setTimeout(r, 0));

const liveRecordWithPhone = {
  session_id: "live-1",
  kind: "automated",
  bridge_session_id: "bridge-1",
  started_at: "2024-01-01T00:00:00Z",
};

beforeEach(() => {
  invokeMock.mockReset();
  toastMock.mockReset();
  document.body.innerHTML = "";
});

async function clickPhoneButton(root) {
  const btn = root.ownerDocument.getElementById("session-detail-actions")
    .querySelector('[data-act="phone"]');
  btn.onclick();
  await flush();
  await flush();
}

describe("session-detail phone action - failure gets a distinct toast from 'not available yet'", () => {
  it("shows a failure toast, not the not-available-yet message, when phone_link rejects", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "phone_link") return Promise.reject(new Error("backend unreachable"));
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
    setCurrentSessionRecord(liveRecordWithPhone);

    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderSessionDetailView(root);
    await clickPhoneButton(root);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toMatch(/phone failed/i);
    expect(toastMock.mock.calls[0][0]).not.toMatch(/not available yet/i);
  });

  it("still shows the not-available-yet message when there genuinely is no link", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "phone_link") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
    setCurrentSessionRecord(liveRecordWithPhone);

    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderSessionDetailView(root);
    await clickPhoneButton(root);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toMatch(/not available yet/i);
  });
});
