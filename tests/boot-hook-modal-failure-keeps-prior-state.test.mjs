// @vitest-environment jsdom

// Todo 1001, caller-change half: boot.ts's maybeShowHookModal() had no
// try/catch at all around api.getHookRegistrationState(), which used to
// swallow a failed get_hook_registration_state call to
// {registered:false, declined:false, port:null} - identical to "never
// registered, never declined". That value gates the register-hooks
// onboarding nag, so a failed read used to re-show it as if the user had
// made no choice. Now that getHookRegistrationState rejects on failure,
// prove the decision (show/hide the nag) is NOT taken from the failed read:
// the modal stays in its prior (hidden) state instead of popping open.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/transport.ts", () => ({
  isRemote: () => false,
  isTauri: () => true,
}));

// The rest of boot.ts's import graph (dashboard/projects/sessions views,
// shortcuts, etc.) is irrelevant to maybeShowHookModal - stub it out so this
// test doesn't drag in the whole app's chat/render stack.
vi.mock("../src/views/dashboard/dashboard.ts", () => ({ refreshDashboardView: () => {} }));
vi.mock("../src/views/projects/projects.ts", () => ({ renderProjectsList: () => {} }));
vi.mock("../src/views/project-detail/project-detail.ts", () => ({ renderProjectDetailContent: () => {} }));
vi.mock("../src/shared/shortcuts.ts", () => ({ register: () => {} }));
vi.mock("../src/views/sessions/sessions.ts", () => ({ triggerNewSessionGlobal: () => {} }));
vi.mock("../src/shared/navigation.ts", () => ({ showView: () => {} }));
vi.mock("../src/shared/initial-render-gate.ts", () => ({ wireInitialFetches: () => {} }));
vi.mock("../src/shared/boot-progress.ts", () => ({ mountBootProgress: () => ({ done: () => {} }) }));
vi.mock("../src/shared/background-fx.ts", () => ({ applyBackgroundFx: () => {} }));
vi.mock("../src/views/sessions/new-session-cache.ts", () => ({ warmNewSessionCache: () => {} }));
vi.mock("../src/shared/token-history.ts", () => ({
  loadTokenHistory: async () => [],
  mergeLiveSessions: () => [],
}));

const { maybeShowHookModal } = await import("../src/shared/boot.ts");

beforeEach(() => {
  invokeMock.mockReset();
  document.body.innerHTML = `
    <div class="modal-backdrop" id="hookModalBackdrop" style="display:none"></div>
    <div class="modal" id="hookModal" style="display:none">
      <div class="modal-preview" id="hookModalPreview">Loading…</div>
    </div>
  `;
});

describe("boot.maybeShowHookModal - a failed read does not decide the nag's visibility", () => {
  it("leaves the modal hidden (its prior state) when get_hook_registration_state rejects", async () => {
    invokeMock.mockRejectedValue(new Error("backend unreachable"));

    await maybeShowHookModal();

    expect(document.getElementById("hookModal").style.display).toBe("none");
    expect(document.getElementById("hookModalBackdrop").style.display).toBe("none");
  });

  it("still shows the modal when the read succeeds and hooks are genuinely unregistered", async () => {
    invokeMock.mockResolvedValue({ registered: false, declined: false, port: 4317 });

    await maybeShowHookModal();

    expect(document.getElementById("hookModal").style.display).toBe("block");
    expect(document.getElementById("hookModalBackdrop").style.display).toBe("block");
  });

  it("stays hidden when the read succeeds and the user already registered", async () => {
    invokeMock.mockResolvedValue({ registered: true, declined: false, port: 4317 });

    await maybeShowHookModal();

    expect(document.getElementById("hookModal").style.display).toBe("none");
  });
});
