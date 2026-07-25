import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { FileHandle } from "node:fs/promises";

export interface TailOptions {
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_POLL_INTERVAL_MS = 200;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * How many trailing bytes are remembered to detect that the file was rewritten.
 *
 * Comparing sizes alone is not enough: a truncate followed by a fast append can
 * leave the file longer than the last read offset, so the shrink is never
 * observed by polling. Re-reading the bytes just before the offset catches it.
 */
const ANCHOR_BYTES = 16;

export async function byteLength(path: string): Promise<number> {
  return (await stat(path)).size;
}

/**
 * Yields newline-terminated lines already present in the file, in order.
 *
 * A trailing line without a newline is not yielded: the writer may still be
 * mid-record. Pass `stopAtByte` to read only the prefix that existed at a
 * captured offset, which is how backfill avoids racing the live reader.
 */
export async function* readCompleteLines(
  path: string,
  stopAtByte?: number,
): AsyncGenerator<string, void, void> {
  const handle = await open(path, "r");
  const reader = new LineReader();

  try {
    const limit = stopAtByte ?? Number.POSITIVE_INFINITY;
    let position = 0;

    while (position < limit) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, limit - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return;

      position += bytesRead;
      yield* reader.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

/**
 * Follows a growing file from `startByte`, yielding only complete lines.
 *
 * A partially written record is held until its newline arrives, so a reader
 * never sees truncated JSON. If the file shrinks it is treated as rotated and
 * reading restarts from byte 0, which the previous Python implementation could
 * not detect (known-bugs.md P3-2). The file is opened read-only.
 */
export async function followLines(
  path: string,
  startByte: number,
  options: TailOptions = {},
): Promise<AsyncGenerator<string, void, void>> {
  // Opened and anchored before returning: an async generator body would not run
  // until the first next(), leaving a window where the file could be rewritten
  // between capturing startByte and reading it.
  const handle = await open(path, "r");
  return streamLines(handle, path, startByte, await readAnchor(handle, startByte), options);
}

async function* streamLines(
  initialHandle: FileHandle,
  path: string,
  startByte: number,
  initialAnchor: Buffer,
  options: TailOptions,
): AsyncGenerator<string, void, void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const signal = options.signal;

  let handle: FileHandle = initialHandle;
  let reader = new LineReader();
  let position = startByte;
  let anchor = initialAnchor;

  const restart = async (): Promise<void> => {
    await handle.close();
    handle = await open(path, "r");
    reader = new LineReader();
    position = 0;
    anchor = Buffer.alloc(0);
  };

  try {
    while (signal?.aborted !== true) {
      const size = await byteLength(path);

      if (size < position) {
        await restart();
        continue;
      }

      if (size === position) {
        await delay(pollIntervalMs, signal);
        continue;
      }

      if (!(await anchorStillMatches(handle, position, anchor))) {
        await restart();
        continue;
      }

      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        await delay(pollIntervalMs, signal);
        continue;
      }

      position += bytesRead;
      anchor = Buffer.concat([anchor, chunk.subarray(0, bytesRead)]).subarray(-ANCHOR_BYTES);
      yield* reader.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

async function readAnchor(handle: FileHandle, position: number): Promise<Buffer> {
  const length = Math.min(ANCHOR_BYTES, position);
  if (length === 0) return Buffer.alloc(0);

  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position - length);
  return buffer.subarray(0, bytesRead);
}

/** Detects a rewrite by confirming the bytes just before `position` are unchanged. */
async function anchorStillMatches(
  handle: FileHandle,
  position: number,
  anchor: Buffer,
): Promise<boolean> {
  if (anchor.length === 0) return true;

  const current = Buffer.alloc(anchor.length);
  const { bytesRead } = await handle.read(current, 0, anchor.length, position - anchor.length);
  return bytesRead === anchor.length && current.equals(anchor);
}

/**
 * Splits a byte stream into lines.
 *
 * Uses StringDecoder so a multi-byte character straddling a chunk boundary is
 * buffered rather than decoded into replacement characters.
 */
class LineReader {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";

  *push(chunk: Buffer): Generator<string, void, void> {
    this.#buffer += this.#decoder.write(chunk);

    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      yield this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
