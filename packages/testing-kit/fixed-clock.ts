/** The small time source accepted by code that needs a controllable clock. */
export interface Clock {
  now(): Date;
}

/** A mutable clock for tests; each read returns an independent Date value. */
export class FixedClock implements Clock {
  private timestamp: number;

  constructor(initialTime: Date | number | string) {
    this.timestamp = new Date(initialTime).getTime();
    if (!Number.isFinite(this.timestamp)) {
      throw new RangeError("FixedClock requires a valid initial time");
    }
  }

  now(): Date {
    return new Date(this.timestamp);
  }

  set(time: Date | number | string): void {
    const timestamp = new Date(time).getTime();
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("FixedClock requires a valid time");
    }
    this.timestamp = timestamp;
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) {
      throw new RangeError("Clock advance must be a finite number");
    }
    this.timestamp += milliseconds;
  }
}
