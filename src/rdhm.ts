/**
 * The `rdhm` firmware container used by the Xbox Accessories app.
 *
 * Header (little-endian): magic `rdhm`, u32 header version (1), u16 VID,
 * u16 PID, u16x4 package version, u16x4 minimum version, u32 entry count at
 * 0x1c. 0x40-byte entries follow from 0x40.
 *
 * Ported from xboxctl's src/gip/rdhm.rs (0BSD).
 */

import { Version } from "./version.js";

/** Entries with this flag are never written. */
export const FLAG_CRITICAL = 1;

const HEADER = 0x40;
const ENTRY = 0x40;
const MAX_ENTRIES = 10;

export interface RdhmComponent {
  id: number;
  flags: number;
  targetAddress: number;
  version: Version;
  data: Uint8Array;
}

export interface RdhmPackage {
  vendorId: number;
  productId: number;
  version: Version;
  components: RdhmComponent[];
}

function u32At(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/** Parse and validate a package with the same rules as the Windows host. */
export function parsePackage(bytes: Uint8Array): RdhmPackage {
  if (bytes.length < HEADER) throw new Error("file is too short for an rdhm header");
  if (
    bytes[0] !== 0x72 || // r
    bytes[1] !== 0x64 || // d
    bytes[2] !== 0x68 || // h
    bytes[3] !== 0x6d // m
  ) {
    throw new Error("not an rdhm firmware package");
  }

  const headerVersion = u32At(bytes, 4);
  if (headerVersion !== 1) {
    throw new Error(`unsupported rdhm header version ${headerVersion}`);
  }

  const count = u32At(bytes, 0x1c);
  if (count === 0 || count > MAX_ENTRIES) {
    throw new Error(`invalid component count ${count}`);
  }

  const tableEnd = HEADER + count * ENTRY;
  if (bytes.length < tableEnd) throw new Error("truncated component table");

  const components: RdhmComponent[] = [];
  let expectedLength = tableEnd;
  for (let index = 0; index < count; index += 1) {
    const entry = HEADER + index * ENTRY;
    const offset = u32At(bytes, entry + 8);
    const size = u32At(bytes, entry + 0x0c);
    if (offset + size > bytes.length) {
      throw new Error(`component ${index} lies outside the file`);
    }
    expectedLength += size;
    components.push({
      id: u32At(bytes, entry),
      flags: u32At(bytes, entry + 4),
      targetAddress: u32At(bytes, entry + 0x10),
      version: Version.fromLe(bytes, entry + 0x18),
      data: bytes.slice(offset, offset + size),
    });
  }

  if (bytes.length !== expectedLength) {
    throw new Error(
      `file is ${bytes.length} bytes; header and components describe ${expectedLength}`,
    );
  }

  return {
    vendorId: bytes[8] | (bytes[9] << 8),
    productId: bytes[10] | (bytes[11] << 8),
    version: Version.fromLe(bytes, 0x0c),
    components,
  };
}

export function isCritical(component: RdhmComponent): boolean {
  return (component.flags & FLAG_CRITICAL) !== 0;
}
