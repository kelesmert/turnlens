import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CSV_HEADER, openCsv, parseCsvRow } from "../src/core/store/csv.js";
import { byteLength } from "../src/core/tail.js";
import { createCodexAdapter } from "../src/providers/codex/sessions.js";
import { importHistory, runWatch } from "../src/watch.js";
import type { SessionRef } from "../src/core/types.js";

/**
 * An anonymized slice of a real Codex session, produced by
 * scripts/make-fixture.mjs. The bugs this exercises were only observable in real
 * data, so the numbers below are transcriptions rather than invented cases.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "codex-abort-session.jsonl");

const SESSION: SessionRef = {
  provider: "codex",
  path: FIXTURE,
  sessionId: join("2026", "07", "22", "fixture"),
  sessionName: "Fixture session",
  lastActivityMs: 0,
};

let rows: readonly (readonly string[])[];

function column(row: readonly string[], name: (typeof CSV_HEADER)[number]): string {
  return row[CSV_HEADER.indexOf(name)] ?? "";
}

function columnValues(name: (typeof CSV_HEADER)[number]): readonly string[] {
  return rows.map((row) => column(row, name));
}

beforeAll(async () => {
  const csvPath = join(await mkdtemp(join(tmpdir(), "turnscope-watch-")), "session.csv");
  await openCsv(csvPath);

  await importHistory({
    session: SESSION,
    adapter: createCodexAdapter(),
    csvPath,
    includePromptPreview: false,
    stopAtByte: await byteLength(FIXTURE),
  });

  rows = (await readFile(csvPath, "utf8"))
    .trim()
    .split("\n")
    .slice(1)
    .map((row) => parseCsvRow(row));
});

describe("importHistory over a real Codex session", () => {
  it("records the interrupted turn as its own row instead of billing it forward", () => {
    const totals = columnValues("total_tokens").map(Number);

    expect(totals).toContain(121_334);
    expect(totals).toContain(918_542);
    expect(totals).not.toContain(1_039_876);
  });

  it("marks that row aborted so interrupted work is not read as completed", () => {
    const aborted = rows.filter((row) => column(row, "status") === "aborted");

    expect(aborted).toHaveLength(1);
    expect(Number(column(aborted[0] ?? [], "total_tokens"))).toBe(121_334);
  });

  it("records how long the interrupted turn ran before it was stopped", () => {
    const aborted = rows.filter((row) => column(row, "status") === "aborted");

    expect(column(aborted[0] ?? [], "duration_ms")).toBe("23942");
  });

  it("reproduces the turn counts taken from the session by hand", () => {
    const statuses = columnValues("status");

    expect(statuses.filter((status) => status === "completed")).toHaveLength(40);
    expect(statuses.filter((status) => status === "compacted")).toHaveLength(4);
  });

  it("attributes every tool call in the session and no more", () => {
    const calls = columnValues("tool_call_count").reduce((sum, value) => sum + Number(value), 0);

    expect(calls).toBe(350);
  });

  it("records the model and reasoning effort the session actually ran with", () => {
    expect(new Set(columnValues("model"))).toEqual(new Set(["gpt-5.6-sol"]));
    expect(new Set(columnValues("reasoning_effort"))).toEqual(new Set(["medium"]));
  });

  it("never writes a row with no tokens", () => {
    expect(columnValues("total_tokens").every((value) => Number(value) > 0)).toBe(true);
  });

  it("assigns unique, strictly increasing turn numbers", () => {
    const numbers = columnValues("turn_number").map(Number);

    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("omits the prompt preview when previews are disabled", () => {
    expect(columnValues("prompt_preview").every((value) => value === "")).toBe(true);
  });

  it("leaves the cost column empty rather than claiming a turn was free", () => {
    expect(columnValues("estimated_cost_usd").every((value) => value === "")).toBe(true);
  });

  it("leaves the source session file byte-identical", async () => {
    const before = await readFile(FIXTURE);
    await importHistory({
      session: SESSION,
      adapter: createCodexAdapter(),
      csvPath: join(await mkdtemp(join(tmpdir(), "turnscope-watch-")), "again.csv"),
      includePromptPreview: false,
      stopAtByte: await byteLength(FIXTURE),
    });

    expect(await readFile(FIXTURE)).toEqual(before);
  });

  it("does not re-record a turn when the same history is imported twice", async () => {
    const csvPath = join(await mkdtemp(join(tmpdir(), "turnscope-watch-")), "twice.csv");
    const options = {
      session: SESSION,
      adapter: createCodexAdapter(),
      csvPath,
      includePromptPreview: false,
      stopAtByte: await byteLength(FIXTURE),
    };
    await openCsv(csvPath);

    const first = await importHistory(options);
    const second = await importHistory(options);

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });
});

/**
 * Drives runWatch against a file that grows while it is being followed, which is
 * the only way the live path -- baseline seeding, tailing, live rendering -- is
 * exercised. The split point is record 95 of the fixture, the completion that
 * leaves the cumulative counter at 2,111,497; the records appended afterwards
 * carry the interrupted turn and the completion that follows it.
 */
describe("runWatch over a session that is still being written", () => {
  const SPLIT_AFTER_RECORD = 96;

  it("records the interrupted turn live, without billing it to the next turn", async () => {
    const records = (await readFile(FIXTURE, "utf8")).split("\n").filter((l) => l.trim() !== "");
    const dir = await mkdtemp(join(tmpdir(), "turnscope-live-"));
    const sessionPath = join(dir, "growing.jsonl");
    const csvPath = join(dir, "session.csv");

    await writeFile(sessionPath, `${records.slice(0, SPLIT_AFTER_RECORD).join("\n")}\n`, "utf8");

    const controller = new AbortController();
    const printed: string[] = [];
    const watching = runWatch({
      session: { ...SESSION, path: sessionPath },
      adapter: createCodexAdapter(),
      csvPath,
      includePromptPreview: false,
      signal: controller.signal,
      write: (line) => printed.push(line),
    });

    // Appended after the follower is established, so these arrive as live writes.
    await appendFile(sessionPath, `${records.slice(SPLIT_AFTER_RECORD).join("\n")}\n`, "utf8");

    const rowsWritten = await waitForRows(csvPath, 2);
    controller.abort();
    await watching;

    const totals = rowsWritten.map((row) => Number(column(row, "total_tokens")));
    const statuses = rowsWritten.map((row) => column(row, "status"));

    expect(totals).toContain(121_334);
    expect(totals).toContain(918_542);
    expect(totals).not.toContain(1_039_876);
    expect(statuses).toContain("aborted");
    expect(printed.join("\n")).toContain("aborted");
  });
});

/** Polls the CSV until it holds `count` data rows, or fails the test on timeout. */
async function waitForRows(
  csvPath: string,
  count: number,
): Promise<readonly (readonly string[])[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let contents = "";
    try {
      contents = await readFile(csvPath, "utf8");
    } catch {
      // The watcher creates the file; keep waiting.
    }

    const rows = contents
      .trim()
      .split("\n")
      .slice(1)
      .filter((row) => row.trim() !== "")
      .map((row) => parseCsvRow(row));
    if (rows.length >= count) return rows;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${count} rows in ${csvPath}`);
}
