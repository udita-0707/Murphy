const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** FNV-1a, to turn a label into a 32-bit number. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small deterministic generator. Not for anything secret: it only makes test data. */
export class Rng {
  private state: number;

  /** The label gives each use its own stream, so adding a step cannot change another's ids. */
  constructor(seed: number, label: string) {
    this.state = (seed ^ hash(label)) >>> 0;
  }

  /** mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** `prefix_` followed by random base62, like `pay_29QQoUBi66xm2f`. */
  id(prefix: string, length = 14): string {
    let out = `${prefix}_`;
    for (let i = 0; i < length; i++) out += BASE62[this.int(0, BASE62.length - 1)];
    return out;
  }

  digits(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += String(this.int(0, 9));
    return out;
  }

  pick<T>(items: readonly [T, ...T[]]): T {
    return items[this.int(0, items.length - 1)] ?? items[0];
  }
}
