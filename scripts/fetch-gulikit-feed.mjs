// Download GuliKit's official KK3 Max/Pro firmware package and publish the .bin
// files next to a small manifest. The page cannot fetch the vendor site from the
// browser (CORS), and it cannot extract a zip, so this runs at build time.
//
// The feed is best-effort: if GuliKit rate-limits the build, keep any previously
// generated data/gulikit/ and continue. The page still offers the official
// download plus a local .bin fallback.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PAGE_URL = "https://www.gulikit.com/newsinfo/887152.html";
// GuliKit's download endpoint requires an image captcha. GBAtemp mirrors the
// same official package, including the per-file version in each .bin name.
const MIRROR_PAGE = "https://gbatemp.net/download/gulikit-kk3-max-ns39-firmware.38417/";
const MIRROR_URL = `${MIRROR_PAGE}download`;
const OUT_DIR = "data/gulikit";
const DATA_DIR = "data";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOk(url, { referer, retries = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent": USER_AGENT,
          accept: "*/*",
          ...(referer ? { referer } : {}),
        },
      });
      if (response.ok) return response;
      lastError = new Error(`${url}: HTTP ${response.status}`);
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          const wait = attempt * 3000;
          console.warn(`${lastError.message}; retrying in ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
      }
      throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) throw error;
      await sleep(attempt * 2000);
    }
  }
  throw lastError;
}

// Undici's TLS fingerprint is rejected by GBAtemp's Cloudflare challenge, while
// curl passes it. The mirror is only a fallback, so keep this optional.
async function curlFetch(url, referer) {
  const { stdout } = await execFileAsync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--compressed",
      "--max-time",
      "90",
      "--user-agent",
      USER_AGENT,
      "--referer",
      referer,
      url,
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return Buffer.from(stdout);
}

function looksLikeZip(buffer) {
  return (
    buffer.length >= 4 &&
    (buffer.readUInt32LE(0) === 0x04034b50 || buffer.includes(Buffer.from("PK\x05\x06")))
  );
}

function versionFromFilename(fileName) {
  return fileName.match(/[_-]v(\d+(?:\.\d+)+)\.bin$/i)?.[1] ?? null;
}

function versionFromPage(html) {
  const patterns = [
    /KK3\s*Max\s*[\\/|]\s*KK3\s*Pro\s*V?(\d+(?:\.\d+)+)/i,
    /KK3\s*Max.*?V?(\d+(?:\.\d+)+)\s*Firmware/i,
    /V(\d+(?:\.\d+)+)\s*Firmware/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  throw new Error("could not find the KK3 Max/Pro firmware version on the GuliKit page");
}

function downloadUrlFromPage(html) {
  const absolute = [
    ...html.matchAll(/https?:\/\/[^"'\s<>]+\/filedownload\/\d+/gi),
  ].map((match) => match[0]);
  if (absolute.length > 0) return absolute[0];

  const pathMatch = html.match(/\/filedownload\/\d+/i);
  if (pathMatch) return new URL(pathMatch[0], PAGE_URL).toString();

  throw new Error("could not find the GuliKit download link on the firmware page");
}

async function readFirmwarePage(url) {
  const response = await fetchOk(url);
  let html = await response.text();

  // GuliKit's CMS returns a small shell and puts the article in a Body.js
  // payload. Follow that script so the download link is visible to the parser.
  const bodyScript = html.match(/<script[^>]+src=["']([^"']*Body\.js[^"']*)["']/i)?.[1];
  if (bodyScript) {
    const bodyResponse = await fetchOk(new URL(bodyScript, url).toString(), { referer: url });
    html += `\n${await bodyResponse.text()}`;
  }

  return html
    .replaceAll("\\u003c", "<")
    .replaceAll("\\u003e", ">")
    .replaceAll("\\u0026", "&")
    .replaceAll('\\"', '"');
}

function unzipEntries(buffer) {
  let eocd = -1;
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("download is not a zip archive (no end-of-central-directory)");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("corrupt zip central directory");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries
    .filter((entry) => !entry.name.endsWith("/") && /\.bin$/i.test(entry.name))
    .map((entry) => {
      if (entry.flags & 0x1) throw new Error(`${entry.name} is encrypted`);
      if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
        throw new Error(`corrupt local header for ${entry.name}`);
      }
      const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
      const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
      const start = entry.localOffset + 30 + nameLength + extraLength;
      const compressed = buffer.subarray(start, start + entry.compressedSize);

      let data;
      if (entry.method === 0) {
        data = Buffer.from(compressed);
      } else if (entry.method === 8) {
        data = inflateRawSync(compressed);
      } else {
        throw new Error(`${entry.name}: unsupported zip compression method ${entry.method}`);
      }
      if (data.length !== entry.uncompressedSize) {
        throw new Error(`${entry.name}: uncompressed size mismatch`);
      }
      return { name: path.basename(entry.name), data };
    });
}

function identifyModel(fileName, archiveName) {
  const name = `${fileName} ${archiveName}`.toLowerCase();
  if (/ns39|kk3[\s_-]*max|kingkong[\s_-]*3[\s_-]*max/.test(name)) {
    return { id: "kk3-max", name: "KingKong 3 Max (NS39)", model: "NS39" };
  }
  if (/ns38|kk3[\s_-]*pro|kingkong[\s_-]*3[\s_-]*pro/.test(name)) {
    return { id: "kk3-pro", name: "KingKong 3 Pro (NS38)", model: "NS38" };
  }
  return null;
}

function sha256Base64Url(bytes) {
  return createHash("sha256")
    .update(bytes)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

async function main() {
  console.log(`reading ${PAGE_URL}`);
  const html = await readFirmwarePage(PAGE_URL);
  const version = versionFromPage(html);
  const officialUrl = downloadUrlFromPage(html);
  console.log(`GuliKit V${version}: ${officialUrl}`);

  let downloadUrl = officialUrl;
  let response = null;
  let archive = null;
  try {
    response = await fetchOk(officialUrl, { referer: PAGE_URL });
    const candidate = Buffer.from(await response.arrayBuffer());
    if (looksLikeZip(candidate)) {
      archive = candidate;
    } else {
      console.warn("official download is behind a captcha; using the GBAtemp mirror of the same package");
    }
  } catch (error) {
    console.warn(`official download failed (${error.message}); trying the GBAtemp mirror`);
  }

  if (!archive) {
    downloadUrl = MIRROR_URL;
    try {
      response = await fetchOk(MIRROR_URL, { referer: MIRROR_PAGE });
      archive = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      console.warn(`mirror fetch failed (${error.message}); retrying with curl`);
      archive = await curlFetch(MIRROR_URL, MIRROR_PAGE);
      response = null;
    }
    if (!looksLikeZip(archive)) throw new Error("mirror did not return a zip archive");
  }

  const archiveName =
    response?.headers
      .get("content-disposition")
      ?.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i)?.[1] ??
    path.basename(new URL(downloadUrl).pathname);

  const files = unzipEntries(archive);
  if (files.length === 0) throw new Error("the GuliKit zip contains no .bin files");

  const firmware = [];
  for (const file of files) {
    const model = identifyModel(file.name, archiveName);
    if (!model) {
      console.warn(`skipping ${file.name}: not a KK3 Max/Pro firmware name`);
      continue;
    }
    const safeName = path.basename(file.name).replaceAll(/[^\w.\-()+ ]/g, "_");
    firmware.push({
      ...model,
      version: versionFromFilename(file.name) ?? version,
      file: safeName,
      size: file.data.length,
      sha256: sha256Base64Url(file.data),
      data: file.data,
    });
  }

  if (firmware.length === 0) {
    throw new Error(
      `no KK3 Max/Pro firmware found in ${archiveName}; entries: ${files
        .map((file) => file.name)
        .join(", ")}`,
    );
  }

  await mkdir(DATA_DIR, { recursive: true });
  const temporary = await mkdtemp(path.join(DATA_DIR, ".gulikit-"));
  try {
    for (const item of firmware) {
      await writeFile(path.join(temporary, item.file), item.data);
      delete item.data;
    }

    const feed = {
      name: "GuliKit KK3 Max / KK3 Pro",
      version,
      pageUrl: PAGE_URL,
      sourceUrl: downloadUrl,
      generated: new Date().toISOString(),
      firmware,
    };
    await writeFile(path.join(temporary, "feed.json"), `${JSON.stringify(feed, null, 2)}\n`);

    await rm(OUT_DIR, { recursive: true, force: true });
    await rename(temporary, OUT_DIR);
    console.log(
      `wrote ${firmware.length} firmware file(s) and feed.json to ${OUT_DIR} ` +
        `(${firmware.map((item) => item.file).join(", ")})`,
    );
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

main().catch(async (error) => {
  console.warn(`warning: could not refresh GuliKit firmware: ${error.message}`);
  try {
    const existing = JSON.parse(await readFile(path.join(OUT_DIR, "feed.json"), "utf8"));
    console.warn(
      `keeping the existing GuliKit feed (V${existing.version}, ${existing.firmware?.length ?? 0} file(s))`,
    );
  } catch {
    console.warn(
      "no bundled GuliKit feed yet; the page will offer the official download and a local .bin",
    );
  }
  // A vendor outage must not break the Xbox feed/deploy.
  process.exitCode = 0;
});
