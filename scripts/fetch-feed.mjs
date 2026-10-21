// Download Microsoft's feed and the firmware it lists into data/ so the static
// page can read them same-origin. Microsoft's CDN sends no CORS headers, and
// public proxies go down, so the deployed site ships a snapshot instead.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const FEED_URL = "https://aka.ms/xboxaccessoriesfwcdnpcga";
const OUT_DIR = "data";

function expectedHash(name) {
  const start = name.indexOf("_h_");
  if (start === -1) return null;
  const hash = name.slice(start + 3);
  return hash.endsWith(".bin") ? hash.slice(0, -4) : hash;
}

function sha256Base64Url(bytes) {
  return createHash("sha256")
    .update(bytes)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

async function fetchOk(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const response = await fetchOk(FEED_URL);
const feed = await response.json();
if (!feed || !Array.isArray(feed.d)) throw new Error("feed is not a device list");
if (!feed.p) throw new Error("feed has no base URL");

const sourceBase = feed.p.endsWith("/") ? feed.p : `${feed.p}/`;
await mkdir(OUT_DIR, { recursive: true });

const files = new Map();
for (const device of feed.d) {
  for (const file of device.f ?? []) {
    if (!file.p) continue;
    const name = path.basename(file.p);
    // Keep the feed's file name; the page builds baseUrl + name.
    file.p = name;
    files.set(name, new URL(name, sourceBase).toString());
  }
}

let failures = 0;
for (const [name, url] of files) {
  try {
    const fileResponse = await fetchOk(url);
    const bytes = new Uint8Array(await fileResponse.arrayBuffer());
    const expected = expectedHash(name);
    if (expected) {
      const actual = sha256Base64Url(bytes);
      if (actual !== expected) {
        throw new Error(`SHA-256 mismatch: got ${actual}, expected ${expected}`);
      }
    }
    await writeFile(path.join(OUT_DIR, name), bytes);
    console.log(`downloaded ${name} (${bytes.length} bytes)`);
  } catch (error) {
    failures++;
    console.error(`failed ${name}: ${error.message}`);
  }
}
if (failures) throw new Error(`${failures} firmware download(s) failed`);

feed.p = "./data/";
await writeFile(path.join(OUT_DIR, "feed.json"), `${JSON.stringify(feed, null, 2)}\n`);
console.log(`wrote ${OUT_DIR}/feed.json (${feed.d.length} device entries)`);
