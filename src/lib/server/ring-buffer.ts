/**
 * A fixed-capacity circular buffer.
 *
 * Live charts hydrate from one of these instead of querying SQLite, which is
 * what keeps opening the dashboard a single sub-millisecond read regardless of
 * how much history has accumulated on disk.
 */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0; // next write position
  private len = 0;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.buf = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.len < this.capacity) this.len++;
  }

  get size(): number {
    return this.len;
  }

  /** Oldest → newest. Pass `count` to take only the most recent N. */
  toArray(count?: number): T[] {
    const n = count === undefined ? this.len : Math.min(count, this.len);
    const out: T[] = new Array(n);
    // Walk back `n` from the write head, wrapping.
    let idx = (this.head - n + this.capacity * 2) % this.capacity;
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[idx] as T;
      idx = (idx + 1) % this.capacity;
    }
    return out;
  }

  last(): T | undefined {
    if (this.len === 0) return undefined;
    return this.buf[(this.head - 1 + this.capacity) % this.capacity];
  }

  clear(): void {
    this.buf = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.len = 0;
  }
}
