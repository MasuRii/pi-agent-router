import type { OutputCaptureSummary, TailTextBuffer } from "../types";

const MAX_PENDING_CHUNKS = 12;

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

function truncateTailText(text: string, maxChars: number): string {
  if (maxChars <= 0 || !text) {
    return "";
  }

  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(-maxChars);
}

export class LazyTailTextBuffer implements TailTextBuffer {
  #pending: string[] = [];
  #retainedChars = 0;

  constructor(private readonly maxChars: number) {}

  append(piece: string): void {
    if (!piece) {
      return;
    }

    const limit = normalizePositiveInteger(this.maxChars, 1);
    if (piece.length >= limit) {
      const tail = truncateTailText(piece, limit);
      this.#pending[0] = tail;
      this.#pending.length = 1;
      this.#retainedChars = tail.length;
      return;
    }

    this.#pending.push(piece);
    this.#retainedChars += piece.length;

    if (this.#pending.length > MAX_PENDING_CHUNKS) {
      this.#compact();
    }

    if (this.#retainedChars > limit * 2) {
      this.#trimTo(limit);
    }
  }

  text(): string {
    const limit = normalizePositiveInteger(this.maxChars, 1);
    this.#trimTo(limit);
    return this.#flush();
  }

  bytes(): number {
    return Buffer.byteLength(this.text(), "utf-8");
  }

  clear(): void {
    this.#pending.length = 0;
    this.#retainedChars = 0;
  }

  #compact(): void {
    this.#pending[0] = this.#pending.join("");
    this.#pending.length = 1;
  }

  #flush(): string {
    if (this.#pending.length === 0) {
      return "";
    }

    if (this.#pending.length > 1) {
      this.#compact();
    }

    return this.#pending[0] || "";
  }

  #trimTo(maxChars: number): void {
    if (this.#retainedChars <= maxChars) {
      return;
    }

    const trimmed = truncateTailText(this.#flush(), maxChars);
    this.#pending[0] = trimmed;
    this.#pending.length = 1;
    this.#retainedChars = trimmed.length;
  }
}

type OutputSinkOptions = {
  inMemoryMaxChars: number;
};

export class SubagentOutputSink {
  readonly #tailBuffer: TailTextBuffer;
  #closed = false;
  #totalChars = 0;
  #totalBytes = 0;

  constructor(options: OutputSinkOptions) {
    this.#tailBuffer = new LazyTailTextBuffer(options.inMemoryMaxChars);
  }

  push(piece: string): void {
    if (this.#closed || !piece) {
      return;
    }

    this.#totalChars += piece.length;
    this.#totalBytes += Buffer.byteLength(piece, "utf-8");
    this.#tailBuffer.append(piece);
  }

  summarize(): OutputCaptureSummary {
    const tailText = this.#tailBuffer.text();
    return {
      tailText,
      totalChars: this.#totalChars,
      totalBytes: this.#totalBytes,
      droppedChars: Math.max(0, this.#totalChars - tailText.length),
    };
  }

  async close(): Promise<OutputCaptureSummary> {
    this.#closed = true;
    return this.summarize();
  }
}

export function createOutputSink(options: OutputSinkOptions): SubagentOutputSink {
  return new SubagentOutputSink(options);
}
