/**
 * GuliKit KK3 Max / KK3 Pro tool.
 *
 * GuliKit updates are not a vendor control protocol: the controller mounts a
 * small FAT volume named "GuliKit" and flashes the .bin copied to its root.
 * WebUSB cannot claim a protected mass-storage interface, so this tool uses the
 * File System Access API to write the official file to the volume the user
 * selects. A plain download remains the fallback.
 */

import {
  GULIKIT_PAGE_URL,
  downloadGulikitFirmware,
  fetchGulikitFeed,
  findGulikitFirmware,
  verifyGulikitFirmware,
  type GulikitFeed,
  type GulikitFirmware,
} from "../gulikit-feed.js";
import {
  addKv,
  byId,
  clear,
  compactBytes,
  errorMessage,
  formatBytes,
  setStatus,
} from "../ui.js";
import type { ControllerTool, Detection } from "./types.js";

export function createGulikitTool(): ControllerTool {
  const flow = byId<HTMLElement>("gulikit-flow");
  const help = byId<HTMLElement>("gulikit-help");

  const feedStatus = byId<HTMLElement>("gulikit-feed-status");
  const feedInfo = byId<HTMLElement>("gulikit-feed-info");
  const modelLabel = byId<HTMLElement>("gulikit-model-label");
  const modelSelect = byId<HTMLSelectElement>("gulikit-model");
  const downloadBtn = byId<HTMLButtonElement>("gulikit-download-btn");
  const manualLink = byId<HTMLAnchorElement>("gulikit-manual-link");
  const fileInput = byId<HTMLInputElement>("gulikit-file-input");
  const downloadProgress = byId<HTMLProgressElement>("gulikit-download-progress");
  const downloadStatus = byId<HTMLElement>("gulikit-download-status");
  const packageSection = byId<HTMLElement>("gulikit-package");
  const packageInfo = byId<HTMLElement>("gulikit-package-info");
  const saveBtn = byId<HTMLButtonElement>("gulikit-save-btn");
  const downloadFileBtn = byId<HTMLButtonElement>("gulikit-download-file-btn");
  const saveStatus = byId<HTMLElement>("gulikit-save-status");
  const doneNotice = byId<HTMLElement>("gulikit-done");
  const fsaWarning = byId<HTMLElement>("gulikit-fsa-warning");

  let feed: GulikitFeed | null = null;
  let current: GulikitFirmware | null = null;
  let bytes: Uint8Array | null = null;
  let verified = false;
  let busy = false;

  const hasDirectoryPicker = typeof window.showDirectoryPicker === "function";
  const hasFilePicker = typeof window.showSaveFilePicker === "function";
  fsaWarning.hidden = hasDirectoryPicker || hasFilePicker;

  function isFeedCurrent(): boolean {
    return Boolean(current && feed?.firmware.some((firmware) => firmware.id === current?.id));
  }

  function refreshButtons(): void {
    downloadBtn.disabled = busy || !isFeedCurrent();
    fileInput.disabled = busy;
    modelSelect.disabled = busy || !feed || feed.firmware.length < 2;
    saveBtn.disabled = busy || !bytes;
    downloadFileBtn.disabled = busy || !bytes;
    downloadBtn.textContent = current
      ? `Download & verify ${current.version}`
      : "Download & verify";
  }

  function renderPackage(): void {
    clear(packageInfo);
    if (!current) {
      packageSection.hidden = true;
      return;
    }
    packageSection.hidden = false;
    addKv(packageInfo, "Model", current.name);
    addKv(packageInfo, "Version", current.version);
    addKv(packageInfo, "File", current.file);
    addKv(packageInfo, "Size", formatBytes(current.size));
    addKv(packageInfo, "SHA-256", current.sha256 || "not bundled");
    if (bytes) {
      addKv(
        packageInfo,
        "State",
        verified ? "SHA-256 verified; ready to copy" : "not verified against the bundled feed",
      );
    }
  }

  function selectFirmware(id: string): void {
    current = findGulikitFirmware(feed, id) ?? null;
    bytes = null;
    verified = false;
    modelSelect.value = current?.id ?? "";
    renderPackage();
    setStatus(
      downloadStatus,
      current
        ? "Download the official file, or choose a .bin you already extracted."
        : "No firmware entry selected.",
      current ? "" : "warn",
    );
    doneNotice.hidden = true;
    refreshButtons();
  }

  function renderFeed(): void {
    clear(feedInfo);
    clear(modelSelect);
    modelLabel.hidden = true;

    manualLink.href = feed?.pageUrl ?? GULIKIT_PAGE_URL;
    manualLink.hidden = false;

    if (!feed) {
      setStatus(
        feedStatus,
        "No bundled GuliKit firmware feed. Use the official download, extract the .bin, then choose it below.",
        "warn",
      );
      packageSection.hidden = true;
      current = null;
      refreshButtons();
      return;
    }

    addKv(feedInfo, "Release", `V${feed.version}`);
    const official = document.createElement("a");
    official.href = feed.pageUrl;
    official.target = "_blank";
    official.rel = "noreferrer";
    official.textContent = "GuliKit firmware page";
    addKv(feedInfo, "Official page", official);
    addKv(feedInfo, "Bundled", feed.generated.slice(0, 10));

    for (const firmware of feed.firmware) {
      const option = document.createElement("option");
      option.value = firmware.id;
      option.textContent = firmware.name;
      modelSelect.append(option);
    }
    modelLabel.hidden = feed.firmware.length < 2;

    const preferred =
      feed.firmware.find((firmware) => firmware.id === "kk3-max") ?? feed.firmware[0];
    selectFirmware(preferred.id);
    const versions = feed.firmware
      .map((firmware) => `${firmware.model} V${firmware.version}`)
      .join(" · ");
    setStatus(
      feedStatus,
      `Bundled GuliKit firmware is ready: ${versions}. Choose the model, then download.`,
      "ok",
    );
  }

  async function loadFeed(): Promise<void> {
    setStatus(feedStatus, "Loading GuliKit firmware feed…", "busy");
    try {
      feed = await fetchGulikitFeed();
      renderFeed();
    } catch (error) {
      feed = null;
      renderFeed();
      setStatus(
        feedStatus,
        `Could not load the bundled GuliKit feed: ${errorMessage(error)}. ` +
          "Download the official package and choose the extracted .bin.",
        "warn",
      );
    }
  }

  async function download(): Promise<void> {
    if (busy || !current || !isFeedCurrent()) return;
    busy = true;
    refreshButtons();
    downloadProgress.hidden = false;
    downloadProgress.removeAttribute("value");
    setStatus(downloadStatus, "Downloading the official GuliKit firmware…", "busy");

    try {
      bytes = await downloadGulikitFirmware(current, ({ received, total }) => {
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
      verified = true;
      renderPackage();
      setStatus(
        downloadStatus,
        `${current.file} verified. Copy it to the GuliKit drive when it is mounted.`,
        "ok",
      );
    } catch (error) {
      bytes = null;
      verified = false;
      renderPackage();
      setStatus(
        downloadStatus,
        `Download failed: ${errorMessage(error)}. Use the official download and choose the extracted .bin.`,
        "error",
      );
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  function downloadToDisk(): void {
    if (!bytes || !current) return;
    const blob = new Blob([bytes as BufferSource], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = current.file;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setStatus(
      saveStatus,
      `Downloaded ${current.file}. Copy it to the root of the GuliKit drive.`,
      "warn",
    );
    doneNotice.hidden = false;
  }

  async function writeToDrive(): Promise<void> {
    if (!bytes || !current) return;
    const picker = window.showDirectoryPicker;
    const savePicker = window.showSaveFilePicker;

    try {
      if (picker) {
        const directory = await picker({ id: "gulikit-drive", mode: "readwrite" });
        if (!/gulikit/i.test(directory.name)) {
          const proceed = confirm(
            `The selected folder is "${directory.name}", not "GuliKit". ` +
              "Copy the firmware to the GuliKit drive root. Continue anyway?",
          );
          if (!proceed) {
            setStatus(saveStatus, "Drive selection cancelled; nothing was written.", "");
            return;
          }
        }
        const handle = await directory.getFileHandle(current.file, { create: true });
        const writable = await handle.createWritable();
        await writable.write(bytes as BufferSource);
        await writable.close();
      } else if (savePicker) {
        const handle = await savePicker({
          suggestedName: current.file,
          types: [
            {
              description: "GuliKit firmware",
              accept: { "application/octet-stream": [".bin"] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(bytes as BufferSource);
        await writable.close();
      } else {
        downloadToDisk();
        return;
      }

      setStatus(
        saveStatus,
        `Copied ${current.file}. Keep the cable connected; the drive will disappear and the controller will power off.`,
        "ok",
      );
      doneNotice.hidden = false;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus(saveStatus, "Drive selection cancelled; nothing was written.", "");
        return;
      }
      setStatus(
        saveStatus,
        `Could not write to the drive: ${errorMessage(error)}. Use Download .bin and copy it manually.`,
        "error",
      );
    }
  }

  async function chooseLocalFile(): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file) return;

    busy = true;
    doneNotice.hidden = true;
    refreshButtons();
    setStatus(downloadStatus, `Reading ${file.name}…`, "busy");
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const match =
        feed?.firmware.find((firmware) => firmware.file === file.name) ?? null;

      if (match) {
        if (!(await verifyGulikitFirmware(match, data))) {
          bytes = null;
          verified = false;
          renderPackage();
          throw new Error("SHA-256 mismatch; refusing to copy an unexpected file");
        }
        current = match;
        modelSelect.value = match.id;
        bytes = data;
        verified = true;
        renderPackage();
        setStatus(downloadStatus, `${file.name} loaded and SHA-256 verified.`, "ok");
      } else {
        current = {
          id: "local",
          name: "Local file (not in the bundled feed)",
          model: "local",
          version: file.name.match(/[_-]v(\d+(?:\.\d+)+)\.bin$/i)?.[1] ?? "unknown",
          file: file.name,
          size: data.length,
          sha256: "",
        };
        bytes = data;
        verified = false;
        modelSelect.value = "";
        renderPackage();
        setStatus(
          downloadStatus,
          `${file.name} loaded, but it is not in the bundled feed. It cannot be verified; ` +
            "check the model and file name before copying.",
          "warn",
        );
      }
    } catch (error) {
      bytes = null;
      verified = false;
      renderPackage();
      setStatus(downloadStatus, `Could not use ${file.name}: ${errorMessage(error)}`, "error");
    } finally {
      busy = false;
      fileInput.value = "";
      refreshButtons();
    }
  }

  downloadBtn.addEventListener("click", () => {
    void download();
  });
  saveBtn.addEventListener("click", () => {
    void writeToDrive();
  });
  downloadFileBtn.addEventListener("click", () => {
    downloadToDisk();
  });
  fileInput.addEventListener("change", () => {
    void chooseLocalFile();
  });
  modelSelect.addEventListener("change", () => {
    selectFirmware(modelSelect.value);
  });
  manualLink.addEventListener("click", () => {
    setStatus(
      downloadStatus,
      "Official download opened. Extract the .bin, then choose it below.",
      "",
    );
  });

  void loadFeed();

  return {
    id: "gulikit",
    tabLabel: "KingKong 3 Max",
    flow,
    help,
    detect(): Promise<Detection> {
      const pads = navigator.getGamepads?.() ?? [];
      const pad = Array.from(pads).find(
        (candidate) =>
          candidate !== null && /gulikit|kingkong|kk3/i.test(candidate.id),
      );
      if (pad) {
        return Promise.resolve({
          detected: true,
          detail: `${pad.id} detected in PC mode. Switch it to update mode (APG + A).`,
        });
      }
      return Promise.resolve({ detected: false, detail: "" });
    },
    activate(): void {
      refreshButtons();
    },
    deactivate(): void {
      // Nothing to release: this tool never claims a USB interface.
    },
  };
}
