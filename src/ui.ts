/** Small DOM/formatting helpers shared by every controller tool. */

export type StatusKind = "" | "ok" | "error" | "busy" | "warn";

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id} in index.html`);
  return element as T;
}

export function setStatus(element: HTMLElement, text: string, kind: StatusKind = ""): void {
  element.textContent = text;
  element.className = kind ? `status ${kind}` : "status";
}

export function clear(element: HTMLElement): void {
  element.replaceChildren();
}

export function addKv(dl: HTMLElement, term: string, value: string | Node): void {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  if (typeof value === "string") dd.textContent = value;
  else dd.append(value);
  dl.append(dt, dd);
}

export function addCell(row: HTMLTableRowElement, text: string, className = ""): void {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

const byteNumber = new Intl.NumberFormat("en-US");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${byteNumber.format(bytes)} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB (${byteNumber.format(bytes)} B)`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB (${byteNumber.format(bytes)} B)`;
}

export function compactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function compareVersions(a: string, b: string): number | null {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  if (
    left.length !== 4 ||
    right.length !== 4 ||
    left.some((part) => !Number.isFinite(part)) ||
    right.some((part) => !Number.isFinite(part))
  ) {
    return null;
  }
  for (let i = 0; i < 4; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export type LogKind = "" | "ok" | "warn" | "err";

/** A scrollback-limited, timestamped activity log. */
export class LogView {
  constructor(
    private readonly element: HTMLElement,
    private readonly maxLines = 600,
  ) {}

  log(message: string, kind: LogKind = ""): void {
    const line = document.createElement("span");
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = `${new Date().toLocaleTimeString("en-GB")} `;
    const text = document.createElement("span");
    if (kind) text.className = kind;
    text.textContent = `${message}\n`;
    line.append(time, text);
    this.element.append(line);
    while (this.element.childElementCount > this.maxLines) {
      this.element.firstElementChild?.remove();
    }
    this.element.scrollTop = this.element.scrollHeight;
  }
}
