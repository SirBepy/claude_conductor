// @vitest-environment jsdom

// The project settings rail's Model and Effort sliders: the stop matching the
// global default carries a star, landing on it unpins the project (saves null),
// a revert arrow shows while pinned, and a failed save glides the thumb back.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listProjects: vi.fn(),
    getSettings: vi.fn(),
    ensureProject: vi.fn(),
    updateProject: vi.fn(),
  },
}));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../src/views/sessions/new-session-cache.ts", () => ({
  projectsListData: () => ({ ready: Promise.resolve() }),
}));

const { mountValueSlider } = await import("../src/views/sessions/project-dashboard/project-config/value-slider.ts");
const { renderChatDefaultsRow } = await import("../src/views/sessions/project-dashboard/project-config/chat-defaults-row.ts");

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("mountValueSlider", () => {
  let host;
  beforeEach(() => {
    document.body.innerHTML = "<div id='h'></div>";
    host = document.getElementById("h");
  });
  const mount = (extra = {}) => {
    const onCommit = vi.fn();
    const onChange = vi.fn();
    const slider = mountValueSlider(host, { label: "L", stops: ["a", "b", "c", "d"], index: 1, onCommit, onChange, ...extra });
    return { slider, onCommit, onChange };
  };
  const stop = (i) => host.querySelectorAll(".vs-stop")[i];
  const key = (k) => host.querySelector(".vs-wrap").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  it("stars the default stop and names it in the tooltip", () => {
    mount({ defaultIndex: 2, defaultHint: "Default: follows Settings" });
    expect(host.querySelectorAll(".vs-star").length).toBe(1);
    expect(stop(2).querySelector(".vs-star")).not.toBeNull();
    expect(stop(2).title).toBe("Default: follows Settings");
  });

  it("reports the first paint and commits a clicked stop once", () => {
    const { onCommit, onChange } = mount();
    expect(onChange).toHaveBeenCalledWith(1);
    stop(3).click();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(3);
    expect(stop(3).classList.contains("active")).toBe(true);
    stop(3).click();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("steps with the arrow keys, Home and End, and stops at the ends", () => {
    const { onCommit } = mount();
    key("ArrowRight");
    key("End");
    key("ArrowRight");
    key("Home");
    key("ArrowLeft");
    expect(onCommit.mock.calls.map((c) => c[0])).toEqual([2, 3, 0]);
  });

  it("set() moves the thumb and reports it without committing", () => {
    const { slider, onCommit, onChange } = mount();
    slider.set(0);
    expect(onChange).toHaveBeenLastCalledWith(0);
    expect(stop(0).classList.contains("active")).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
  });

  // jsdom has neither PointerEvent nor pointer capture; a MouseEvent of the
  // pointer type carries the button, buttons and clientX the handlers read.
  const pointer = (type, init = {}) => {
    const wrap = host.querySelector(".vs-wrap");
    wrap.setPointerCapture = () => {};
    // 4 stops over a 300px track: x of 0 / 100 / 200 / 300 hits stop 0 / 1 / 2 / 3.
    host.querySelector(".vs-track").getBoundingClientRect = () => ({ left: 0, width: 300 });
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init });
    ev.pointerId = 1;
    wrap.dispatchEvent(ev);
  };

  it("a primary-button drag commits the stop it is released on", () => {
    const { onCommit } = mount();
    pointer("pointerdown", { clientX: 100 });
    pointer("pointerup", { clientX: 300 });
    expect(onCommit).toHaveBeenCalledWith(3);
  });

  it("a non-primary pointer button starts no drag and commits nothing", () => {
    const { onCommit } = mount();
    pointer("pointerdown", { button: 2, buttons: 2, clientX: 300 });
    expect(host.querySelector(".vs-wrap").classList.contains("is-drag")).toBe(false);
    pointer("pointerup", { button: 2, buttons: 0, clientX: 300 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a hover with no button held ends a drag whose pointerup was lost", () => {
    const { onCommit } = mount();
    pointer("pointerdown", { clientX: 100 });
    pointer("pointermove", { buttons: 0, clientX: 300 });
    expect(host.querySelector(".vs-wrap").classList.contains("is-drag")).toBe(false);
    expect(stop(1).classList.contains("active")).toBe(true);
    pointer("pointerup", { buttons: 0, clientX: 300 });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("project settings model and effort sliders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSettings.mockResolvedValue({ defaultModel: "sonnet", defaultEffort: "high" });
    apiMock.updateProject.mockResolvedValue(undefined);
    document.body.innerHTML = `
      <div class="ps-field"><button id="chatDefaultModelRevert"></button><div id="chatDefaultModelControl"></div></div>
      <div class="ps-field"><button id="chatDefaultEffortRevert"></button><div id="chatDefaultEffortControl"></div></div>`;
  });
  const modelStop = (label) => [...document.querySelectorAll("#chatDefaultModelControl .vs-stop")].find((e) => e.textContent.toLowerCase().includes(label));
  const field = (id) => document.getElementById(id).closest(".ps-field");

  it("lists only real values, stars the global default and shows the arrow while pinned", async () => {
    apiMock.listProjects.mockResolvedValue([{ id: "p1", path: "C:/proj", default_model: "opus" }]);
    await renderChatDefaultsRow("C:/proj");
    expect(modelStop("default")).toBeUndefined();
    expect(modelStop("sonnet").querySelector(".vs-star")).not.toBeNull();
    expect(modelStop("opus").classList.contains("active")).toBe(true);
    expect(field("chatDefaultModelControl").classList.contains("is-changed")).toBe(true);
    // The effort is unpinned: it sits on the starred global default with no arrow.
    expect(document.querySelector("#chatDefaultEffortControl .vs-stop.active .vs-star")).not.toBeNull();
    expect(field("chatDefaultEffortControl").classList.contains("is-changed")).toBe(false);
  });

  it("saves null when the default stop is picked, and the pinned value otherwise", async () => {
    apiMock.listProjects.mockResolvedValue([{ id: "p1", path: "C:/proj", default_model: "opus" }]);
    await renderChatDefaultsRow("C:/proj");
    modelStop("sonnet").click();
    await flush();
    expect(apiMock.updateProject).toHaveBeenLastCalledWith("p1", { default_model: null });
    modelStop("haiku").click();
    await flush();
    expect(apiMock.updateProject).toHaveBeenLastCalledWith("p1", { default_model: "haiku" });
  });

  it("the revert arrow unpins and hides itself", async () => {
    apiMock.listProjects.mockResolvedValue([{ id: "p1", path: "C:/proj", default_model: "opus" }]);
    await renderChatDefaultsRow("C:/proj");
    document.getElementById("chatDefaultModelRevert").click();
    await flush();
    expect(apiMock.updateProject).toHaveBeenLastCalledWith("p1", { default_model: null });
    expect(modelStop("sonnet").classList.contains("active")).toBe(true);
    expect(field("chatDefaultModelControl").classList.contains("is-changed")).toBe(false);
  });

  it("a failed save puts the thumb back on the saved value", async () => {
    apiMock.listProjects.mockResolvedValue([{ id: "p1", path: "C:/proj", default_model: "opus" }]);
    apiMock.updateProject.mockRejectedValue(new Error("nope"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderChatDefaultsRow("C:/proj");
    modelStop("haiku").click();
    await flush();
    expect(modelStop("opus").classList.contains("active")).toBe(true);
  });

  it("an older failed save does not pull the thumb off a newer value that saved", async () => {
    apiMock.listProjects.mockResolvedValue([{ id: "p1", path: "C:/proj", default_model: "opus" }]);
    apiMock.updateProject.mockRejectedValueOnce(new Error("nope")).mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderChatDefaultsRow("C:/proj");
    modelStop("haiku").click();
    modelStop("sonnet").click();
    await flush();
    await flush();
    expect(apiMock.updateProject).toHaveBeenCalledTimes(2);
    expect(apiMock.updateProject).toHaveBeenLastCalledWith("p1", { default_model: null });
    expect(modelStop("sonnet").classList.contains("active")).toBe(true);
  });

  it("a newer failed save reverts to the value the older save persisted", async () => {
    apiMock.listProjects.mockResolvedValue([{ id: "p1", path: "C:/proj", default_model: "opus" }]);
    apiMock.updateProject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("nope"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderChatDefaultsRow("C:/proj");
    modelStop("haiku").click();
    modelStop("sonnet").click();
    await flush();
    await flush();
    expect(modelStop("haiku").classList.contains("active")).toBe(true);
  });

  it("the revert arrow is disabled, so out of the Tab order, while unpinned", async () => {
    apiMock.listProjects.mockResolvedValue([{ id: "p1", path: "C:/proj", default_model: "opus" }]);
    await renderChatDefaultsRow("C:/proj");
    const arrow = (id) => document.getElementById(id);
    expect(arrow("chatDefaultModelRevert").disabled).toBe(false);
    expect(arrow("chatDefaultEffortRevert").disabled).toBe(true);
    arrow("chatDefaultModelRevert").click();
    await flush();
    expect(arrow("chatDefaultModelRevert").disabled).toBe(true);
  });
});
