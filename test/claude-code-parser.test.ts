import { describe, expect, it } from "vitest";
import { createClaudeCodeParser } from "../src/providers/claude-code/parser.js";

/** One assistant record. `overrides` is merged over the message body. */
function assistantRecord(
  uuid: string,
  overrides: Record<string, unknown> = {},
  usage: Record<string, unknown> = {},
): unknown {
  return {
    uuid,
    type: "assistant",
    timestamp: "2026-07-25T11:04:09.039Z",
    isSidechain: false,
    requestId: "req_011CdNfX33451u3ELGx3qqJm",
    message: {
      model: "claude-opus-5",
      id: "msg_011CdNfX3xsCNRsy49nuAWoh",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "thinking" }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 7484,
        cache_read_input_tokens: 19524,
        output_tokens: 217,
        cache_creation: { ephemeral_1h_input_tokens: 7484, ephemeral_5m_input_tokens: 0 },
        ...usage,
      },
      ...overrides,
    },
  };
}

function usageEvents(events: readonly unknown[]): readonly unknown[] {
  return events.filter((event) => (event as { kind: string }).kind === "usage");
}

describe("createClaudeCodeParser rejects what it does not understand", () => {
  it("returns no events for values that are not records", () => {
    const parse = createClaudeCodeParser();
    expect(parse(null)).toEqual([]);
    expect(parse(undefined)).toEqual([]);
    expect(parse("a string")).toEqual([]);
    expect(parse(42)).toEqual([]);
    expect(parse([])).toEqual([]);
  });

  it("ignores records with no uuid, which is how metadata lines are shaped", () => {
    const parse = createClaudeCodeParser();
    expect(parse({ type: "custom-title", customTitle: "Some title", sessionId: "s" })).toEqual([]);
    expect(parse({ type: "ai-title", aiTitle: "Some title", sessionId: "s" })).toEqual([]);
    expect(parse({ type: "mode", mode: "auto", sessionId: "s" })).toEqual([]);
    expect(parse({ type: "queue-operation", operation: "enqueue", sessionId: "s" })).toEqual([]);
  });

  it("ignores record types that carry no usage or turn information", () => {
    const parse = createClaudeCodeParser();
    expect(parse({ uuid: "x1", type: "attachment", timestamp: "t" })).toEqual([]);
    expect(parse({ uuid: "x2", type: "file-history-snapshot", timestamp: "t" })).toEqual([]);
  });

  it("drops sidechain records, which belong to a subagent and are out of scope", () => {
    const parse = createClaudeCodeParser();
    const record = assistantRecord("a1");
    (record as { isSidechain: boolean }).isSidechain = true;
    expect(parse(record)).toEqual([]);
  });

  it("rejects entries whose identifying fields are present but empty", () => {
    const parse = createClaudeCodeParser();
    expect(parse(assistantRecord("a1", { id: "" }))).toEqual([]);
    expect(parse(assistantRecord("a2", { model: "" }))).toEqual([]);

    const emptyRequestId = assistantRecord("a3");
    (emptyRequestId as { requestId: string }).requestId = "";
    expect(parse(emptyRequestId)).toEqual([]);

    const emptySessionId = assistantRecord("a4");
    (emptySessionId as { sessionId: string }).sessionId = "";
    expect(parse(emptySessionId)).toEqual([]);
  });
});

describe("createClaudeCodeParser reads per-event usage", () => {
  it("keeps the two cache-creation tiers apart and reports no reasoning", () => {
    const parse = createClaudeCodeParser();
    expect(usageEvents(parse(assistantRecord("a1")))).toEqual([
      {
        kind: "usage",
        at: "2026-07-25T11:04:09.039Z",
        dedupKey: "msg_011CdNfX3xsCNRsy49nuAWoh|req_011CdNfX33451u3ELGx3qqJm",
        usage: {
          inputUncached: 2,
          cacheRead: 19524,
          cacheCreation5m: 0,
          cacheCreation1h: 7484,
          output: 217,
          reasoning: 0,
          total: 27227,
        },
      },
    ]);
  });

  it("does not subtract cached tokens from input, unlike Codex", () => {
    const parse = createClaudeCodeParser();
    const [event] = usageEvents(parse(assistantRecord("a1"))) as [
      { usage: { inputUncached: number } },
    ];
    expect(event.usage.inputUncached).toBe(2);
  });

  it("falls back to the flat cache-creation field at the cheaper 5m tier", () => {
    const parse = createClaudeCodeParser();
    const record = assistantRecord("a1");
    const usage = (record as { message: { usage: Record<string, unknown> } }).message.usage;
    delete usage["cache_creation"];
    const [event] = usageEvents(parse(record)) as [
      { usage: { cacheCreation5m: number; cacheCreation1h: number } },
    ];
    expect(event.usage.cacheCreation5m).toBe(7484);
    expect(event.usage.cacheCreation1h).toBe(0);
  });

  it("never sums usage.iterations, which mirrors the parent and would double every count", () => {
    const parse = createClaudeCodeParser();
    const [event] = usageEvents(
      parse(
        assistantRecord(
          "a1",
          {},
          {
            iterations: [
              {
                input_tokens: 2,
                output_tokens: 217,
                cache_read_input_tokens: 19524,
                cache_creation_input_tokens: 7484,
                type: "message",
              },
            ],
          },
        ),
      ),
    ) as [{ usage: { total: number } }];
    expect(event.usage.total).toBe(27227);
  });

  it("emits no usage event when the usage object carries none of its fields", () => {
    const parse = createClaudeCodeParser();
    expect(
      usageEvents(parse(assistantRecord("a1", { usage: { service_tier: "standard" } }))),
    ).toEqual([]);
  });
});

describe("createClaudeCodeParser removes both kinds of duplication", () => {
  it("drops a record whose uuid was already seen, which is replayed history", () => {
    const parse = createClaudeCodeParser();
    expect(usageEvents(parse(assistantRecord("a1")))).toHaveLength(1);
    expect(parse(assistantRecord("a1"))).toEqual([]);
  });

  it("keeps every split record but keys their usage to one API response", () => {
    const parse = createClaudeCodeParser();
    const first = usageEvents(parse(assistantRecord("a1"))) as [{ dedupKey: string }];
    const second = usageEvents(parse(assistantRecord("a2"))) as [{ dedupKey: string }];
    expect(second).toHaveLength(1);
    expect(second[0].dedupKey).toBe(first[0].dedupKey);
  });

  it("gives different API responses different dedup keys", () => {
    const parse = createClaudeCodeParser();
    const first = usageEvents(parse(assistantRecord("a1"))) as [{ dedupKey: string }];
    const second = usageEvents(
      parse(assistantRecord("a2", { id: "msg_011CdNfXahonbHuAheQPhanN" })),
    ) as [{ dedupKey: string }];
    expect(second[0].dedupKey).not.toBe(first[0].dedupKey);
  });

  it("omits the dedup key when the record cannot supply one", () => {
    const parse = createClaudeCodeParser();
    const record = assistantRecord("a1");
    delete (record as { requestId?: unknown }).requestId;
    const [event] = usageEvents(parse(record)) as [Record<string, unknown>];
    expect(event).not.toHaveProperty("dedupKey");
  });

  it("keeps deduplication state per parser instance", () => {
    const first = createClaudeCodeParser();
    const second = createClaudeCodeParser();
    expect(usageEvents(first(assistantRecord("a1")))).toHaveLength(1);
    expect(usageEvents(second(assistantRecord("a1")))).toHaveLength(1);
  });
});
