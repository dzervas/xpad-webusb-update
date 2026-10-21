/**
 * Page shell: controller tabs, auto-detection and flow switching.
 *
 * Each controller owns its protocol and DOM in src/controllers/. This file only
 * decides which flow/help is visible and how a connected controller is detected.
 */

import { createGulikitTool } from "./controllers/gulikit.js";
import { createXboxTool } from "./controllers/xbox.js";
import type { ControllerId, ControllerTool, Detection } from "./controllers/types.js";
import { byId, setStatus } from "./ui.js";

type Mode = "auto" | ControllerId;

const tabsRoot = byId<HTMLElement>("controller-tabs");
const detectStatus = byId<HTMLElement>("controller-detect");
const browserWarning = byId<HTMLElement>("browser-warning");

const tools: ControllerTool[] = [createXboxTool(), createGulikitTool()];
const toolById = new Map(tools.map((tool) => [tool.id, tool]));
const tabs: HTMLButtonElement[] = [];

let mode: Mode = "auto";
let active: ControllerId = "xbox";
let detecting = false;

function addTab(id: Mode, label: string): void {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "seg-tab";
  tab.dataset.controllerTab = id;
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "false");
  tab.textContent = label;
  tabsRoot.append(tab);
  tabs.push(tab);
}

addTab("auto", "Auto");
for (const tool of tools) {
  addTab(tool.id, tool.tabLabel);
  tool.flow.hidden = true;
  tool.help.hidden = true;
}

function showTool(id: ControllerId): void {
  if (active !== id) {
    toolById.get(active)?.deactivate();
    active = id;
  }
  for (const tool of tools) {
    const visible = tool.id === id;
    tool.flow.hidden = !visible;
    tool.help.hidden = !visible;
  }
  for (const tab of tabs) {
    const selected =
      mode === "auto" ? tab.dataset.controllerTab === "auto" : tab.dataset.controllerTab === mode;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
  }
  toolById.get(id)?.activate();
}

function renderDetection(detected: ControllerId | null, detail: string): void {
  for (const tab of tabs) {
    const id = tab.dataset.controllerTab;
    const isDetected = id === detected;
    tab.classList.toggle("detected", isDetected);
    if (isDetected) tab.dataset.detectedLabel = "detected";
    else delete tab.dataset.detectedLabel;
  }

  if (mode === "auto") {
    if (detected) {
      setStatus(
        detectStatus,
        `Auto-detected ${toolById.get(detected)?.tabLabel ?? detected}.${detail ? ` ${detail}` : ""}`,
        "ok",
      );
    } else {
      setStatus(
        detectStatus,
        `No controller detected. Showing ${toolById.get(active)?.tabLabel ?? active}; ` +
          "connect one, or choose a tab. GuliKit update mode is a mounted drive, so it is " +
          "selected manually.",
        "",
      );
    }
  } else {
    setStatus(
      detectStatus,
      `Manual selection: ${toolById.get(mode)?.tabLabel ?? mode}.` +
        (detected ? ` ${toolById.get(detected)?.tabLabel ?? detected} is also detected.` : ""),
      "",
    );
  }
}

async function detect(): Promise<{ id: ControllerId; detail: string } | null> {
  const results: Array<{ id: ControllerId; detection: Detection }> = [];
  for (const tool of tools) {
    try {
      results.push({ id: tool.id, detection: await tool.detect() });
    } catch {
      results.push({ id: tool.id, detection: { detected: false, detail: "" } });
    }
  }
  const match = results.find((result) => result.detection.detected);
  return match ? { id: match.id, detail: match.detection.detail } : null;
}

async function refreshDetection(): Promise<void> {
  if (detecting) return;
  detecting = true;
  try {
    const match = await detect();
    if (mode === "auto" && match) active = match.id;
    renderDetection(match?.id ?? null, match?.detail ?? "");
    if (mode === "auto") showTool(active);
  } finally {
    detecting = false;
  }
}

function selectMode(next: Mode): void {
  mode = next;
  if (next !== "auto") active = next;
  showTool(active);
  void refreshDetection();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    const next = tab.dataset.controllerTab as Mode | undefined;
    if (next) selectMode(next);
  });
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = tabs.indexOf(tab);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const target = tabs[(current + delta + tabs.length) % tabs.length];
    target.focus();
    target.click();
  });
}

if ("usb" in navigator) {
  navigator.usb.addEventListener("connect", () => {
    void refreshDetection();
  });
  navigator.usb.addEventListener("disconnect", () => {
    void refreshDetection();
  });
} else {
  browserWarning.hidden = false;
  browserWarning.textContent =
    "This browser does not expose navigator.usb, so Xbox updates are unavailable. " +
    "The GuliKit drive-copy flow needs a Chromium browser with the File System Access API.";
}

window.addEventListener("gamepadconnected", () => {
  void refreshDetection();
});
window.addEventListener("gamepaddisconnected", () => {
  void refreshDetection();
});

showTool(active);
renderDetection(null, "");
void refreshDetection();

// Keep detection warm if a controller enumerates after the page has loaded.
setInterval(() => {
  if (mode === "auto") void refreshDetection();
}, 4000);
