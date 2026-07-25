import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CSV_HEADER, appendTurn, openCsv } from "../src/core/store/csv.js";
import { emptyUsage } from "../src/core/usage.js";
import type { NormalizedTurn } from "../src/core/types.js";

async function tempCsv(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "turnscope-csv-")), "session.csv");
}

function turn(overrides: Partial<NormalizedTurn> = {}): NormalizedTurn {
  return {
    provider: "codex",
    sessionId: "2026/07/22/rollout-x",
    sessionName: "Test session",
    turnNumber: 1,
    turnId: "turn-a",
    status: "completed",
    at: "2026-07-22T02:31:05.000Z",
    usage: { ...emptyUsage(), inputUncached: 100, cacheRead: 10, output: 20, total: 130 },
    toolCalls: { exec: 2 },
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    promptPreview: "",
    ...overrides,
  };
}

/** Reads one data row as a field array, honouring quoted fields. */
async function readRow(path: string, index = 0): Promise<readonly string[]> {
  const rows = (await readFile(path, "utf8")).trim().split("\n").slice(1);
  const row = rows[index] ?? "";
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (inQuotes) {
      if (char === '"') {
        if (row[i + 1] === '"') {
          current += '"';
          i += 1;
        } else inQuotes = false;
      } else current += char ?? "";
    } else if (char === '"') inQuotes = true;
    else if (char === ",") {
      fields.push(current);
      current = "";
    } else current += char ?? "";
  }
  fields.push(current);
  return fields;
}

function field(fields: readonly string[], column: (typeof CSV_HEADER)[number]): string {
  return fields[CSV_HEADER.indexOf(column)] ?? "";
}

describe("CSV_HEADER", () => {
  it("carries the status column so aborted turns stay distinguishable", () => {
    expect(CSV_HEADER).toContain("status");
  });

  it("carries both Anthropic cache-creation tiers for the future provider", () => {
    expect(CSV_HEADER).toContain("cache_creation_5m");
    expect(CSV_HEADER).toContain("cache_creation_1h");
  });
});

describe("openCsv", () => {
  it("creates the file with the header and reports empty state", async () => {
    const path = await tempCsv();

    const state = await openCsv(path);

    expect(state.maxTurnNumber).toBe(0);
    expect(state.turnIds.size).toBe(0);
    expect(await readFile(path, "utf8")).toBe(`${CSV_HEADER.join(",")}\n`);
  });

  it("creates any missing parent directories", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "turnscope-csv-")), "nested", "deep", "s.csv");

    await openCsv(path);

    expect(await readFile(path, "utf8")).toBe(`${CSV_HEADER.join(",")}\n`);
  });

  it("reads existing turn ids and the highest turn number without rewriting the file", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ turnNumber: 1, turnId: "turn-a" }));
    await appendTurn(path, turn({ turnNumber: 2, turnId: "turn-b" }));
    const before = await readFile(path, "utf8");

    const state = await openCsv(path);

    expect(state.maxTurnNumber).toBe(2);
    expect([...state.turnIds].sort()).toEqual(["turn-a", "turn-b"]);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects a file whose header does not match the current schema", async () => {
    const path = await tempCsv();
    await writeFile(path, "totally,different,header\n1,2,3\n", "utf8");

    await expect(openCsv(path)).rejects.toThrow(/header/iu);
  });

  it("replaces the header when the existing file is empty", async () => {
    const path = await tempCsv();
    await writeFile(path, "", "utf8");

    const state = await openCsv(path);

    expect(state.maxTurnNumber).toBe(0);
    expect(await readFile(path, "utf8")).toBe(`${CSV_HEADER.join(",")}\n`);
  });

  it("recovers turn ids that contain a comma", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ turnId: "weird,id" }));

    const state = await openCsv(path);

    expect(state.turnIds.has("weird,id")).toBe(true);
  });
});

describe("appendTurn", () => {
  it("writes the status and a sorted JSON tool breakdown", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ status: "aborted", turnId: "019f87c1", toolCalls: { z: 1, a: 2 } }));

    const fields = await readRow(path);

    expect(field(fields, "status")).toBe("aborted");
    expect(field(fields, "turn_id")).toBe("019f87c1");
    expect(field(fields, "tool_calls_json")).toBe('{"a":2,"z":1}');
    expect(field(fields, "tool_call_count")).toBe("3");
  });

  it("writes every token category as its own column", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(
      path,
      turn({
        usage: {
          inputUncached: 117_483,
          cacheRead: 11_008,
          cacheCreation5m: 7_492,
          cacheCreation1h: 683,
          output: 125,
          reasoning: 64,
          total: 128_496,
        },
      }),
    );

    const fields = await readRow(path);

    expect(field(fields, "input_uncached")).toBe("117483");
    expect(field(fields, "cache_read")).toBe("11008");
    expect(field(fields, "cache_creation_5m")).toBe("7492");
    expect(field(fields, "cache_creation_1h")).toBe("683");
    expect(field(fields, "output_including_reasoning")).toBe("125");
    expect(field(fields, "reasoning_subset")).toBe("64");
    expect(field(fields, "total_tokens")).toBe("128496");
  });

  it("quotes fields containing commas or quotes so the row stays parseable", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ sessionName: 'A name, with "quotes"', promptPreview: "a, b" }));

    const raw = (await readFile(path, "utf8")).trim().split("\n")[1] ?? "";
    expect(raw).toContain('"A name, with ""quotes"""');

    const fields = await readRow(path);
    expect(field(fields, "session_name")).toBe('A name, with "quotes"');
    expect(field(fields, "prompt_preview")).toBe("a, b");
  });

  it("leaves the cost column empty because native pricing is not implemented yet", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn());

    expect(field(await readRow(path), "estimated_cost_usd")).toBe("");
  });

  it("writes empty cells for absent optional values rather than the text undefined", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn());

    const fields = await readRow(path);

    expect(field(fields, "duration_ms")).toBe("");
    expect(field(fields, "primary_used_percent")).toBe("");
    expect(field(fields, "secondary_window_minutes")).toBe("");
  });

  it("writes rate limits and duration when present", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(
      path,
      turn({
        durationMs: 17_691,
        rateLimits: { primaryUsedPercent: 73, primaryWindowMinutes: 10_080 },
      }),
    );

    const fields = await readRow(path);

    expect(field(fields, "duration_ms")).toBe("17691");
    expect(field(fields, "primary_used_percent")).toBe("73");
    expect(field(fields, "primary_window_minutes")).toBe("10080");
    expect(field(fields, "secondary_used_percent")).toBe("");
  });

  it("appends rows in order without disturbing earlier ones", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ turnNumber: 1, turnId: "a" }));
    await appendTurn(path, turn({ turnNumber: 2, turnId: "b" }));

    expect(field(await readRow(path, 0), "turn_id")).toBe("a");
    expect(field(await readRow(path, 1), "turn_id")).toBe("b");
  });

  it("produces exactly one line per turn even when a preview contains a newline", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ promptPreview: "line one line two" }));

    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  });
});
