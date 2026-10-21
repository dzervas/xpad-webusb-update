/**
 * WebUSB transport for GIP: interface 0, interrupt OUT 0x02 / IN 0x82.
 *
 * WebUSB cannot detach kernel drivers, so the caller must release the
 * controller first (see the platform steps in the page).
 */

import type { Link } from "./updater.js";

const INTERFACE = 0;
// WebUSB takes the endpoint *number* (0-15), not the full endpoint address.
// transferIn() adds the IN direction bit itself, so the IN endpoint 0x82 is 2.
const ENDPOINT_IN = 0x02;
const ENDPOINT_OUT = 0x02;
const PACKET_MAX = 64;

interface Waiter {
  resolve: (value: Uint8Array | null) => void;
  reject: (error: unknown) => void;
  timer: number;
}

/** Which step of opening the device failed. */
export type UsbOpenStage = "open" | "claim";

/**
 * `device.open()` and `claimInterface()` fail for different reasons, but both
 * surface as a DOMException. Keep the stage so the page can show the right
 * udev/permission or driver-release instructions.
 */
export class UsbOpenError extends Error {
  constructor(
    readonly stage: UsbOpenStage,
    original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "UsbOpenError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebUsbLink {
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Waiter[] = [];
  private failure: Error | null = null;
  private closed = false;

  private constructor(readonly device: USBDevice) {}

  static async open(device: USBDevice): Promise<WebUsbLink> {
    try {
      if (!device.opened) await device.open();
    } catch (error) {
      throw new UsbOpenError("open", error);
    }
    try {
      if (!device.configuration) {
        await device.selectConfiguration(1);
      }
      await device.claimInterface(INTERFACE);
    } catch (error) {
      throw new UsbOpenError("claim", error);
    }
    const link = new WebUsbLink(device);
    link.startReadLoop();
    // Let the first IN transfer be submitted before the caller sends anything.
    // The restarted controller can send its Hello within milliseconds.
    await sleep(20);
    return link;
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("device is closed");
    const result = await this.device.transferOut(ENDPOINT_OUT, bytes as BufferSource);
    if (result.status !== "ok") {
      throw new Error(`USB write failed: ${result.status}`);
    }
    if (result.bytesWritten !== bytes.length) {
      throw new Error(`short USB write: ${result.bytesWritten}/${bytes.length} bytes`);
    }
  }

  async recv(timeoutMs: number): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.failure) throw this.failure;
    if (timeoutMs <= 0) return null;

    return new Promise<Uint8Array | null>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: window.setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    await this.device.close().catch(() => {});
  }

  private startReadLoop(): void {
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    while (!this.closed) {
      let result: USBInTransferResult;
      try {
        result = await this.device.transferIn(ENDPOINT_IN, PACKET_MAX);
      } catch (error) {
        if (!this.closed) this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (this.closed) return;
      if (result.status !== "ok") {
        this.fail(new Error(`USB read failed: ${result.status}`));
        return;
      }
      if (!result.data) continue;
      const view = result.data;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
      this.deliver(bytes);
    }
  }

  private deliver(bytes: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(bytes);
      return;
    }
    // Keep a bounded backlog; a stuck reader must not grow without limit.
    if (this.queue.length < 256) this.queue.push(bytes);
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

/** Owns the current link and reopens it when the controller restarts. */
export class Session implements Link {
  private link: WebUsbLink;
  private readonly vendorId: number;
  private readonly productId: number;
  private readonly serial: string | null;

  private constructor(link: WebUsbLink) {
    this.link = link;
    this.vendorId = link.device.vendorId;
    this.productId = link.device.productId;
    this.serial = link.device.serialNumber || null;
  }

  static async open(device: USBDevice): Promise<Session> {
    return new Session(await WebUsbLink.open(device));
  }

  get device(): USBDevice {
    return this.link.device;
  }

  send(packet: Uint8Array): Promise<void> {
    return this.link.send(packet);
  }

  recv(timeoutMs: number): Promise<Uint8Array | null> {
    return this.link.recv(timeoutMs);
  }

  async reconnect(timeoutMs: number): Promise<void> {
    const old = this.link.device;
    await this.link.close();
    const deadline = performance.now() + timeoutMs;
    // The old USBDevice lingers for a moment after a reset. Opening it again
    // succeeds, but the handle dies while the controller re-enumerates, so the
    // next transferOut fails. Wait for the old object to leave getDevices()
    // before opening its replacement.
    const oldGoneDeadline = Math.min(deadline, performance.now() + 5000);
    let oldGone = false;
    let lastError: unknown = null;

    while (performance.now() < deadline) {
      let devices: USBDevice[] = [];
      try {
        devices = await navigator.usb.getDevices();
      } catch (error) {
        lastError = error;
      }

      if (!oldGone) {
        if (devices.includes(old) && performance.now() < oldGoneDeadline) {
          await sleep(50);
          continue;
        }
        oldGone = true;
      }

      const match = devices.find(
        (device) =>
          device.vendorId === this.vendorId &&
          device.productId === this.productId &&
          (!this.serial || !device.serialNumber || device.serialNumber === this.serial),
      );

      if (match) {
        try {
          this.link = await WebUsbLink.open(match);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      await sleep(50);
    }

    const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
    throw new Error(
      `the controller did not come back on USB${detail}. Reconnect it and start again.`,
    );
  }

  async close(): Promise<void> {
    await this.link.close();
  }
}
