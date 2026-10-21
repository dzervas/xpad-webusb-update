/**
 * GIP packet headers, fragmentation and Protocol Control ACKs.
 *
 * Ported from xboxctl's src/gip/frame.rs (0BSD) and MS-GIPUSB.
 */

import { Version } from "./version.js";

/** Largest GIP packet on the controller's 64-byte interrupt endpoints. */
export const PACKET_MAX = 64;

export const FLAG_ACME = 0x10;
export const FLAG_SYSTEM = 0x20;
export const FLAG_INIT_FRAG = 0x40;
export const FLAG_FRAGMENT = 0x80;

export const CMD_ACK = 0x01;
export const CMD_HELLO = 0x02;
export const CMD_STATUS = 0x03;
export const CMD_SET_DEVICE_STATE = 0x05;
export const CMD_RUMBLE = 0x09;
export const CMD_FIRMWARE = 0x0c;

export const STATE_START = 0x00;
export const STATE_RESET = 0x07;

/** Fragment headers are always 6 bytes; MS-GIPUSB requires even host headers. */
const FRAGMENT_HEADER = 6;
/** Data bytes per fragment. */
export const FRAGMENT_DATA = PACKET_MAX - FRAGMENT_HEADER;

export interface Packet {
  command: number;
  flags: number;
  sequence: number;
  /** For fragments: total length (first fragment) or offset (later ones). */
  totalOrOffset?: number;
  payload: Uint8Array;
}

export function readVarint(bytes: Uint8Array, pos: { value: number }): number | null {
  let value = 0;
  for (const shift of [0, 7, 14, 21]) {
    if (pos.value >= bytes.length) return null;
    const byte = bytes[pos.value];
    pos.value += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
  }
  return null;
}

export function parsePacket(bytes: Uint8Array): Packet | null {
  if (bytes.length < 4) return null;
  const pos = { value: 3 };
  const length = readVarint(bytes, pos);
  if (length === null) return null;

  let totalOrOffset: number | undefined;
  if (bytes[1] & FLAG_FRAGMENT) {
    const value = readVarint(bytes, pos);
    if (value === null) return null;
    totalOrOffset = value;
  }

  const end = pos.value + length;
  if (end > bytes.length) return null;
  return {
    command: bytes[0],
    flags: bytes[1],
    sequence: bytes[2],
    totalOrOffset,
    payload: bytes.slice(pos.value, end),
  };
}

export function wantsAck(packet: Packet): boolean {
  return (packet.flags & FLAG_ACME) !== 0 && packet.command !== CMD_ACK;
}

export function isFragment(packet: Packet): boolean {
  return (packet.flags & FLAG_FRAGMENT) !== 0;
}

/** Build an unfragmented packet. `payload` must fit one packet. */
export function packet(
  command: number,
  flags: number,
  sequence: number,
  payload: Uint8Array,
): Uint8Array {
  if (payload.length > PACKET_MAX - 4) {
    throw new Error(`payload of ${payload.length} bytes needs fragmenting`);
  }
  const out = new Uint8Array(4 + payload.length);
  out[0] = command;
  out[1] = flags;
  out[2] = sequence;
  out[3] = payload.length;
  out.set(payload, 4);
  return out;
}

/** Two-byte varint used to pad fragment headers to an even length. */
function paddedVarint(value: number): Uint8Array {
  return new Uint8Array([(value & 0x7f) | 0x80, (value >> 7) & 0xff]);
}

/**
 * Build one fragment of a large message. `offset` is the fragment's position
 * in the full message; the first fragment carries `total` instead.
 */
export function fragment(
  command: number,
  flags: number,
  sequence: number,
  total: number,
  offset: number,
  data: Uint8Array,
  ack: boolean,
): Uint8Array {
  if (data.length > FRAGMENT_DATA) {
    throw new Error(`fragment of ${data.length} bytes is too large`);
  }
  let fragmentFlags = flags | FLAG_FRAGMENT;
  const first = offset === 0 && data.length > 0;
  if (first) fragmentFlags |= FLAG_INIT_FRAG;
  if (ack) fragmentFlags |= FLAG_ACME;

  const out = new Uint8Array(4 + 2 + data.length);
  out[0] = command;
  out[1] = fragmentFlags;
  out[2] = sequence;
  out[3] = data.length;
  out.set(paddedVarint(first ? total : offset), 4);
  out.set(data, 6);
  return out;
}

/** The zero-length fragment that ends a fragmented message. */
export function endOfFragments(
  command: number,
  flags: number,
  sequence: number,
  total: number,
): Uint8Array {
  return fragment(command, flags & ~FLAG_ACME, sequence, total, total, new Uint8Array(0), false);
}

export interface Ack {
  command: number;
  received: number;
  remaining: number;
}

export function ack(acked: Packet, sequenceReceived: number, remaining: number): Uint8Array {
  const payload = new Uint8Array(9);
  payload[1] = acked.command;
  payload[2] = FLAG_SYSTEM | (acked.flags & 0x0f);
  payload[3] = sequenceReceived & 0xff;
  payload[4] = (sequenceReceived >> 8) & 0xff;
  payload[7] = remaining & 0xff;
  payload[8] = (remaining >> 8) & 0xff;
  return packet(CMD_ACK, FLAG_SYSTEM, acked.sequence, payload);
}

export function parseAck(packet: Packet): Ack | null {
  if (packet.command !== CMD_ACK || packet.payload.length < 9) return null;
  const p = packet.payload;
  return {
    command: p[1],
    received: p[3] | (p[4] << 8),
    remaining: p[7] | (p[8] << 8),
  };
}

export interface Hello {
  deviceId: Uint8Array;
  vendorId: number;
  productId: number;
  firmware: Version;
  hardware: Uint8Array;
}

export function parseHello(packet: Packet): Hello | null {
  const p = packet.payload;
  if (packet.command !== CMD_HELLO || p.length < 28) return null;
  return {
    deviceId: p.slice(0, 8),
    vendorId: p[8] | (p[9] << 8),
    productId: p[10] | (p[11] << 8),
    firmware: Version.fromLe(p, 12),
    hardware: p.slice(20, 28),
  };
}

/** Sequence numbers run 1..=255; zero is skipped. */
export class Sequence {
  private value = 1;

  take(): number {
    const current = this.value;
    this.value = (this.value + 1) & 0xff;
    if (this.value === 0) this.value = 1;
    return current;
  }
}

export function hex(bytes: Uint8Array, separator = " "): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(separator);
}
