import { appendFile, mkdtemp, truncate as truncateFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { byteLength, followLines, readCompleteLines } from "../src/core/tail.js";

const controllers: AbortController[] = [];

afterEach(() => {
  for (const controller of controllers) controller.abort();
  controllers.length = 0;
});

function newController(): AbortController {
  const controller = new AbortController();
  controllers.push(controller);
  return controller;
}

async function tempFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "turnlens-tail-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, contents, "utf8");
  return path;
}

async function takeNext(
  iterator: AsyncGenerator<string, void, void>,
  count: number,
): Promise<string[]> {
  const lines: string[] = [];
  while (lines.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    lines.push(next.value);
  }
  return lines;
}

async function collect(iterator: AsyncGenerator<string, void, void>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of iterator) lines.push(line);
  return lines;
}

describe("byteLength", () => {
  it("reports the file size in bytes", async () => {
    expect(await byteLength(await tempFile("abcd\n"))).toBe(5);
  });
});

describe("readCompleteLines", () => {
  it("yields complete lines and skips a trailing partial line", async () => {
    const path = await tempFile('{"a":1}\n{"b":2}\n{"c":3');

    expect(await collect(readCompleteLines(path))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("stops at the requested byte offset", async () => {
    const path = await tempFile('{"a":1}\n{"b":2}\n');

    expect(await collect(readCompleteLines(path, 8))).toEqual(['{"a":1}']);
  });

  it("yields nothing for an empty file", async () => {
    expect(await collect(readCompleteLines(await tempFile("")))).toEqual([]);
  });

  it("reads lines that span more than one read chunk", async () => {
    const long = "x".repeat(200_000);
    const path = await tempFile(`${long}\nshort\n`);

    expect(await collect(readCompleteLines(path))).toEqual([long, "short"]);
  });

  it("preserves multi-byte characters split across chunk boundaries", async () => {
    const padded = `${"a".repeat(65_535)}ş`;
    const path = await tempFile(`${padded}\n`);

    expect(await collect(readCompleteLines(path))).toEqual([padded]);
  });
});

describe("followLines", () => {
  it("does not yield a line until its newline arrives", async () => {
    const path = await tempFile("");
    const controller = newController();
    const iterator = await followLines(path, 0, { pollIntervalMs: 5, signal: controller.signal });

    await appendFile(path, '{"partial":1}', "utf8");
    const pending = takeNext(iterator, 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await appendFile(path, "\n", "utf8");

    expect(await pending).toEqual(['{"partial":1}']);
  });

  it("yields lines appended after monitoring started", async () => {
    const path = await tempFile('{"before":1}\n');
    const controller = newController();
    const iterator = await followLines(path, await byteLength(path), {
      pollIntervalMs: 5,
      signal: controller.signal,
    });

    await appendFile(path, '{"after":1}\n{"later":2}\n', "utf8");

    expect(await takeNext(iterator, 2)).toEqual(['{"after":1}', '{"later":2}']);
  });

  it("re-reads from the start when the file is truncated", async () => {
    const path = await tempFile('{"first":1}\n');
    const controller = newController();
    const iterator = await followLines(path, await byteLength(path), {
      pollIntervalMs: 5,
      signal: controller.signal,
    });

    await truncateFile(path, 0);
    await appendFile(path, '{"rotated":1}\n', "utf8");

    expect(await takeNext(iterator, 1)).toEqual(['{"rotated":1}']);
  });

  it("stops when the signal is aborted", async () => {
    const path = await tempFile("");
    const controller = newController();
    const iterator = await followLines(path, 0, { pollIntervalMs: 5, signal: controller.signal });

    controller.abort();

    expect((await iterator.next()).done).toBe(true);
  });

  it("leaves the followed file unmodified", async () => {
    const path = await tempFile('{"a":1}\n');
    const sizeBefore = await byteLength(path);
    const controller = newController();
    const iterator = await followLines(path, sizeBefore, {
      pollIntervalMs: 5,
      signal: controller.signal,
    });

    await appendFile(path, '{"b":2}\n', "utf8");
    await takeNext(iterator, 1);
    controller.abort();

    expect(await byteLength(path)).toBe(sizeBefore + 8);
  });
});
