/**
 * Bounded log storage for one supervised process.
 *
 * vLLM is chatty — CUDA graph capture alone emits hundreds of lines in a burst.
 * Keeping a hard cap in memory (and appending everything to a file for
 * post-mortem) means a noisy startup can't grow the heap without bound, and the
 * UI always has a cheap, complete-enough tail to render.
 */

export interface LogLine {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr";
  text: string;
}

export class LogRing {
  private lines: LogLine[] = [];
  private seq = 0;

  constructor(private readonly capacity = 5000) {}

  append(stream: "stdout" | "stderr", text: string): LogLine {
    const line: LogLine = { seq: this.seq++, ts: Date.now(), stream, text };
    this.lines.push(line);
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
    return line;
  }

  /** Most recent `count` lines, oldest first. */
  tail(count = 500): LogLine[] {
    return count >= this.lines.length ? [...this.lines] : this.lines.slice(-count);
  }

  /** Everything after a sequence number, for resuming a dropped stream. */
  since(seq: number): LogLine[] {
    return this.lines.filter((l) => l.seq > seq);
  }

  get nextSeq(): number {
    return this.seq;
  }
}

/**
 * Splits a chunk of process output into complete lines, holding any partial
 * trailing line until the rest of it arrives.
 */
export class LineSplitter {
  private partial = "";

  push(chunk: string): string[] {
    const combined = this.partial + chunk;
    const parts = combined.split("\n");
    this.partial = parts.pop() ?? "";
    // Guard against a process that emits a huge line with no newline at all.
    if (this.partial.length > 64_000) {
      const forced = this.partial;
      this.partial = "";
      parts.push(forced);
    }
    return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  }

  flush(): string[] {
    if (!this.partial) return [];
    const out = [this.partial];
    this.partial = "";
    return out;
  }
}
