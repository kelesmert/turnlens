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

function userRecord(uuid: string, promptId: string, content: unknown): unknown {
  return {
    uuid,
    type: "user",
    timestamp: "2026-07-25T11:04:05.147Z",
    isSidechain: false,
    promptId,
    sessionId: "79c14101-4f5d-4793-ab69-8649e76d2062",
    message: { role: "user", content },
  };
}

describe("createClaudeCodeParser opens turns on new prompts", () => {
  it("opens a turn and carries the prompt text when content is a plain string", () => {
    const parse = createClaudeCodeParser();
    expect(parse(userRecord("u1", "p1", "do we have claude code terminal?"))).toEqual([
      { kind: "turnStart", at: "2026-07-25T11:04:05.147Z", turnId: "p1" },
      {
        kind: "meta",
        at: "2026-07-25T11:04:05.147Z",
        promptText: "do we have claude code terminal?",
      },
    ]);
  });

  it("reads prompt text out of an array of content blocks", () => {
    const parse = createClaudeCodeParser();
    const events = parse(
      userRecord("u1", "p1", [
        { type: "image", source: {} },
        { type: "text", text: "look at this" },
      ]),
    ) as readonly { kind: string; promptText?: string }[];
    expect(events[1]).toEqual({
      kind: "meta",
      at: "2026-07-25T11:04:05.147Z",
      promptText: "look at this",
    });
  });

  it("opens no second turn while the prompt id is unchanged", () => {
    const parse = createClaudeCodeParser();
    expect(parse(userRecord("u1", "p1", "first"))).toHaveLength(2);
    expect(parse(userRecord("u2", "p1", "still the same prompt"))).toEqual([]);
  });

  it("opens a new turn when the prompt id changes", () => {
    const parse = createClaudeCodeParser();
    parse(userRecord("u1", "p1", "first"));
    const events = parse(userRecord("u2", "p2", "second")) as readonly { kind: string }[];
    expect(events[0]).toEqual({ kind: "turnStart", at: "2026-07-25T11:04:05.147Z", turnId: "p2" });
  });

  it("ignores tool results, which share the prompt id but are not prompts", () => {
    const parse = createClaudeCodeParser();
    expect(
      parse(userRecord("u1", "p1", [{ type: "tool_result", tool_use_id: "toolu_01Jc7Dpcksn" }])),
    ).toEqual([]);
  });

  it("ignores the summary record a compaction writes", () => {
    const parse = createClaudeCodeParser();
    const record = userRecord("u1", "p1", "summary text");
    (record as { isCompactSummary: boolean }).isCompactSummary = true;
    expect(parse(record)).toEqual([]);
  });

  it("emits no prompt text when the prompt is empty", () => {
    const parse = createClaudeCodeParser();
    expect(parse(userRecord("u1", "p1", "   "))).toEqual([
      { kind: "turnStart", at: "2026-07-25T11:04:05.147Z", turnId: "p1" },
    ]);
  });
});

describe("createClaudeCodeParser closes turns", () => {
  it("closes a turn on end_turn, after the usage of that same response", () => {
    const parse = createClaudeCodeParser();
    const events = parse(assistantRecord("a1", { stop_reason: "end_turn" })) as readonly {
      kind: string;
    }[];
    expect(events.map((event) => event.kind)).toEqual(["meta", "usage", "turnEnd"]);
  });

  it("does not close a turn on any other stop reason", () => {
    const parse = createClaudeCodeParser();
    const kinds = (parse(assistantRecord("a1")) as readonly { kind: string }[]).map((e) => e.kind);
    expect(kinds).not.toContain("turnEnd");

    const streaming = parse(assistantRecord("a2", { stop_reason: null })) as readonly {
      kind: string;
    }[];
    expect(streaming.map((event) => event.kind)).not.toContain("turnEnd");
  });

  it("aborts a turn on the interruption marker", () => {
    const parse = createClaudeCodeParser();
    expect(
      parse(userRecord("u1", "p1", [{ type: "text", text: "[Request interrupted by user]" }])),
    ).toEqual([{ kind: "turnAbort", at: "2026-07-25T11:04:05.147Z", reason: "interrupted" }]);
  });

  it("closes a turn on a compaction boundary", () => {
    const parse = createClaudeCodeParser();
    expect(
      parse({
        uuid: "s1",
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-07-25T15:28:32.579Z",
        isSidechain: false,
        content: "Conversation compact",
        compactMetadata: { trigger: "manual", preTokens: 415115 },
      }),
    ).toEqual([{ kind: "boundary", at: "2026-07-25T15:28:32.579Z", reason: "compacted" }]);
  });

  it("ignores system records that are not compaction boundaries", () => {
    const parse = createClaudeCodeParser();
    expect(
      parse({
        uuid: "s1",
        type: "system",
        subtype: "hook_result",
        timestamp: "2026-07-25T15:28:32.579Z",
        isSidechain: false,
      }),
    ).toEqual([]);
  });
});

describe("createClaudeCodeParser reads model, effort and tool calls", () => {
  it("reports the model and the reasoning effort", () => {
    const parse = createClaudeCodeParser();
    const record = assistantRecord("a1");
    (record as { effort: string }).effort = "medium";
    const events = parse(record) as readonly { kind: string }[];
    expect(events[0]).toEqual({
      kind: "meta",
      at: "2026-07-25T11:04:09.039Z",
      model: "claude-opus-5",
      reasoningEffort: "medium",
    });
  });

  it("omits the effort when the record carries none", () => {
    const parse = createClaudeCodeParser();
    const events = parse(assistantRecord("a1")) as readonly { kind: string }[];
    expect(events[0]).toEqual({
      kind: "meta",
      at: "2026-07-25T11:04:09.039Z",
      model: "claude-opus-5",
    });
  });

  it("counts one tool call per tool_use block, keyed by the block id", () => {
    const parse = createClaudeCodeParser();
    const events = parse(
      assistantRecord("a1", {
        content: [
          { type: "text", text: "running two things" },
          { type: "tool_use", name: "Bash", id: "toolu_01W6cfcRebxynhV2jDFy4ucU" },
          { type: "tool_use", name: "Read", id: "toolu_014iFtndbnh25Srs17tQ27b5" },
        ],
      }),
    ) as readonly { kind: string; name?: string; callId?: string }[];

    expect(events.filter((event) => event.kind === "toolCall")).toEqual([
      {
        kind: "toolCall",
        at: "2026-07-25T11:04:09.039Z",
        name: "Bash",
        callId: "toolu_01W6cfcRebxynhV2jDFy4ucU",
      },
      {
        kind: "toolCall",
        at: "2026-07-25T11:04:09.039Z",
        name: "Read",
        callId: "toolu_014iFtndbnh25Srs17tQ27b5",
      },
    ]);
  });

  it("ignores content blocks that are not tool calls", () => {
    const parse = createClaudeCodeParser();
    const events = parse(
      assistantRecord("a1", { content: [{ type: "thinking" }, { type: "text", text: "hello" }] }),
    ) as readonly { kind: string }[];
    expect(events.map((event) => event.kind)).not.toContain("toolCall");
  });

  it("ignores a tool_use block with no name rather than inventing one", () => {
    const parse = createClaudeCodeParser();
    const events = parse(
      assistantRecord("a1", { content: [{ type: "tool_use", id: "toolu_01" }] }),
    ) as readonly { kind: string }[];
    expect(events.map((event) => event.kind)).not.toContain("toolCall");
  });

  it("emits events in the order the assembler needs: meta, tools, usage, close", () => {
    const parse = createClaudeCodeParser();
    const record = assistantRecord("a1", {
      stop_reason: "end_turn",
      content: [{ type: "tool_use", name: "Bash", id: "toolu_01" }],
    });
    (record as { effort: string }).effort = "high";
    const kinds = (parse(record) as readonly { kind: string }[]).map((event) => event.kind);
    expect(kinds).toEqual(["meta", "toolCall", "usage", "turnEnd"]);
  });
});
