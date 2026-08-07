import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CSV_HEADER,
  appendTurn,
  openCsv,
  parseCsvRow,
  readRecordedKeys,
  turnRowKey,
} from "../src/core/store/csv.js";
import { emptyUsage } from "../src/core/usage.js";
import type { NormalizedTurn } from "../src/core/types.js";
import type { CostStatus } from "../src/pricing/types.js";

async function tempCsv(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "turnlens-csv-")), "session.csv");
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
    costStatus: "priced",
    costUsd: 0.038_044,
    pricingVersion: "litellm@sha256:0123456789ab",
    ...overrides,
  };
}

/**
 * A turn the resolver could not price.
 *
 * `costUsd` is omitted rather than set to `undefined`, because
 * `exactOptionalPropertyTypes` treats those as different types and the absent
 * one is what the pipeline actually produces.
 */
function unpricedTurn(costStatus: CostStatus): NormalizedTurn {
  const { costUsd, ...rest } = turn();
  void costUsd;
  return { ...rest, costStatus };
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

describe("turnRowKey", () => {
  // Codex closes a turn at a context compaction and then reports task_complete
  // carrying the same turn id. Keying rows on the id alone discarded the second
  // row: 4,134,039 tokens and 59 tool calls across four turns of a real session.
  it("separates a compaction from the completion that reports the same turn id", () => {
    const compacted = turnRowKey({ turnId: "019f87c7", status: "compacted", at: "t1" });
    const completed = turnRowKey({ turnId: "019f87c7", status: "completed", at: "t2" });

    expect(compacted).not.toBe(completed);
  });

  it("is stable for the same row so a re-import records nothing twice", () => {
    const identity = { turnId: "019f87c7", status: "completed", at: "t1" };

    expect(turnRowKey(identity)).toBe(turnRowKey({ ...identity }));
  });

  it("does not merge two rows whose fields differ only in where a boundary falls", () => {
    expect(turnRowKey({ turnId: "a", status: "b", at: "c" })).not.toBe(
      turnRowKey({ turnId: "a b", status: "c", at: "" }),
    );
  });
});

describe("openCsv", () => {
  it("creates the file with the header", async () => {
    const path = await tempCsv();

    await openCsv(path);

    expect(await readFile(path, "utf8")).toBe(`${CSV_HEADER.join(",")}\n`);
  });

  it("creates any missing parent directories", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "turnlens-csv-")), "nested", "deep", "s.csv");

    await openCsv(path);

    expect(await readFile(path, "utf8")).toBe(`${CSV_HEADER.join(",")}\n`);
  });

  /**
   * Opening a populated file used to parse every row, which is how the CSV
   * became an input. It now reads the header and nothing else, so the one thing
   * that must still hold is that opening changes nothing.
   */
  it("leaves an existing file byte-identical", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ turnNumber: 1, turnId: "turn-a" }));
    await appendTurn(path, turn({ turnNumber: 2, turnId: "turn-b", at: "2026-07-22T02:40:00.000Z" }));
    const before = await readFile(path, "utf8");

    await openCsv(path);

    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("distinguishes a compaction from a completion sharing one turn id", () => {
    const compacted = turn({ turnNumber: 1, turnId: "shared", status: "compacted", at: "t1" });
    const completed = turn({ turnNumber: 2, turnId: "shared", status: "completed", at: "t2" });

    expect(turnRowKey(compacted)).not.toBe(turnRowKey(completed));
  });

  it("rejects a file whose header does not match the current schema", async () => {
    const path = await tempCsv();
    await writeFile(path, "totally,different,header\n1,2,3\n", "utf8");

    await expect(openCsv(path)).rejects.toThrow(/header/iu);
  });

  it("replaces the header when the existing file is empty", async () => {
    const path = await tempCsv();
    await writeFile(path, "", "utf8");

    await openCsv(path);

    expect(await readFile(path, "utf8")).toBe(`${CSV_HEADER.join(",")}\n`);
  });

  /**
   * Nothing in `src/` reads a CSV any more, and this is why `parseCsvRow` is
   * still exported: a written row has to remain recoverable, and checking that
   * needs the writer's inverse.
   */
  it("writes a turn id containing a comma so it can be read back whole", async () => {
    const path = await tempCsv();
    await openCsv(path);
    const recorded = turn({ turnId: "weird,id" });
    await appendTurn(path, recorded);

    const [row = []] = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => parseCsvRow(line));

    expect(field(row, "turn_id")).toBe("weird,id");
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

  it("writes empty cells for absent optional values rather than the text undefined", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn());

    const fields = await readRow(path);

    expect(field(fields, "duration_ms")).toBe("");
  });

  it("writes duration when present", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ durationMs: 17_691 }));

    const fields = await readRow(path);

    expect(field(fields, "duration_ms")).toBe("17691");
  });

  it("appends rows in order without disturbing earlier ones", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ turnNumber: 1, turnId: "a" }));
    await appendTurn(path, turn({ turnNumber: 2, turnId: "b" }));

    expect(field(await readRow(path, 0), "turn_id")).toBe("a");
    expect(field(await readRow(path, 1), "turn_id")).toBe("b");
  });

  it("produces exactly one line per turn even when a field contains a newline", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ promptPreview: "line one\nline two", sessionName: "a\r\nb" }));

    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);

    const fields = await readRow(path);
    expect(field(fields, "prompt_preview")).toBe("line one line two");
    expect(field(fields, "session_name")).toBe("a b");
  });

  // A newline inside a field would split the row across physical lines, and the
  // trailing fragment then reads as a row of its own. That fabricates a turn id,
  // which would make the next real turn look like a duplicate and be skipped.
  it("cannot have a row fabricated by a newline inside a field", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(
      path,
      turn({ turnNumber: 1, turnId: "turn-a", promptPreview: "one\n9,9,9,9,42,injected,x" }),
    );

    const rows = (await readFile(path, "utf8")).trim().split("\n").slice(1);

    expect(rows).toHaveLength(1);
    expect(field(parseCsvRow(rows[0] ?? ""), "turn_number")).toBe("1");
  });
});

describe("appendTurn records cost", () => {
  it("writes the cost with six decimals so small turns are not rounded to zero", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ costUsd: 0.000_123_4 }));

    const fields = await readRow(path);
    expect(field(fields, "estimated_cost_usd")).toBe("0.000123");
    expect(field(fields, "cost_status")).toBe("priced");
    expect(field(fields, "pricing_version")).toBe("litellm@sha256:0123456789ab");
  });

  it("writes a real turn cost", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn({ costUsd: 0.038_044 }));

    expect(field(await readRow(path), "estimated_cost_usd")).toBe("0.038044");
  });

  // An empty cell does not enter a spreadsheet sum; a 0 does. That difference is
  // the whole reason unknown is never written as zero.
  it("leaves the cost empty and records why when a turn cannot be priced", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, unpricedTurn("model_unknown"));

    const fields = await readRow(path);
    expect(field(fields, "estimated_cost_usd")).toBe("");
    expect(field(fields, "cost_status")).toBe("model_unknown");
  });

  it("leaves the cost empty for a turn whose model has an incomplete rate table", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, unpricedTurn("no_pricing_data"));

    const fields = await readRow(path);
    expect(field(fields, "estimated_cost_usd")).toBe("");
    expect(field(fields, "cost_status")).toBe("no_pricing_data");
  });

  it("keeps one physical line per turn after the schema change", async () => {
    const path = await tempCsv();
    await openCsv(path);
    await appendTurn(path, turn());
    await appendTurn(path, turn({ turnNumber: 2, turnId: "turn-b" }));

    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(3);
  });
});

describe("openCsv and the pricing schema change", () => {
  it("refuses a file written by the previous schema and names what changed", async () => {
    const path = await tempCsv();
    const oldHeader = CSV_HEADER.filter(
      (column) => column !== "cost_status" && column !== "pricing_version",
    ).join(",");
    await writeFile(path, `${oldHeader}\n`, "utf8");

    await expect(openCsv(path)).rejects.toThrow(/cost_status/u);
    await expect(openCsv(path)).rejects.toThrow(/pricing_version/u);
  });

  // Refusing is only acceptable if the user's data survives untouched.
  it("leaves a rejected file byte-identical", async () => {
    const path = await tempCsv();
    const oldHeader = CSV_HEADER.filter(
      (column) => column !== "cost_status" && column !== "pricing_version",
    ).join(",");
    const before = `${oldHeader}\n2026-07-22T02:31:05.000Z,codex,s,n,1,turn-a,completed\n`;
    await writeFile(path, before, "utf8");

    await expect(openCsv(path)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

describe("readRecordedKeys", () => {
  /**
   * The only read of a CSV left in the program, and it exists for one operation:
   * merging a replayed transcript into a file that may already hold part of it.
   * The watcher does not call it.
   */
  it("returns the key of every row the file holds", async () => {
    const path = await tempCsv();
    await openCsv(path);
    const first = turn({ turnNumber: 1, turnId: "turn-a" });
    const second = turn({ turnNumber: 2, turnId: "turn-b", at: "2026-07-22T02:40:00.000Z" });
    await appendTurn(path, first);
    await appendTurn(path, second);

    const keys = await readRecordedKeys(path);

    expect(keys.size).toBe(2);
    expect(keys.has(turnRowKey(first))).toBe(true);
    expect(keys.has(turnRowKey(second))).toBe(true);
  });

  it("recovers a key from a row whose turn id contains a comma", async () => {
    const path = await tempCsv();
    await openCsv(path);
    const recorded = turn({ turnId: "weird,id" });
    await appendTurn(path, recorded);

    expect((await readRecordedKeys(path)).has(turnRowKey(recorded))).toBe(true);
  });

  it("holds nothing for a file that is only a header", async () => {
    const path = await tempCsv();
    await openCsv(path);

    expect((await readRecordedKeys(path)).size).toBe(0);
  });

  /** A watch that has not written yet asks about a file that does not exist. */
  it("holds nothing for a file that does not exist", async () => {
    const path = await tempCsv();

    expect((await readRecordedKeys(path)).size).toBe(0);
  });
});
