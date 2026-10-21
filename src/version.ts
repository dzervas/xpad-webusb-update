/** A four-part little-endian version, as used by GIP and rdhm. */
export class Version {
  readonly parts: readonly [number, number, number, number];

  constructor(parts: readonly [number, number, number, number]) {
    this.parts = [parts[0], parts[1], parts[2], parts[3]];
  }

  static fromLe(bytes: Uint8Array, offset = 0): Version {
    return new Version([
      bytes[offset] | (bytes[offset + 1] << 8),
      bytes[offset + 2] | (bytes[offset + 3] << 8),
      bytes[offset + 4] | (bytes[offset + 5] << 8),
      bytes[offset + 6] | (bytes[offset + 7] << 8),
    ]);
  }

  toLe(): Uint8Array {
    const out = new Uint8Array(8);
    for (let i = 0; i < 4; i += 1) {
      out[i * 2] = this.parts[i] & 0xff;
      out[i * 2 + 1] = (this.parts[i] >> 8) & 0xff;
    }
    return out;
  }

  equals(other: Version): boolean {
    return this.compare(other) === 0;
  }

  compare(other: Version): number {
    for (let i = 0; i < 4; i += 1) {
      const diff = this.parts[i] - other.parts[i];
      if (diff !== 0) return diff;
    }
    return 0;
  }

  toString(): string {
    return this.parts.join(".");
  }
}
