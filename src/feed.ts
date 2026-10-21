/**
 * Microsoft's Xbox Accessories firmware feed.
 *
 * The deployed site reads a bundled snapshot from ./data/ so the browser never
 * has to cross-origin-fetch Microsoft's CDN. If the snapshot is missing, fall
 * back to the public allorigins proxy.
 */

export const FEED_URL = "https://aka.ms/xboxaccessoriesfwcdnpcga";
export const PROXY = "https://api.allorigins.win/raw?url=";
export const LOCAL_FEED = "./data/feed.json";

export function proxyUrl(url: string): string {
  return PROXY + encodeURIComponent(url);
}

export interface FeedFile {
  tag: string;
  name: string;
}

export interface FeedDevice {
  codename: string;
  id: string;
  files: FeedFile[];
  required: string[];
}

export interface Feed {
  name: string;
  version: string;
  baseUrl: string;
  devices: FeedDevice[];
  source: "bundled" | "live";
}

interface RawFeed {
  g?: string;
  v?: string;
  p?: string;
  d?: Array<{
    __n?: string;
    id?: string;
    f?: Array<{ __t?: string; p?: string }>;
    req?: Array<{ v?: string }>;
  }>;
}

function parseFeed(raw: RawFeed): Feed {
  if (!raw || !Array.isArray(raw.d)) throw new Error("feed response is not a device list");
  return {
    name: raw.g ?? "pc_ga",
    version: raw.v ?? "unknown",
    baseUrl: raw.p ?? "",
    devices: raw.d.map((device) => ({
      codename: device.__n ?? "",
      id: device.id ?? "",
      files: (device.f ?? []).map((file) => ({
        tag: file.__t ?? "",
        name: file.p ?? "",
      })),
      required: (device.req ?? []).map((entry) => entry.v ?? "").filter(Boolean),
    })),
    source: "live",
  };
}

export async function fetchFeed(): Promise<Feed> {
  try {
    const local = await fetch(LOCAL_FEED, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (local.ok) {
      const feed = parseFeed((await local.json()) as RawFeed);
      feed.source = "bundled";
      return feed;
    }
  } catch {
    // No snapshot (or a broken one): use the live proxy below.
  }

  const response = await fetch(proxyUrl(FEED_URL), {
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`feed request failed: HTTP ${response.status}`);
  }
  return parseFeed((await response.json()) as RawFeed);
}

export function findFeedDevice(
  feed: Feed,
  vendorId: number,
  productId: number,
): FeedDevice | undefined {
  const id = `${hex4(vendorId)}_${hex4(productId)}`.toUpperCase();
  return feed.devices.find((device) => device.id.toUpperCase() === id);
}

function hex4(value: number): string {
  return value.toString(16).padStart(4, "0");
}

/** `MERL_045E_0B12_v_5_23_6_0_h_...bin` -> "5.23.6.0" */
export function fileVersion(name: string): string | null {
  const start = name.indexOf("_v_");
  if (start === -1) return null;
  const end = name.indexOf("_h_", start + 3);
  if (end === -1) return null;
  return name.slice(start + 3, end).replaceAll("_", ".");
}

/** The base64url SHA-256 embedded in the firmware file name. */
export function expectedHash(name: string): string | null {
  const start = name.indexOf("_h_");
  if (start === -1) return null;
  const hash = name.slice(start + 3);
  return hash.endsWith(".bin") ? hash.slice(0, -4) : hash;
}

export async function sha256Base64Url(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
}

export interface DownloadProgress {
  received: number;
  total: number;
}

/**
 * Download the firmware. Bundled files are same-origin and fetched directly;
 * absolute Microsoft URLs need the proxy because the CDN has no CORS headers.
 */
export async function downloadFirmware(
  url: string,
  onProgress: (progress: DownloadProgress) => void,
): Promise<Uint8Array> {
  const target = /^https?:\/\//i.test(url) ? proxyUrl(url) : url;
  const response = await fetch(target, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`firmware download failed: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get("content-length") ?? 0) || 0;
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    onProgress({ received: data.length, total: data.length });
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.length;
    onProgress({ received, total });
  }

  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}
