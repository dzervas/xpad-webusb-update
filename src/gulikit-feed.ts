/**
 * GuliKit's public firmware downloads.
 *
 * A GuliKit controller enters update mode as a small USB mass-storage volume;
 * the browser cannot claim that interface. This feed only describes the
 * official .bin files, which the page writes to a volume the user selects.
 */

import { downloadFirmware, sha256Base64Url, type DownloadProgress } from "./feed.js";

export const GULIKIT_FEED_PATH = "./data/gulikit/feed.json";
export const GULIKIT_PAGE_URL = "https://www.gulikit.com/newsinfo/887152.html";

export interface GulikitFirmware {
  /** Stable model id, e.g. kk3-max. */
  id: string;
  name: string;
  /** Model marker in the file name, e.g. NS39. */
  model: string;
  version: string;
  file: string;
  size: number;
  /** SHA-256 as base64url, matching the rest of the site's verification scheme. */
  sha256: string;
}

export interface GulikitFeed {
  name: string;
  version: string;
  pageUrl: string;
  sourceUrl: string;
  generated: string;
  firmware: GulikitFirmware[];
}

export async function fetchGulikitFeed(): Promise<GulikitFeed> {
  const response = await fetch(GULIKIT_FEED_PATH, {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`GuliKit firmware feed not bundled (HTTP ${response.status})`);
  }
  const feed = (await response.json()) as GulikitFeed;
  if (!feed || !Array.isArray(feed.firmware) || feed.firmware.length === 0) {
    throw new Error("GuliKit firmware feed is empty");
  }
  return feed;
}

export function gulikitFirmwarePath(firmware: GulikitFirmware): string {
  return `./data/gulikit/${encodeURIComponent(firmware.file)}`;
}

export async function downloadGulikitFirmware(
  firmware: GulikitFirmware,
  onProgress: (progress: DownloadProgress) => void,
): Promise<Uint8Array> {
  const bytes = await downloadFirmware(gulikitFirmwarePath(firmware), onProgress);
  if (firmware.size > 0 && bytes.length !== firmware.size) {
    throw new Error(
      `firmware size mismatch: got ${bytes.length} bytes, expected ${firmware.size}`,
    );
  }
  const actual = await sha256Base64Url(bytes);
  if (firmware.sha256 && actual !== firmware.sha256) {
    throw new Error(`SHA-256 mismatch: got ${actual}, expected ${firmware.sha256}`);
  }
  return bytes;
}

export async function verifyGulikitFirmware(
  firmware: GulikitFirmware | null,
  bytes: Uint8Array,
): Promise<boolean> {
  if (!firmware?.sha256) return false;
  return (await sha256Base64Url(bytes)) === firmware.sha256;
}

export function findGulikitFirmware(
  feed: GulikitFeed | null,
  id: string,
): GulikitFirmware | undefined {
  return feed?.firmware.find((firmware) => firmware.id === id);
}
