/**
 * Xbox controller tool: connect over WebUSB, read GIP/UFU versions, load
 * Microsoft's signed RDHM package and flash it.
 *
 * The GIP transport lives in frame.ts/ufu.ts/updater.ts/usb.ts; this module owns
 * only the Xbox flow and DOM.
 */

import {
  FEED_URL,
  downloadFirmware,
  expectedHash,
  fetchFeed,
  fileVersion,
  findFeedDevice,
  sha256Base64Url,
  type Feed,
  type FeedDevice,
  type FeedFile,
} from "../feed.js";
import {
  DEFAULT_OPTIONS,
  Updater,
  needsUpdate,
  type Plan,
  type UpdateEvent,
} from "../updater.js";
import { Session, UsbOpenError } from "../usb.js";
import { parsePackage, type RdhmPackage } from "../rdhm.js";
import {
  detectPlatform,
  hex4,
  lookupDevice,
  releaseInstructions,
  supportLabel,
} from "../devices.js";
import { hex, type Hello } from "../frame.js";
import { blockSize, type UfuComponentVersion, type UfuInfo } from "../ufu.js";
import {
  LogView,
  addCell,
  addKv,
  byId,
  clear,
  compactBytes,
  compareVersions,
  errorMessage,
  formatBytes,
  setStatus,
} from "../ui.js";
import type { ControllerTool, Detection } from "./types.js";

const USB_VENDOR = 0x045e;
const XBOX_USB_ID = /045e.*0b12/i;
const XBOX_VENDOR_ID = /045e/i;
const XBOX_GAMEPAD = /xbox/i;

type HapticActuatorWithEffects = GamepadHapticActuator & {
  readonly effects?: readonly string[];
};

interface UsbConnectionEvent extends Event {
  device: USBDevice;
}

export function createXboxTool(): ControllerTool {
  const flow = byId<HTMLElement>("xbox-flow");
  const help = byId<HTMLElement>("xbox-help");

  const connectBtn = byId<HTMLButtonElement>("connect-btn");
  const connectStatus = byId<HTMLElement>("connect-status");
  const rumbleBtn = byId<HTMLButtonElement>("rumble-btn");
  const rumbleStatus = byId<HTMLElement>("rumble-status");
  const retryBtn = byId<HTMLButtonElement>("retry-btn");
  const releasePanel = byId<HTMLElement>("release-panel");
  const releaseContent = byId<HTMLElement>("release-content");
  const deviceSection = byId<HTMLElement>("device-section");
  const usbInfo = byId<HTMLElement>("usb-info");
  const gipInfo = byId<HTMLElement>("gip-info");
  const ufuInfo = byId<HTMLElement>("ufu-info");
  const componentsBody = byId<HTMLElement>("components-body");
  const protocolNote = byId<HTMLElement>("protocol-note");

  const firmwareCard = byId<HTMLElement>("firmware-card");
  const feedStatus = byId<HTMLElement>("feed-status");
  const feedInfo = byId<HTMLElement>("feed-info");
  const feedFallback = byId<HTMLElement>("feed-fallback");
  const downloadBtn = byId<HTMLButtonElement>("download-btn");
  const manualLink = byId<HTMLAnchorElement>("manual-link");
  const fileInput = byId<HTMLInputElement>("file-input");
  const downloadProgress = byId<HTMLProgressElement>("download-progress");
  const downloadStatus = byId<HTMLElement>("download-status");
  const packageSection = byId<HTMLElement>("package-section");
  const packageInfo = byId<HTMLElement>("package-info");
  const packageBody = byId<HTMLElement>("package-body");
  const packageStatus = byId<HTMLElement>("package-status");

  const updateCard = byId<HTMLElement>("update-card");
  const planBtn = byId<HTMLButtonElement>("plan-btn");
  const confirmCheck = byId<HTMLInputElement>("confirm-check");
  const planStatus = byId<HTMLElement>("plan-status");
  const planTable = byId<HTMLTableElement>("plan-table");
  const planBody = byId<HTMLElement>("plan-body");
  const updateBtn = byId<HTMLButtonElement>("update-btn");
  const updateStatus = byId<HTMLElement>("update-status");
  const updateProgress = byId<HTMLProgressElement>("update-progress");
  const logEl = byId<HTMLPreElement>("log");

  const browserWarning = byId<HTMLElement>("browser-warning");

  let session: Session | null = null;
  let updater: Updater | null = null;
  let hello: Hello | null = null;
  let info: UfuInfo | null = null;
  let versions = new Map<number, UfuComponentVersion>();

  let feed: Feed | null = null;
  let feedDevice: FeedDevice | null = null;
  let feedFile: FeedFile | null = null;

  let pkg: RdhmPackage | null = null;
  let packageName = "";
  let packageVerified = false;
  let packageMismatch: string | null = null;

  let plan: Plan | null = null;
  let busy = false;
  let updating = false;
  const lastLogged = new Map<number, number>();

  const logView = new LogView(logEl);

  function log(message: string, kind: "" | "ok" | "warn" | "err" = ""): void {
    logView.log(message, kind);
  }

  function isXboxGamepad(pad: Gamepad): boolean {
    return XBOX_USB_ID.test(pad.id) || XBOX_VENDOR_ID.test(pad.id) || XBOX_GAMEPAD.test(pad.id);
  }

  function findXboxGamepad(): Gamepad | null {
    if (typeof navigator.getGamepads !== "function") return null;
    const pads = Array.from(navigator.getGamepads()).filter(
      (pad): pad is Gamepad => pad !== null,
    );
    return (
      pads.find((pad) => XBOX_USB_ID.test(pad.id)) ??
      pads.find((pad) => XBOX_VENDOR_ID.test(pad.id)) ??
      pads.find((pad) => XBOX_GAMEPAD.test(pad.id)) ??
      null
    );
  }

  function showRumbleHint(): void {
    if (typeof navigator.getGamepads !== "function") {
      rumbleBtn.disabled = true;
      setStatus(rumbleStatus, "This browser does not expose the Gamepad API.", "warn");
      return;
    }
    setStatus(
      rumbleStatus,
      findXboxGamepad()
        ? "Xbox gamepad ready. Test rumble."
        : "Press a button on the controller, then test.",
      "",
    );
  }

  async function testRumble(): Promise<void> {
    if (typeof navigator.getGamepads !== "function") {
      setStatus(rumbleStatus, "This browser does not expose the Gamepad API.", "error");
      return;
    }

    const pad = findXboxGamepad();
    if (!pad) {
      setStatus(
        rumbleStatus,
        "No Xbox gamepad found. Press a button on the controller, then try again.",
        "warn",
      );
      return;
    }

    const actuator = pad.vibrationActuator as HapticActuatorWithEffects | null | undefined;
    if (!actuator || typeof actuator.playEffect !== "function") {
      setStatus(rumbleStatus, "This controller has no vibration actuator in the browser.", "error");
      return;
    }

    rumbleBtn.disabled = true;
    try {
      setStatus(rumbleStatus, "Body rumble…", "busy");
      await actuator.playEffect("dual-rumble", {
        duration: 450,
        strongMagnitude: 0.75,
        weakMagnitude: 0.75,
      });

      if (actuator.effects && !actuator.effects.includes("trigger-rumble")) {
        setStatus(rumbleStatus, "Body rumble sent; trigger rumble is not exposed here.", "ok");
        return;
      }

      setStatus(rumbleStatus, "Trigger rumble…", "busy");
      try {
        await actuator.playEffect("trigger-rumble", {
          duration: 450,
          leftTrigger: 0.8,
          rightTrigger: 0.8,
        });
        setStatus(rumbleStatus, "Body and trigger rumble sent.", "ok");
      } catch (error) {
        setStatus(
          rumbleStatus,
          `Body rumble sent; trigger rumble is not available (${errorMessage(error)}).`,
          "warn",
        );
      }
    } catch (error) {
      setStatus(rumbleStatus, `Rumble failed: ${errorMessage(error)}`, "error");
    } finally {
      rumbleBtn.disabled = false;
    }
  }

  function currentFirmware(): string | null {
    const component = versions.get(3);
    if (component) return component.version.toString();
    if (hello) return hello.firmware.toString();
    return null;
  }

  function refreshButtons(): void {
    const connected = session !== null && updater !== null;
    connectBtn.disabled = busy;
    connectBtn.textContent = connected ? "Reconnect controller" : "Connect controller";
    planBtn.disabled = busy || !connected || !pkg;
    downloadBtn.disabled = busy || !feedFile;
    fileInput.disabled = busy;
    confirmCheck.disabled = busy || !connected;
    retryBtn.disabled = busy;
    updateBtn.disabled =
      busy ||
      !connected ||
      !pkg ||
      !plan ||
      !needsUpdate(plan) ||
      !confirmCheck.checked ||
      packageMismatch !== null;
  }

  /* ---------------------------------------------------------------- diagnostics */

  function formatBcd(major: number, minor: number): string {
    // Chrome may report raw BCD bytes or decoded numbers; both land on the same
    // text because valid BCD nibbles decode to their decimal value.
    const decode = (value: number): number => {
      const high = (value >> 4) & 0xf;
      const low = value & 0xf;
      return high <= 9 && low <= 9 ? high * 10 + low : value;
    };
    return `${decode(major)}.${decode(minor).toString().padStart(2, "0")}`;
  }

  function renderUsb(device: USBDevice): void {
    clear(usbInfo);
    addKv(usbInfo, "Product", device.productName || "—");
    addKv(usbInfo, "Manufacturer", device.manufacturerName || "—");
    addKv(usbInfo, "Serial", device.serialNumber || "—");
    addKv(usbInfo, "USB ID", `${hex4(device.vendorId)}:${hex4(device.productId)}`);
    addKv(usbInfo, "bcdDevice", formatBcd(device.deviceVersionMajor, device.deviceVersionMinor));
    addKv(usbInfo, "USB", `${device.usbVersionMajor}.${device.usbVersionMinor}`);
    addKv(
      usbInfo,
      "Class",
      `${device.deviceClass.toString(16).padStart(2, "0")}:${device.deviceSubclass
        .toString(16)
        .padStart(2, "0")}:${device.deviceProtocol.toString(16).padStart(2, "0")}`,
    );

    const configuration = device.configuration;
    if (configuration) {
      const iface = configuration.interfaces[0];
      const alternate = iface?.alternate;
      const endpoints = alternate?.endpoints
        .map(
          (endpoint) =>
            `${endpoint.direction === "in" ? "IN" : "OUT"} 0x${endpoint.endpointNumber
              .toString(16)
              .padStart(2, "0")} (${endpoint.packetSize} B)`,
        )
        .join(", ");
      addKv(
        usbInfo,
        "Interface",
        `${iface?.interfaceNumber ?? 0}${endpoints ? ` · ${endpoints}` : ""}`,
      );
    }

    const known = lookupDevice(device.vendorId, device.productId);
    addKv(
      usbInfo,
      "Model",
      known ? `${known.name} (${supportLabel(known.support)})` : "unknown to this page",
    );
  }

  function renderGip(): void {
    clear(gipInfo);
    const device = session?.device;
    const known = device ? lookupDevice(device.vendorId, device.productId) : undefined;
    addKv(gipInfo, "Codename", known?.codename ?? "—");
    if (hello) {
      addKv(gipInfo, "GIP device ID", hex(hello.deviceId, ""));
      addKv(gipInfo, "Hello firmware", hello.firmware.toString());
      addKv(gipInfo, "Hardware", hex(hello.hardware, ""));
    } else {
      addKv(gipInfo, "Hello", "not captured (the controller announces itself once)");
    }
    const firmware = currentFirmware();
    addKv(gipInfo, "Firmware (component 3)", firmware ?? "—");
  }

  function renderUfu(): void {
    clear(ufuInfo);
    if (!info) {
      addKv(ufuInfo, "Protocol", "not available");
      return;
    }
    addKv(ufuInfo, "Protocol", info.protocol === 0 ? "0 (UFU)" : `${info.protocol} (unsupported)`);
    addKv(ufuInfo, "Flags", `0x${info.flags.toString(16).padStart(2, "0")}`);
    addKv(ufuInfo, "USB ID", `${hex4(info.vendorId)}:${hex4(info.productId)}`);
    addKv(ufuInfo, "Max write", formatBytes(info.maxWrite));
    addKv(ufuInfo, "Write size", formatBytes(blockSize(info)));
  }

  function renderComponents(): void {
    clear(componentsBody);
    for (let id = 1; id <= 7; id += 1) {
      const component = versions.get(id);
      const row = document.createElement("tr");
      addCell(row, String(id), "num");
      addCell(row, component ? component.version.toString() : "—");
      addCell(
        row,
        component?.partitionSize !== undefined ? formatBytes(component.partitionSize) : "—",
        "num",
      );
      const notes: string[] = [];
      if (id === 1) notes.push("bootloader");
      if (!component) notes.push("not present");
      addCell(row, notes.join("; "));
      componentsBody.append(row);
    }
  }

  function renderDiagnostics(): void {
    if (session) renderUsb(session.device);
    renderGip();
    renderUfu();
    renderComponents();

    if (info && info.protocol === 1) {
      protocolNote.textContent =
        "This controller uses the legacy UFU protocol 1. Windows supports it, but this page does not.";
      protocolNote.className = "notice warn";
    } else {
      protocolNote.textContent = "";
      protocolNote.className = "muted";
    }
  }

  /* ---------------------------------------------------------------------- feed */

  function showFeedFallback(reason: string): void {
    const id = session
      ? `${hex4(session.device.vendorId)}_${hex4(session.device.productId)}`
      : "your controller";
    const link = document.createElement("a");
    link.href = FEED_URL;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = FEED_URL;

    feedFallback.hidden = false;
    feedFallback.replaceChildren(
      document.createTextNode(`${reason} Open the feed directly: `),
      link,
      document.createTextNode(
        `, find the entry with id ${id.toUpperCase()} and download the .bin file it lists. ` +
          "Then choose that file below. The deployed page normally bundles the feed and " +
          "firmware so the browser can read them same-origin; the live proxy is only a fallback.",
      ),
    );
  }

  function renderFeedForDevice(): void {
    clear(feedInfo);
    feedDevice = null;
    feedFile = null;
    downloadBtn.hidden = true;
    manualLink.hidden = true;

    const device = session?.device;
    if (!device) return;

    if (!feed) {
      setStatus(feedStatus, "Firmware feed not loaded.", "error");
      showFeedFallback("Could not fetch Microsoft's firmware feed through the proxy.");
      return;
    }

    const entry = findFeedDevice(feed, device.vendorId, device.productId);
    if (!entry || entry.files.length === 0) {
      setStatus(
        feedStatus,
        `Microsoft's feed has no file for ${hex4(device.vendorId)}:${hex4(device.productId)}.`,
        "error",
      );
      showFeedFallback("No matching feed entry was found.");
      return;
    }

    const file = entry.files[0];
    feedDevice = entry;
    feedFile = file;
    const directUrl = feed.baseUrl + file.name;
    const latest = fileVersion(file.name);
    const current = currentFirmware();

    feedFallback.hidden = true;
    addKv(feedInfo, "Feed", `${feed.name} ${feed.version} (${feed.source})`);
    addKv(feedInfo, "Entry", `${entry.id} · ${entry.codename}`);
    addKv(feedInfo, "Latest firmware", latest ?? "unknown");
    addKv(feedInfo, "File", file.name);
    addKv(feedInfo, "Tag", file.tag || "—");

    const known = lookupDevice(device.vendorId, device.productId);
    if (known) addKv(feedInfo, "Model", `${known.name} (${supportLabel(known.support)})`);
    if (current) {
      addKv(feedInfo, "Controller", current);
      if (latest) {
        const comparison = compareVersions(current, latest);
        if (comparison === 0) {
          addKv(feedInfo, "Status", `up to date (${current})`);
        } else if (comparison !== null && comparison < 0) {
          addKv(feedInfo, "Status", `update available: ${current} → ${latest}`);
        } else if (comparison !== null) {
          addKv(feedInfo, "Status", `controller is newer than the feed (${current} > ${latest})`);
        }
      }
    }

    downloadBtn.hidden = false;
    manualLink.hidden = false;
    manualLink.href = directUrl;
    setStatus(
      feedStatus,
      `Found ${latest ?? "a firmware file"} for ${entry.codename}. Download it, or choose a file you already have.`,
      "ok",
    );
    refreshButtons();
  }

  async function loadFeed(): Promise<void> {
    setStatus(feedStatus, "Looking up Microsoft's feed…", "busy");
    feedFallback.hidden = true;
    try {
      feed = await fetchFeed();
      setStatus(feedStatus, `Feed ${feed.name} · ${feed.devices.length} device entries`, "ok");
      log(`firmware feed ${feed.name} ${feed.version} loaded (${feed.source})`);
      renderFeedForDevice();
    } catch (error) {
      feed = null;
      const message = `Could not load the firmware feed: ${errorMessage(error)}`;
      setStatus(feedStatus, message, "error");
      log(message, "err");
      if (session) showFeedFallback(message + ".");
    }
  }

  /* ------------------------------------------------------------------- package */

  function renderPackage(): void {
    if (!pkg) return;
    clear(packageInfo);
    addKv(packageInfo, "File", packageName);
    addKv(
      packageInfo,
      "SHA-256",
      packageVerified ? "verified against the file name" : "not present in the file name",
    );
    addKv(packageInfo, "Firmware", pkg.version.toString());
    addKv(packageInfo, "USB IDs", `${hex4(pkg.vendorId)}:${hex4(pkg.productId)}`);
    addKv(packageInfo, "Components", String(pkg.components.length));
    if (packageMismatch) addKv(packageInfo, "Compatibility", packageMismatch);

    clear(packageBody);
    for (const component of pkg.components) {
      const row = document.createElement("tr");
      addCell(row, String(component.id), "num");
      addCell(row, component.version.toString());
      addCell(row, formatBytes(component.data.length), "num");
      addCell(row, `0x${component.targetAddress.toString(16).padStart(8, "0")}`, "num");
      addCell(
        row,
        (component.flags & 1) !== 0 ? "critical (never written)" : "flashable",
      );
      packageBody.append(row);
    }

    packageSection.hidden = false;
    if (packageMismatch) {
      setStatus(packageStatus, packageMismatch, "error");
    } else if (session) {
      setStatus(
        packageStatus,
        packageVerified ? "Package verified. Comparing it with the controller…" : "Package loaded.",
        "busy",
      );
    } else {
      setStatus(packageStatus, "Connect a controller to compare and update.", "");
    }
  }

  async function loadPackage(bytes: Uint8Array, name: string): Promise<boolean> {
    const expected = expectedHash(name);
    if (expected) {
      const actual = await sha256Base64Url(bytes);
      if (actual !== expected) {
        throw new Error(`SHA-256 mismatch: file is ${actual}, the name expects ${expected}`);
      }
    }

    const parsed = parsePackage(bytes);
    packageMismatch = null;
    if (session) {
      const device = session.device;
      if (parsed.vendorId !== device.vendorId || parsed.productId !== device.productId) {
        packageMismatch =
          `This package is for ${hex4(parsed.vendorId)}:${hex4(parsed.productId)}, but the ` +
          `connected controller is ${hex4(device.vendorId)}:${hex4(device.productId)}.`;
      }
    }

    pkg = parsed;
    packageName = name;
    packageVerified = expected !== null;
    plan = null;
    planTable.hidden = true;
    updateProgress.hidden = true;
    updateProgress.value = 0;
    renderPackage();
    log(`package ${name}: firmware ${parsed.version}, ${parsed.components.length} components`);

    if (session && updater) await checkPlan();
    return packageVerified;
  }

  async function checkPlan(): Promise<void> {
    plan = null;
    planTable.hidden = true;
    if (!updater || !pkg) {
      refreshButtons();
      return;
    }
    if (packageMismatch) {
      setStatus(planStatus, packageMismatch, "error");
      refreshButtons();
      return;
    }

    setStatus(planStatus, "Comparing the controller with the package (read-only)…", "busy");
    try {
      plan = await updater.plan(pkg);
      clear(planBody);
      for (const component of plan.components) {
        const row = document.createElement("tr");
        addCell(row, String(component.id), "num");
        addCell(row, component.device.toString());
        addCell(row, component.package.toString());
        const same = component.device.equals(component.package);
        const action = document.createElement("td");
        if (same) {
          action.textContent = "up to date";
        } else {
          const tag = document.createElement("span");
          tag.className = "tag warn";
          tag.textContent = "update";
          action.append(tag);
        }
        row.append(action);
        planBody.append(row);
      }
      planTable.hidden = false;

      if (needsUpdate(plan)) {
        setStatus(
          planStatus,
          `Plan ready: ${plan.components.filter((c) => !c.device.equals(c.package)).length} component(s) differ.`,
          "busy",
        );
      } else {
        setStatus(planStatus, "The controller already matches this package; nothing to write.", "ok");
      }
    } catch (error) {
      const message = `Could not compare: ${errorMessage(error)}`;
      setStatus(planStatus, message, "error");
      log(message, "err");
    }
    refreshButtons();
  }

  /* -------------------------------------------------------------------- update */

  function onEvent(event: UpdateEvent): void {
    switch (event.type) {
      case "info":
        log(
          `UFU protocol ${event.info.protocol}, max write ${formatBytes(event.info.maxWrite)}, ` +
            `write size ${formatBytes(blockSize(event.info))}`,
        );
        break;
      case "deviceVersion":
        log(`component ${event.component} on device: ${event.version}`);
        break;
      case "order":
        log(`update order: ${event.ids.join(" → ")}`);
        break;
      case "upToDate":
        log(`component ${event.component} already matches`, "ok");
        break;
      case "begin":
        log(
          `component ${event.component}: writing ${event.version} (${formatBytes(event.size)})`,
        );
        break;
      case "block": {
        if (event.total <= 0) break;
        const percent = Math.min(100, Math.floor((event.done / event.total) * 100));
        const previous = lastLogged.get(event.component) ?? -1;
        if (percent === 100 || percent >= previous + 25) {
          lastLogged.set(event.component, percent);
          log(
            `component ${event.component}: ${percent}%${event.written ? "" : " (already correct)"}`,
          );
        }
        updateProgress.hidden = false;
        updateProgress.max = 1;
        updateProgress.value = event.done / event.total;
        const index = plan
          ? plan.components.findIndex((component) => component.id === event.component)
          : -1;
        const label =
          plan && index >= 0
            ? `component ${index + 1}/${plan.components.length} (id ${event.component})`
            : `component ${event.component}`;
        setStatus(
          updateStatus,
          `${label}: ${compactBytes(event.done)} / ${compactBytes(event.total)}`,
          "busy",
        );
        break;
      }
      case "complete":
        log(`component ${event.component} complete`, "ok");
        break;
      case "skipped":
        log(`component ${event.component} skipped (${event.reason})`, "warn");
        break;
      case "reset":
        setStatus(updateStatus, "Resetting the controller…", "busy");
        log("controller reset");
        break;
      case "reconnected":
        setStatus(updateStatus, "Controller re-enumerated; resuming…", "busy");
        log("controller re-enumerated on USB", "ok");
        break;
      case "retry":
        log(`retrying ${event.op.toString(16)} (attempt ${event.attempt})`, "warn");
        break;
      case "fragmentResend":
        log(`resending fragments from byte ${event.offset}`, "warn");
        break;
      case "verified":
        log("all components verified; final reset", "ok");
        break;
    }
  }

  async function startUpdate(): Promise<void> {
    if (
      busy ||
      !updater ||
      !pkg ||
      !plan ||
      !confirmCheck.checked ||
      !needsUpdate(plan) ||
      packageMismatch
    ) {
      return;
    }

    busy = true;
    updating = true;
    lastLogged.clear();
    updateProgress.hidden = false;
    updateProgress.value = 0;
    setStatus(updateStatus, "Starting…", "busy");
    log("=== update started ===");
    refreshButtons();

    try {
      // The controller may have been asleep or reset since the plan was read.
      await updater.start(200);
      const changed = await updater.run(pkg);
      if (!changed) {
        setStatus(updateStatus, "The controller already matched the package.", "ok");
      } else {
        setStatus(
          updateStatus,
          "Update complete. Replug the controller, then rebind xpad if you unbound it.",
          "ok",
        );
        log("update complete", "ok");
        setStatus(connectStatus, "Update finished. Replug the controller.", "ok");
        updateProgress.value = 1;
        await session?.close().catch(() => {});
        session = null;
        updater = null;
      }
    } catch (error) {
      const message = `Update failed: ${errorMessage(error)}`;
      setStatus(
        updateStatus,
        `${message}. Replug the controller and check the plan again before retrying.`,
        "error",
      );
      log(message, "err");
    } finally {
      busy = false;
      updating = false;
      refreshButtons();
    }
  }

  /* ------------------------------------------------------------------- connect */

  async function resetSession(): Promise<void> {
    await session?.close().catch(() => {});
    session = null;
    updater = null;
    hello = null;
    info = null;
    versions = new Map();
    plan = null;
  }

  function showRelease(error: unknown, reason: "permission" | "driver" | "unknown" = "unknown"): void {
    const platform = detectPlatform();
    const instructions = releaseInstructions(platform);
    clear(releaseContent);

    const title = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent =
      reason === "permission" && platform === "linux"
        ? "Allow your user to open the controller (Linux)"
        : instructions.title;
    title.append(strong);

    const intro = document.createElement("p");
    intro.textContent =
      reason === "permission"
        ? "The browser could not open the USB device node. Grant your user access first; the unbind step is only needed after that."
        : reason === "driver"
          ? "The browser opened the device but could not claim interface 0. Another driver (usually xpad) owns it; release it and retry."
          : instructions.intro;

    releaseContent.append(title, intro);

    if (instructions.steps.length > 0) {
      const list = document.createElement("ol");
      for (const step of instructions.steps) {
        const item = document.createElement("li");
        item.append(document.createTextNode(step.text));
        if (step.code) {
          const code = document.createElement("pre");
          code.className = "code";
          code.textContent = step.code;
          item.append(code);
        }
        list.append(item);
      }
      releaseContent.append(list);
    }

    if (instructions.note) {
      const note = document.createElement("p");
      note.className = "muted small";
      note.textContent = instructions.note;
      releaseContent.append(note);
    }

    const detail = document.createElement("p");
    detail.className = "muted small";
    detail.textContent = `The browser said: ${errorMessage(error)}`;
    releaseContent.append(detail);

    releasePanel.hidden = false;
  }

  async function attach(device: USBDevice): Promise<void> {
    await resetSession();
    releasePanel.hidden = true;
    deviceSection.hidden = false;
    renderUsb(device);
    clear(gipInfo);
    clear(ufuInfo);
    clear(componentsBody);
    setStatus(connectStatus, "Opening interface 0…", "busy");

    let opened: Session;
    try {
      opened = await Session.open(device);
    } catch (error) {
      const stage = error instanceof UsbOpenError ? error.stage : null;
      const reason = stage === "open" ? "permission" : stage === "claim" ? "driver" : "unknown";
      setStatus(
        connectStatus,
        stage === "open"
          ? "Could not open the USB device (permission denied)."
          : stage === "claim"
            ? "Could not claim interface 0 (another driver owns it)."
            : "Could not open the controller.",
        "error",
      );
      log(
        `${stage === "open" ? "could not open" : stage === "claim" ? "could not claim" : "could not open"} the controller: ${errorMessage(error)}`,
        "err",
      );
      showRelease(error, reason);
      refreshButtons();
      return;
    }
    session = opened;

    // Short timeouts here: a device that does not speak UFU should not make the
    // user wait for the full update retry budget.
    const infoUpdater = new Updater(
      opened,
      { ...DEFAULT_OPTIONS, responseTimeoutMs: 1500, attempts: 2 },
      onEvent,
    );

    try {
      setStatus(connectStatus, "Reading firmware versions…", "busy");
      hello = await infoUpdater.start();
      info = await infoUpdater.queryInfo();

      versions = new Map();
      if (info.protocol !== 1) {
        for (let id = 1; id <= 7; id += 1) {
          const component = await infoUpdater.queryVersion(id);
          if (component) versions.set(id, component);
        }
      }

      // Updates use the full retry budget from here on.
      updater = new Updater(opened, DEFAULT_OPTIONS, onEvent);

      renderDiagnostics();
      const known = lookupDevice(device.vendorId, device.productId);
      setStatus(
        connectStatus,
        `Connected: ${known?.name ?? `${hex4(device.vendorId)}:${hex4(device.productId)}`}`,
        "ok",
      );
      firmwareCard.hidden = false;
      updateCard.hidden = false;
      renderFeedForDevice();
      if (pkg) await checkPlan();
    } catch (error) {
      renderDiagnostics();
      const message = `Could not read the controller's update protocol: ${errorMessage(error)}`;
      setStatus(connectStatus, message, "error");
      log(message, "err");
      setStatus(
        planStatus,
        "This controller did not answer the update queries. It may use an unsupported protocol or another program may be using it.",
        "error",
      );
      firmwareCard.hidden = true;
      updateCard.hidden = true;
      await resetSession();
    }
    refreshButtons();
  }

  async function connect(): Promise<void> {
    if (!("usb" in navigator)) {
      browserWarning.hidden = false;
      return;
    }
    if (busy) return;

    busy = true;
    refreshButtons();
    try {
      const device = await navigator.usb.requestDevice({
        filters: [{ vendorId: USB_VENDOR }],
      });
      await attach(device);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        setStatus(connectStatus, "No controller selected.", "");
      } else if (
        error instanceof DOMException &&
        (error.name === "SecurityError" || /access denied|permission/i.test(error.message))
      ) {
        setStatus(
          connectStatus,
          "The browser blocked the USB permission prompt. Allow USB devices for this site and try again.",
          "error",
        );
        log(`the browser blocked the USB permission prompt: ${errorMessage(error)}`, "err");
      } else {
        setStatus(connectStatus, "Could not open the controller.", "error");
        log(`could not open the controller: ${errorMessage(error)}`, "err");
        showRelease(error);
      }
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  async function download(): Promise<void> {
    if (busy || !feed || !feedFile) return;
    const file = feedFile;
    const url = feed.baseUrl + file.name;

    busy = true;
    refreshButtons();
    downloadProgress.hidden = false;
    downloadProgress.removeAttribute("value");
    setStatus(downloadStatus, "Downloading firmware…", "busy");

    try {
      const data = await downloadFirmware(url, ({ received, total }) => {
        if (total > 0) {
          downloadProgress.max = 1;
          downloadProgress.value = Math.min(1, received / total);
          setStatus(
            downloadStatus,
            `Downloading ${compactBytes(received)} / ${compactBytes(total)}…`,
            "busy",
          );
        } else {
          downloadProgress.removeAttribute("value");
          setStatus(downloadStatus, `Downloading ${compactBytes(received)}…`, "busy");
        }
      });
      downloadProgress.value = 1;
      setStatus(downloadStatus, "Downloaded. Verifying and parsing…", "busy");
      const verified = await loadPackage(data, file.name);
      setStatus(
        downloadStatus,
        verified
          ? `SHA-256 verified. ${file.name} is ready.`
          : `Downloaded ${file.name}; it has no hash in its name, so it could not be verified.`,
        verified ? "ok" : "warn",
      );
      log(`downloaded ${file.name} (${formatBytes(data.length)})`, "ok");
    } catch (error) {
      const message = `Download failed: ${errorMessage(error)}`;
      setStatus(
        downloadStatus,
        `${message}. Use Direct download, then choose the file below.`,
        "error",
      );
      log(message, "err");
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  /* ----------------------------------------------------------------- events */

  connectBtn.addEventListener("click", () => {
    void connect();
  });
  rumbleBtn.addEventListener("click", () => {
    void testRumble();
  });
  retryBtn.addEventListener("click", () => {
    void connect();
  });
  downloadBtn.addEventListener("click", () => {
    void download();
  });
  planBtn.addEventListener("click", () => {
    void checkPlan();
  });
  updateBtn.addEventListener("click", () => {
    void startUpdate();
  });
  confirmCheck.addEventListener("change", refreshButtons);

  manualLink.addEventListener("click", () => {
    log("direct download opened; choose the same file below when it finishes");
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void (async () => {
      busy = true;
      refreshButtons();
      setStatus(downloadStatus, `Reading ${file.name}…`, "busy");
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const verified = await loadPackage(data, file.name);
        setStatus(
          downloadStatus,
          verified
            ? `${file.name} loaded; SHA-256 verified.`
            : `${file.name} loaded; no hash in its name, so it could not be verified.`,
          verified ? "ok" : "warn",
        );
      } catch (error) {
        const message = `Could not use ${file.name}: ${errorMessage(error)}`;
        setStatus(downloadStatus, message, "error");
        log(message, "err");
      } finally {
        busy = false;
        fileInput.value = "";
        refreshButtons();
      }
    })();
  });

  window.addEventListener("gamepadconnected", (event) => {
    const pad = (event as GamepadEvent).gamepad;
    if (isXboxGamepad(pad)) setStatus(rumbleStatus, "Xbox gamepad ready. Test rumble.", "");
  });
  window.addEventListener("gamepaddisconnected", (event) => {
    const pad = (event as GamepadEvent).gamepad;
    if (isXboxGamepad(pad) && !findXboxGamepad()) {
      setStatus(rumbleStatus, "Xbox controller disconnected.", "warn");
    }
  });

  if ("usb" in navigator) {
    navigator.usb.addEventListener("disconnect", (event: Event) => {
      if (updating || !session) return;
      if ((event as UsbConnectionEvent).device !== session.device) return;
      setStatus(connectStatus, "Controller disconnected. Reconnect it and press Connect.", "error");
      log("controller disconnected", "warn");
      void resetSession();
      refreshButtons();
    });
  } else {
    browserWarning.hidden = false;
    connectBtn.disabled = true;
  }

  renderDiagnostics();
  refreshButtons();
  showRumbleHint();
  void loadFeed();

  return {
    id: "xbox",
    tabLabel: "Xbox",
    flow,
    help,
    async detect(): Promise<Detection> {
      if (!("usb" in navigator)) {
        return {
          detected: false,
          detail: "WebUSB is not available; Xbox updates need a Chromium browser.",
        };
      }
      try {
        const devices = await navigator.usb.getDevices();
        const device = devices.find(
          (candidate) =>
            candidate.vendorId === USB_VENDOR && lookupDevice(candidate.vendorId, candidate.productId),
        );
        if (device) {
          const known = lookupDevice(device.vendorId, device.productId);
          return {
            detected: true,
            detail: `${known?.name ?? "Xbox controller"} is already allowed; press Connect.`,
          };
        }
      } catch {
        // Detection is best-effort; a denied permission just means no result.
      }
      return { detected: false, detail: "" };
    },
    activate(): void {
      refreshButtons();
    },
    deactivate(): void {
      // Keep the session alive so switching tabs does not disconnect the pad.
    },
  };
}
