/**
 * UFU requests and responses, carried as the payload of GIP command 0x0c
 * with the system flag set.
 *
 * Ported from xboxctl's src/gip/ufu.rs (0BSD).
 */

import { Version } from "./version.js";

export const GET_INFO = 0x00;
export const GET_VERSION = 0x01;
export const BEGIN_UPDATE = 0x02;
export const GET_BLOCK_HASH = 0x03;
export const WRITE_BLOCK = 0x04;
export const COMPLETE_UPDATE = 0x05;

/** Largest WriteBlock data the host sends. */
export const MAX_WRITE = 0x1000;

/** Minimum response length per opcode; shorter responses are dropped. */
export const MIN_RESPONSE = [60, 14, 2, 22, 2, 2];

export enum Status {
  Ok = 0,
  InvalidArgument = 1,
  UnknownComponent = 2,
  MustReset = 3,
  ComponentInUse = 4,
  InvalidRange = 5,
  WriteFailure = 6,
  WriteProtected = 7,
  UpdateInProgress = 8,
  UpdateNotInProgress = 9,
  InvalidEepromCsv = 10,
  EepromReadError = 11,
  EepromWriteError = 12,
  ProtocolError = 13,
  IncompatibleVersion = 14,
}

export function statusName(status: number): string {
  return Status[status] ?? `unknown status ${status}`;
}

export function opName(op: number): string {
  switch (op) {
    case GET_INFO:
      return "GetInfo";
    case GET_VERSION:
      return "GetVersion";
    case BEGIN_UPDATE:
      return "BeginUpdate";
    case GET_BLOCK_HASH:
      return "GetBlockHash";
    case WRITE_BLOCK:
      return "WriteBlock";
    case COMPLETE_UPDATE:
      return "CompleteUpdate";
    default:
      return `Unknown opcode 0x${op.toString(16)}`;
  }
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
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

export function getInfo(): Uint8Array {
  return new Uint8Array([GET_INFO]);
}

export function getVersion(component: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = GET_VERSION;
  out.set(u32(component), 1);
  return out;
}

export function beginUpdate(
  component: number,
  address: number,
  size: number,
  version: Version,
): Uint8Array {
  const out = new Uint8Array(1 + 4 + 4 + 4 + 8);
  out[0] = BEGIN_UPDATE;
  out.set(u32(component), 1);
  out.set(u32(address), 5);
  out.set(u32(size), 9);
  out.set(version.toLe(), 13);
  return out;
}

export function getBlockHash(address: number, length: number): Uint8Array {
  const out = new Uint8Array(1 + 4 + 4);
  out[0] = GET_BLOCK_HASH;
  out.set(u32(address), 1);
  out.set(u32(length), 5);
  return out;
}

/** WriteBlock: opcode in a u32 (04 00 00 00), address, data. */
export function writeBlock(address: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length);
  out[0] = WRITE_BLOCK;
  out.set(u32(address), 4);
  out.set(data, 8);
  return out;
}

export function completeUpdate(): Uint8Array {
  return new Uint8Array([COMPLETE_UPDATE]);
}

export interface UfuInfo {
  protocol: number;
  flags: number;
  vendorId: number;
  productId: number;
  maxWrite: number;
}

export function parseInfo(payload: Uint8Array): UfuInfo | null {
  if (payload.length < MIN_RESPONSE[GET_INFO]) return null;
  return {
    protocol: payload[2],
    flags: payload[3],
    vendorId: payload[4] | (payload[5] << 8),
    productId: payload[6] | (payload[7] << 8),
    maxWrite: u32At(payload, 8),
  };
}
/** Write size the host uses: capped and rounded down to 4 bytes. */
export function blockSize(info: UfuInfo): number {
  return Math.min(info.maxWrite, MAX_WRITE) & ~3;
}

export interface UfuComponentVersion {
  component: number;
  version: Version;
  partitionSize?: number;
}

/** Magic that marks the optional partition size in a GetVersion response. */
export const PARTITION_MAGIC = 0x1a253a45;

export function parseComponentVersion(payload: Uint8Array): UfuComponentVersion | null {
  if (payload.length < MIN_RESPONSE[GET_VERSION]) return null;
  const hasPartition =
    payload.length >= 26 && u32At(payload, 14) === PARTITION_MAGIC;
  return {
    component: u32At(payload, 2),
    version: Version.fromLe(payload, 6),
    partitionSize: hasPartition ? u32At(payload, 22) : undefined,
  };
}
