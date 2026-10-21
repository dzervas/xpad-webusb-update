/**
 * Host side of UFU: the update sequence the Windows updater runs.
 *
 * Ported from xboxctl's src/gip/updater.rs (0BSD).
 */

import {
  CMD_FIRMWARE,
  CMD_HELLO,
  CMD_SET_DEVICE_STATE,
  CMD_STATUS,
  FLAG_ACME,
  FLAG_SYSTEM,
  FRAGMENT_DATA,
  PACKET_MAX,
  type Ack,
  type Hello,
  type Packet,
  Sequence,
  ack,
  endOfFragments,
  fragment,
  isFragment,
  packet,
  parseAck,
  parseHello,
  parsePacket,
  wantsAck,
  STATE_RESET,
  STATE_START,
} from "./frame.js";
import {
  MIN_RESPONSE,
  Status,
  WRITE_BLOCK,
  type UfuComponentVersion,
  type UfuInfo,
  beginUpdate,
  blockSize,
  completeUpdate,
  getBlockHash,
  getInfo,
  getVersion,
  opName,
  parseComponentVersion,
  parseInfo,
  statusName,
  writeBlock,
} from "./ufu.js";
import { type RdhmComponent, type RdhmPackage, isCritical } from "./rdhm.js";
import type { Version } from "./version.js";

export interface Link {
  send(packet: Uint8Array): Promise<void>;
  /** Next device packet, or null after `timeoutMs`. Rejects on disconnect. */
  recv(timeoutMs: number): Promise<Uint8Array | null>;
  /** Reopen the device after it re-enumerated on USB. */
  reconnect(timeoutMs: number): Promise<void>;
}

export interface Options {
  responseTimeoutMs: number;
  writeTimeoutMs: number;
  attempts: number;
  ackTimeoutMs: number;
  resetTimeoutMs: number;
  iterations: number;
}

export const DEFAULT_OPTIONS: Options = {
  responseTimeoutMs: 4000,
  writeTimeoutMs: 6000,
  attempts: 5,
  ackTimeoutMs: 500,
  resetTimeoutMs: 120000,
  iterations: 10,
};

export type UpdateEvent =
  | { type: "info"; info: UfuInfo }
  | { type: "deviceVersion"; component: number; version: Version }
  | { type: "verified" }
  | { type: "order"; ids: number[] }
  | { type: "upToDate"; component: number }
  | { type: "begin"; component: number; version: Version; size: number }
  | {
      type: "block";
      component: number;
      address: number;
      done: number;
      total: number;
      written: boolean;
    }
  | { type: "complete"; component: number }
  | { type: "skipped"; component: number; reason: string }
  | { type: "reset" }
  | { type: "reconnected" }
  | { type: "retry"; op: number; attempt: number }
  | { type: "fragmentResend"; offset: number };

export interface PlannedComponent {
  id: number;
  device: Version;
  package: Version;
}

export interface Plan {
  info: UfuInfo;
  components: PlannedComponent[];
}

export function needsUpdate(plan: Plan): boolean {
  return plan.components.some((component) => !component.device.equals(component.package));
}

/** Partition sizes from the Windows known-device table. */
function knownPartitionSize(
  vendorId: number,
  productId: number,
  component: number,
): number | undefined {
  if (vendorId === 0x045e && productId === 0x0b12) {
    if (component === 1) return 0x5000;
    if (component === 2) return 0x21000;
    if (component === 3 || component === 4) return 0x7f000;
  }
  return undefined;
}

/**
 * Component order chosen by the Windows updater once it knows the device's
 * versions of components 2 and 3. Unknown layouts keep manifest order.
 */
export function updateOrder(
  pkg: RdhmPackage,
  device: Map<number, UfuComponentVersion>,
): RdhmComponent[] {
  const candidates = pkg.components.filter((component) => !isCritical(component));
  const partition3 =
    device.get(3)?.partitionSize ?? knownPartitionSize(pkg.vendorId, pkg.productId, 3);
  const manifest3 = candidates.find((component) => component.id === 3)?.data.length;

  let ids: number[] = [];
  if (partition3 !== undefined && manifest3 !== undefined) {
    if (!device.has(3) || (device.has(2) && manifest3 < partition3)) {
      ids = [4, 7, 3, 2, 1];
    } else {
      ids = [2, 1, 4, 7, 3];
    }
  }

  const ordered: RdhmComponent[] = [];
  for (const id of ids) {
    const component = candidates.find((candidate) => candidate.id === id);
    if (component) ordered.push(component);
  }
  for (const component of candidates) {
    if (!ordered.includes(component)) ordered.push(component);
  }
  return ordered;
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-1", data as BufferSource);
  return new Uint8Array(digest);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class Updater {
  private readonly sequence = new Sequence();
  private pending: Packet[] = [];

  constructor(
    private readonly link: Link,
    private readonly options: Options,
    private readonly emit: (event: UpdateEvent) => void,
  ) {}

  /** Send Power On and briefly watch for the controller's Hello. */
  async start(helloTimeoutMs = 500): Promise<Hello | null> {
    await this.sendSetDeviceState(STATE_START);
    const deadline = performance.now() + helloTimeoutMs;
    for (;;) {
      const packet = await this.recvPacket(deadline);
      if (!packet) return null;
      const hello = parseHello(packet);
      if (hello) return hello;
    }
  }

  async queryInfo(): Promise<UfuInfo> {
    const response = await this.expectOk(getInfo());
    const info = parseInfo(response);
    if (!info) throw new Error("malformed GetInfo response");
    return info;
  }

  /** GetVersion for one component; null if the device does not have it. */
  async queryVersion(component: number): Promise<UfuComponentVersion | null> {
    const { status, response } = await this.request(getVersion(component));
    if (status === Status.UnknownComponent) return null;
    if (status !== Status.Ok) {
      throw new Error(`GetVersion failed with status ${statusName(status)}`);
    }
    const version = parseComponentVersion(response);
    if (!version) throw new Error("malformed GetVersion response");
    return version;
  }

  private async getVersion(component: number): Promise<UfuComponentVersion> {
    const version = await this.queryVersion(component);
    if (!version) {
      throw new Error(`device has no component ${component}`);
    }
    this.emit({ type: "deviceVersion", component, version: version.version });
    return version;
  }

  /** Read-only check of the device against `pkg`. Writes nothing. */
  async plan(pkg: RdhmPackage): Promise<Plan> {
    const info = await this.queryInfo();
    this.emit({ type: "info", info });
    if (info.protocol === 1) {
      throw new Error("device uses the legacy UFU protocol 1, which is not supported");
    }
    if (info.vendorId !== pkg.vendorId || info.productId !== pkg.productId) {
      const fmt = (value: number) => `0x${value.toString(16).padStart(4, "0")}`;
      throw new Error(
        `package is for ${fmt(pkg.vendorId)}:${fmt(pkg.productId)} but the device reports ` +
          `${fmt(info.vendorId)}:${fmt(info.productId)}`,
      );
    }
    const writeSize = blockSize(info);
    if (writeSize === 0) throw new Error("device reported a zero write size");

    const device = new Map<number, UfuComponentVersion>();
    for (const component of pkg.components.filter((c) => !isCritical(c))) {
      device.set(component.id, await this.getVersion(component.id));
    }

    // Refuse packages built for another flash layout before writing anything.
    for (const component of pkg.components.filter((c) => !isCritical(c))) {
      const partition = device.get(component.id)?.partitionSize;
      if (partition !== undefined && component.data.length > partition) {
        throw new Error(
          `component ${component.id} is ${component.data.length} bytes but the device's ` +
            `partition holds ${partition}; this package does not fit this controller`,
        );
      }
    }

    const order = updateOrder(pkg, device);
    this.emit({ type: "order", ids: order.map((component) => component.id) });
    return {
      info,
      components: order.map((component) => ({
        id: component.id,
        device: device.get(component.id)!.version,
        package: component.version,
      })),
    };
  }

  /**
   * Update the device to `pkg`. Returns false if every component was already
   * up to date. Otherwise ends with the final reset.
   */
  async run(pkg: RdhmPackage): Promise<boolean> {
    const plan = await this.plan(pkg);
    const writeSize = blockSize(plan.info);
    const order = plan.components
      .map((planned) => pkg.components.find((component) => component.id === planned.id))
      .filter((component): component is RdhmComponent => component !== undefined);

    let verified = false;
    let changed = false;
    for (let pass = 0; pass < this.options.iterations; pass += 1) {
      verified = true;
      for (const component of order) {
        const version = await this.getVersion(component.id);
        if (version.version.equals(component.version)) {
          this.emit({ type: "upToDate", component: component.id });
          continue;
        }
        changed = true;
        if ((await this.updateComponent(component, writeSize)) > 0) {
          verified = false;
        }
      }
      if (verified) break;
    }
    if (!verified) {
      throw new Error(
        `device still differs from the package after ${this.options.iterations} passes`,
      );
    }
    if (!changed) return false;

    this.emit({ type: "verified" });

    // Final reset: the device powers off and reboots into the new firmware.
    this.emit({ type: "reset" });
    await this.sendSetDeviceState(STATE_RESET);
    await this.waitPowerOff(performance.now() + this.options.resetTimeoutMs);
    return true;
  }

  private async updateComponent(component: RdhmComponent, block: number): Promise<number> {
    const size = component.data.length;
    const begin = beginUpdate(
      component.id,
      component.targetAddress,
      size,
      component.version,
    );

    let resets = 0;
    for (;;) {
      const { status } = await this.request(begin);
      if (status === Status.Ok) break;
      if (status === Status.ComponentInUse) {
        this.emit({ type: "skipped", component: component.id, reason: "in use" });
        return 0;
      }
      if (status === Status.MustReset && resets < 3) {
        resets += 1;
        await this.resetAndResume(component.id);
        continue;
      }
      throw new Error(`BeginUpdate failed with status ${statusName(status)}`);
    }
    this.emit({
      type: "begin",
      component: component.id,
      version: component.version,
      size,
    });

    let written = 0;
    let offset = 0;
    while (offset < size) {
      const length = Math.min(block, size - offset);
      const address = component.targetAddress + offset;
      const data = component.data.subarray(offset, offset + length);
      const hash = await this.expectOk(getBlockHash(address, length));
      const needsWrite = !equalBytes(hash.subarray(2, 22), await sha1(data));
      if (needsWrite) {
        await this.expectOk(writeBlock(address, data));
        written += 1;
      }
      offset += length;
      this.emit({
        type: "block",
        component: component.id,
        address,
        done: offset,
        total: size,
        written: needsWrite,
      });
    }

    const { status } = await this.request(completeUpdate());
    if (status === Status.MustReset) {
      await this.resetAndResume(component.id);
    } else if (status !== Status.Ok) {
      throw new Error(`CompleteUpdate failed with status ${statusName(status)}`);
    }
    this.emit({ type: "complete", component: component.id });
    return written;
  }

  /** Reset in the middle of an update, then start the controller again. */
  private async resetAndResume(component: number): Promise<void> {
    this.emit({ type: "reset" });
    await this.sendSetDeviceState(STATE_RESET);
    const timeout =
      component === 7 ? this.options.resetTimeoutMs * 2 : this.options.resetTimeoutMs;
    const deadline = performance.now() + timeout;

    let poweredOff = false;
    for (;;) {
      let next: Packet | null;
      try {
        next = await this.recvPacket(deadline);
      } catch {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("device did not come back after reset");
        await this.link.reconnect(remaining);
        this.emit({ type: "reconnected" });
        break;
      }
      if (!next) {
        throw new Error(
          poweredOff
            ? "device did not come back after reset"
            : "device did not power off after reset",
        );
      }
      if (next.command === CMD_HELLO && poweredOff) break;
      if (
        next.command === CMD_STATUS &&
        next.payload.length > 0 &&
        (next.payload[0] & 0xc0) === 0
      ) {
        poweredOff = true;
      }
    }
    this.pending = [];
    await this.sendSetDeviceState(STATE_START);
  }

  private async waitPowerOff(deadline: number): Promise<boolean> {
    try {
      for (;;) {
        const next = await this.recvPacket(deadline);
        if (!next) return false;
        if (
          next.command === CMD_STATUS &&
          next.payload.length > 0 &&
          (next.payload[0] & 0xc0) === 0
        ) {
          return true;
        }
      }
    } catch {
      // The controller may drop off USB before its status arrives.
      return true;
    }
  }

  private async sendSetDeviceState(state: number): Promise<void> {
    const sequence = this.sequence.take();
    await this.link.send(packet(CMD_SET_DEVICE_STATE, FLAG_SYSTEM, sequence, new Uint8Array([state])));
  }

  /** Send a UFU request: one packet, or fragments with ACK handshakes. */
  private async sendMessage(payload: Uint8Array): Promise<void> {
    const flags = FLAG_SYSTEM | FLAG_ACME;
    const sequence = this.sequence.take();
    if (payload.length <= PACKET_MAX - 4) {
      await this.link.send(packet(CMD_FIRMWARE, flags, sequence, payload));
      return;
    }

    const total = payload.length;
    let offset = 0;
    let acked = 0;
    let sinceAck = 0;
    let failures = 0;
    while (offset < total) {
      const length = Math.min(FRAGMENT_DATA, total - offset);
      const end = offset + length;
      // ACK the first and last fragment, and every fifth in between.
      const wantAck = offset === 0 || end === total || sinceAck >= 4;
      await this.link.send(
        fragment(
          CMD_FIRMWARE,
          FLAG_SYSTEM,
          sequence,
          total,
          offset,
          payload.subarray(offset, end),
          wantAck,
        ),
      );
      offset = end;
      sinceAck += 1;
      if (!wantAck) continue;

      sinceAck = 0;
      const response = await this.waitAck(performance.now() + this.options.ackTimeoutMs);
      if (response && response.received >= offset) {
        acked = offset;
      } else {
        failures += 1;
        if (response) acked = Math.min(response.received, offset);
        offset = acked;
        this.emit({ type: "fragmentResend", offset });
      }
      if (failures > 8) {
        throw new Error(`fragment transfer stalled at byte ${acked} of ${total}`);
      }
    }
    await this.link.send(endOfFragments(CMD_FIRMWARE, FLAG_SYSTEM, sequence, total));
  }

  private async waitAck(deadline: number): Promise<Ack | null> {
    for (;;) {
      const next = await this.recvPacket(deadline);
      if (!next) return null;
      const response = parseAck(next);
      if (response) {
        if (response.command === CMD_FIRMWARE) return response;
        continue;
      }
      this.pending.push(next);
    }
  }

  /** Next device packet before `deadline`. ACKs packets that request one. */
  private async recvPacket(deadline: number): Promise<Packet | null> {
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return null;
      const bytes = await this.link.recv(remaining);
      if (!bytes) return null;
      const parsed = parsePacket(bytes);
      if (!parsed) continue;
      if (wantsAck(parsed)) {
        await this.link.send(ack(parsed, parsed.payload.length, 0));
      }
      return parsed;
    }
  }

  /** Send a request and wait for the matching response, with retries. */
  private async request(
    payload: Uint8Array,
  ): Promise<{ status: number; response: Uint8Array }> {
    const op = payload[0];
    const minLength = MIN_RESPONSE[op] ?? 2;
    const timeout =
      op === WRITE_BLOCK ? this.options.writeTimeoutMs : this.options.responseTimeoutMs;

    for (let attempt = 1; attempt <= this.options.attempts; attempt += 1) {
      if (attempt > 1) this.emit({ type: "retry", op, attempt });
      await this.sendMessage(payload);
      const deadline = performance.now() + timeout;
      for (;;) {
        const queued = this.pending.shift();
        const next = queued ?? (await this.recvPacket(deadline));
        if (!next) break;
        const response = next.payload;
        if (
          next.command === CMD_FIRMWARE &&
          !isFragment(next) &&
          response.length >= minLength &&
          response[0] === op
        ) {
          const status = response[1];
          if (status > Status.IncompatibleVersion) {
            throw new Error(`${opName(op)} returned unknown status ${status}`);
          }
          return { status, response };
        }
      }
    }
    throw new Error(
      `no response to ${opName(op)} after ${this.options.attempts} attempts`,
    );
  }

  private async expectOk(payload: Uint8Array): Promise<Uint8Array> {
    const { status, response } = await this.request(payload);
    if (status !== Status.Ok) {
      throw new Error(`${opName(payload[0])} failed with status ${statusName(status)}`);
    }
    return response;
  }
}
