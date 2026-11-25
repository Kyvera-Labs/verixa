/** A reproducible pseudo-random number source suitable for tests, not secrets. */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new TypeError("SeededRandom requires an integer seed");
    }
    this.state = seed >>> 0;
  }

  /** Returns a deterministic number in the half-open interval [0, 1). */
  next(): number {
    // Mulberry32: compact and deterministic across JavaScript runtimes.
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
}
