import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CSV_HEADER, openCsv, parseCsvRow } from "../src/core/store/csv.js";
import { byteLength } from "../src/core/tail.js";
import { createCodexAdapter } from "../src/providers/codex/sessions.js";
import { describeNarrowing, importHistory, runWatch } from "../src/watch.js";
import { createPricingResolver } from "../src/pricing/resolver.js";
import {
  FULL_TABLE_WIDTH,
  MINIMUM_TABLE_WIDTH,
  selectLayout,
} from "../src/ui/live-table.js";
import type { SessionRef } from "../src/core/types.js";
import type { PricingResolver } from "../src/pricing/types.js";

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

/** Offline so the suite never touches the network, and cached outside the real home. */
async function offlineResolver(): Promise<PricingResolver> {
  return await createPricingResolver({
    offline: true,
    cachePath: join(await mkdtemp(join(tmpdir(), "turnlens-watch-pricing-")), "litellm.json"),
  });
}

function column(row: readonly string[], name: (typeof CSV_HEADER)[number]): string {
  return row[CSV_HEADER.indexOf(name)] ?? "";
}

function columnValues(name: (typeof CSV_HEADER)[number]): readonly string[] {
  return rows.map((row) => column(row, name));
}

beforeAll(async () => {
  const csvPath = join(await mkdtemp(join(tmpdir(), "turnlens-watch-")), "session.csv");
  await openCsv(csvPath);

  await importHistory({
    session: SESSION,
    adapter: createCodexAdapter(),
    csvPath,
    includePromptPreview: false,
    pricing: await offlineResolver(),
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

  /**
   * An import walks the whole transcript, so its numbers are the transcript's own
   * ordinals with no gaps. They used to be renumbered against the CSV, which made
   * the same turn's number depend on what the file already held.
   */
  it("numbers the imported turns by their place in the transcript", () => {
    const numbers = columnValues("turn_number").map(Number);

    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
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

  // Superseded by "importHistory prices turns from the embedded snapshot" below,
  // which asserts the costs are present and correct. What survives from the
  // original is the rule it was protecting: never a 0 standing in for unknown.
  it("never writes a zero cost for a turn that consumed tokens", () => {
    expect(columnValues("estimated_cost_usd").some((value) => Number(value) === 0)).toBe(false);
  });

  it("leaves the source session file byte-identical", async () => {
    const before = await readFile(FIXTURE);
    await importHistory({
      session: SESSION,
      adapter: createCodexAdapter(),
      csvPath: join(await mkdtemp(join(tmpdir(), "turnlens-watch-")), "again.csv"),
      includePromptPreview: false,
      pricing: await offlineResolver(),
      stopAtByte: await byteLength(FIXTURE),
    });

    expect(await readFile(FIXTURE)).toEqual(before);
  });

  it("does not re-record a turn when the same history is imported twice", async () => {
    const csvPath = join(await mkdtemp(join(tmpdir(), "turnlens-watch-")), "twice.csv");
    const options = {
      session: SESSION,
      adapter: createCodexAdapter(),
      csvPath,
      includePromptPreview: false,
      pricing: await offlineResolver(),
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
    const dir = await mkdtemp(join(tmpdir(), "turnlens-live-"));
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
      pricing: await offlineResolver(),
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

  /**
   * The history block answers what the session has cost so far, which the live
   * table cannot: the table only ever holds turns that closed after monitoring
   * started. Asserted here rather than in `history.test.ts` because what is
   * being checked is that `runWatch` prices the prefix at all, not how the
   * block reads.
   */
  it("prices the turns that closed before monitoring started", async () => {
    const records = (await readFile(FIXTURE, "utf8")).split("\n").filter((l) => l.trim() !== "");
    const dir = await mkdtemp(join(tmpdir(), "turnlens-history-"));
    const sessionPath = join(dir, "growing.jsonl");

    await writeFile(sessionPath, `${records.slice(0, SPLIT_AFTER_RECORD).join("\n")}\n`, "utf8");

    const controller = new AbortController();
    const printed: string[] = [];
    controller.abort();
    await runWatch({
      session: { ...SESSION, path: sessionPath },
      adapter: createCodexAdapter(),
      csvPath: join(dir, "session.csv"),
      includePromptPreview: false,
      pricing: await offlineResolver(),
      signal: controller.signal,
      write: (line) => printed.push(line),
    });

    const block = printed.join("\n");

    expect(block).toMatch(/History: \d+ turns/u);
    expect(block).toMatch(/today's rates/u);
  });

  /**
   * The number a row carries is the turn's place in the session, not its place in
   * the file it lands in. Proved by watching the same growth twice against two
   * different CSVs, one empty and one already holding a row numbered 999: if the
   * file were the source, the second run would start at 1000.
   *
   * The fixture's first 96 records hold 11 turns, so the two that close while the
   * watcher is attached are the session's 12th and 13th.
   */
  it("numbers a live turn by its place in the session, whatever the CSV holds", async () => {
    const records = (await readFile(FIXTURE, "utf8")).split("\n").filter((l) => l.trim() !== "");

    const numbersWith = async (seed?: string): Promise<readonly string[]> => {
      const dir = await mkdtemp(join(tmpdir(), "turnlens-number-"));
      const sessionPath = join(dir, "growing.jsonl");
      const csvPath = join(dir, "session.csv");
      await writeFile(sessionPath, `${records.slice(0, SPLIT_AFTER_RECORD).join("\n")}\n`, "utf8");
      if (seed !== undefined) await writeFile(csvPath, seed, "utf8");

      const controller = new AbortController();
      const watching = runWatch({
        session: { ...SESSION, path: sessionPath },
        adapter: createCodexAdapter(),
        csvPath,
        includePromptPreview: false,
        pricing: await offlineResolver(),
        signal: controller.signal,
        write: () => undefined,
      });

      await appendFile(sessionPath, `${records.slice(SPLIT_AFTER_RECORD).join("\n")}\n`, "utf8");
      const written = await waitForRows(csvPath, seed === undefined ? 2 : 3);
      controller.abort();
      await watching;

      // The first two recorded, because appending the rest of the fixture closes
      // more turns than this is about and how many land before the abort is a race.
      return written
        .map((row) => column(row, "turn_number"))
        .filter((value) => value !== "999")
        .slice(0, 2);
    };

    const seededRow = CSV_HEADER.map((name) => (name === "turn_number" ? "999" : "")).join(",");

    expect(await numbersWith()).toEqual(["12", "13"]);
    expect(await numbersWith(`${CSV_HEADER.join(",")}\n${seededRow}\n`)).toEqual(["12", "13"]);
  });

  it("says nothing about history for a session with nothing closed yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "turnlens-history-empty-"));
    const sessionPath = join(dir, "empty.jsonl");
    await writeFile(sessionPath, "", "utf8");

    const controller = new AbortController();
    const printed: string[] = [];
    controller.abort();
    await runWatch({
      session: { ...SESSION, path: sessionPath },
      adapter: createCodexAdapter(),
      csvPath: join(dir, "session.csv"),
      includePromptPreview: false,
      pricing: await offlineResolver(),
      signal: controller.signal,
      write: (line) => printed.push(line),
    });

    expect(printed.join("\n")).not.toContain("History:");
  });
});

describe("describeNarrowing", () => {
  it("says nothing when every column is shown", () => {
    expect(describeNarrowing(selectLayout(undefined), undefined)).toEqual([]);
    expect(describeNarrowing(selectLayout(FULL_TABLE_WIDTH), FULL_TABLE_WIDTH)).toEqual([]);
  });

  /**
   * A message about a terminal being too narrow, wrapped by that terminal, is
   * the defect it is reporting.
   */
  it("fits the terminal it is complaining about", () => {
    for (let width = 60; width <= FULL_TABLE_WIDTH; width += 1) {
      for (const line of describeNarrowing(selectLayout(width), width)) {
        expect(line.length).toBeLessThanOrEqual(Math.max(width, MINIMUM_TABLE_WIDTH));
      }
    }
  });

  /**
   * The user's question on seeing a short table is "where did the rest go", and
   * the answer has three parts: how wide the terminal is, how wide it would have
   * to be, and what to do about it.
   */
  it("reports the width it has, the width it needs, and how to get there", () => {
    const notice = describeNarrowing(selectLayout(120), 120).join(" ");

    expect(notice).toContain("120");
    expect(notice).toContain(String(FULL_TABLE_WIDTH));
    expect(notice).toContain("11");
    expect(notice).toContain("COLUMNS");
  });

  /**
   * The advice is only usable if it is the syntax the reader's shell accepts.
   * PowerShell does not understand a leading `NAME=value`, and a POSIX shell
   * does not understand `$env:`.
   */
  it("spells the override the way the user's own shell spells it", () => {
    const windows = describeNarrowing(selectLayout(120), 120, "win32").join(" ");
    const posix = describeNarrowing(selectLayout(120), 120, "linux").join(" ");

    expect(windows).toContain(`$env:COLUMNS=${FULL_TABLE_WIDTH}`);
    expect(posix).toContain(`COLUMNS=${FULL_TABLE_WIDTH}`);
    expect(posix).not.toContain("$env:");
  });

  it("warns that rows will wrap when even the narrowest table will not fit", () => {
    const tooNarrow = MINIMUM_TABLE_WIDTH - 1;
    const notice = describeNarrowing(selectLayout(tooNarrow), tooNarrow).join(" ");

    expect(notice).toContain("wrap");
  });
});

describe("runWatch in a narrow terminal", () => {
  it("prints the notice above a table whose rows match its header", async () => {
    const records = (await readFile(FIXTURE, "utf8")).split("\n").filter((l) => l.trim() !== "");
    const dir = await mkdtemp(join(tmpdir(), "turnlens-narrow-"));
    const sessionPath = join(dir, "growing.jsonl");
    const csvPath = join(dir, "session.csv");

    await writeFile(sessionPath, `${records.slice(0, 96).join("\n")}\n`, "utf8");

    const controller = new AbortController();
    const printed: string[] = [];
    const watching = runWatch({
      session: { ...SESSION, path: sessionPath },
      adapter: createCodexAdapter(),
      csvPath,
      includePromptPreview: false,
      pricing: await offlineResolver(),
      signal: controller.signal,
      terminalWidth: 100,
      write: (line) => printed.push(line),
    });

    await appendFile(sessionPath, `${records.slice(96).join("\n")}\n`, "utf8");
    await waitForRows(csvPath, 2);
    controller.abort();
    await watching;

    // The notice may take more than one line, so the rule locates the header
    // rather than a fixed index. The history block precedes the notice, so the
    // notice is located by its content rather than by position too.
    const rule = printed.findIndex((line) => /^-+$/u.test(line));

    expect(printed.slice(0, rule).join("\n")).toContain("100");
    expect(rule).toBeGreaterThan(0);
    expect(printed[rule - 1]).toHaveLength(selectLayout(100).width);

    // Every table row, skipping the notice, the header, the rule, and the tool
    // breakdown lines that follow a row rather than replacing it. A row cannot
    // be told from a breakdown by its indent: the turn-number column survives
    // at this width and is right-aligned, so rows begin with spaces too.
    const rows = printed.slice(rule + 1).filter((line) => !line.includes("Tool calls:"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toHaveLength(selectLayout(100).width);
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

describe("importHistory prices turns from the embedded snapshot", () => {
  // 4018 * 5e-6 + 11008 * 5e-7 + 415 * 3e-5 = 0.038044
  it("prices the first turn of the fixture at the published rates", () => {
    const first = rows[0] ?? [];

    expect(column(first, "model")).toBe("gpt-5.6-sol");
    expect(column(first, "estimated_cost_usd")).toBe("0.038044");
    expect(column(first, "cost_status")).toBe("priced");
    expect(column(first, "pricing_version")).toMatch(/^litellm@sha256:[0-9a-f]{12}$/u);
  });

  it("prices every turn of the fixture, since its model is a known one", () => {
    expect(columnValues("cost_status").every((status) => status === "priced")).toBe(true);
    expect(columnValues("estimated_cost_usd").every((cost) => Number(cost) > 0)).toBe(true);
  });

  // The aborted turn must carry its own cost, not the next turn's.
  it("prices the aborted turn separately", () => {
    const aborted = rows.filter((row) => column(row, "status") === "aborted");

    expect(Number(column(aborted[0] ?? [], "estimated_cost_usd"))).toBeGreaterThan(0);
    expect(column(aborted[0] ?? [], "cost_status")).toBe("priced");
  });
});
