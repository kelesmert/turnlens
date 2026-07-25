import { describe, expect, it } from "vitest";
import { parseCodexRecord } from "../src/providers/codex/parser.js";

describe("parseCodexRecord rejects what it does not understand", () => {
  it("returns no events for values that are not records", () => {
    expect(parseCodexRecord(null)).toEqual([]);
    expect(parseCodexRecord(undefined)).toEqual([]);
    expect(parseCodexRecord("a string")).toEqual([]);
    expect(parseCodexRecord(42)).toEqual([]);
    expect(parseCodexRecord([])).toEqual([]);
  });

  it("returns no events for records with no usable payload", () => {
    expect(parseCodexRecord({})).toEqual([]);
    expect(parseCodexRecord({ type: "event_msg" })).toEqual([]);
    expect(parseCodexRecord({ type: "event_msg", payload: "not an object" })).toEqual([]);
  });

  it("ignores record types that carry no usage or turn information", () => {
    expect(parseCodexRecord({ type: "world_state", payload: {} })).toEqual([]);
    expect(parseCodexRecord({ type: "event_msg", payload: { type: "agent_message" } })).toEqual([]);
    expect(parseCodexRecord({ type: "event_msg", payload: { type: "task_started" } })).toEqual([]);
    expect(parseCodexRecord({ type: "response_item", payload: { type: "reasoning" } })).toEqual([]);
  });

  it("ignores event shapes that never occur in real sessions", () => {
    expect(parseCodexRecord({ type: "event_msg", payload: { type: "patch_apply_begin" } })).toEqual([]);
    expect(parseCodexRecord({ type: "event_msg", payload: { type: "web_search_begin" } })).toEqual([]);
    expect(parseCodexRecord({ type: "turn.completed", payload: {} })).toEqual([]);
  });

  it("takes no model from session_meta, which does not carry one", () => {
    expect(
      parseCodexRecord({
        type: "session_meta",
        timestamp: "t",
        payload: { session_id: "019f87a7", cli_version: "0.145.0-alpha.27" },
      }),
    ).toEqual([]);
  });
});

describe("parseCodexRecord reads cumulative usage", () => {
  it("subtracts cached input and carries rate limits", () => {
    const events = parseCodexRecord({
      type: "event_msg",
      timestamp: "2026-07-22T02:31:05.000Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 128_491,
            cached_input_tokens: 11_008,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            total_tokens: 128_496,
          },
        },
        rate_limits: {
          primary: { used_percent: 73, window_minutes: 10_080 },
          secondary: {},
        },
      },
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    if (event?.kind !== "usage") throw new Error("expected a usage event");

    expect(event.usage).toEqual({
      inputUncached: 117_483,
      cacheRead: 11_008,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
      output: 5,
      reasoning: 0,
      total: 128_496,
    });
    expect(event.rateLimits).toEqual({ primaryUsedPercent: 73, primaryWindowMinutes: 10_080 });
    expect(event.at).toBe("2026-07-22T02:31:05.000Z");
  });

  it("derives total from input plus output when total_tokens is absent", () => {
    const events = parseCodexRecord({
      type: "event_msg",
      timestamp: "t",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } },
      },
    });

    if (events[0]?.kind !== "usage") throw new Error("expected a usage event");
    expect(events[0].usage.total).toBe(120);
  });

  it("omits rate limits entirely when none were reported", () => {
    const events = parseCodexRecord({
      type: "event_msg",
      timestamp: "t",
      payload: { type: "token_count", info: { total_token_usage: { total_tokens: 10 } } },
    });

    if (events[0]?.kind !== "usage") throw new Error("expected a usage event");
    expect(events[0].rateLimits).toBeUndefined();
  });

  it("ignores a token_count whose usage fields are all missing", () => {
    expect(
      parseCodexRecord({
        type: "event_msg",
        timestamp: "t",
        payload: { type: "token_count", info: { total_token_usage: { service_tier: "standard" } } },
      }),
    ).toEqual([]);
  });

  it("clamps a cached count larger than the input count to zero uncached", () => {
    const events = parseCodexRecord({
      type: "event_msg",
      timestamp: "t",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 99, total_tokens: 10 } },
      },
    });

    if (events[0]?.kind !== "usage") throw new Error("expected a usage event");
    expect(events[0].usage.inputUncached).toBe(0);
  });
});

describe("parseCodexRecord reads turn boundaries", () => {
  it("emits turnStart and meta from turn_context, taking effort from collaboration_mode", () => {
    expect(
      parseCodexRecord({
        type: "turn_context",
        timestamp: "t",
        payload: {
          turn_id: "019f87a7-cca9-77c3-a2a2-789b424952b9",
          model: "gpt-5.6-sol",
          effort: null,
          collaboration_mode: { mode: "default", settings: { reasoning_effort: "medium" } },
        },
      }),
    ).toEqual([
      { kind: "turnStart", at: "t", turnId: "019f87a7-cca9-77c3-a2a2-789b424952b9" },
      { kind: "meta", at: "t", model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ]);
  });

  it("prefers a top-level reasoning_effort when present", () => {
    expect(
      parseCodexRecord({
        type: "turn_context",
        timestamp: "t",
        payload: { model: "gpt-5.6-terra", reasoning_effort: "low" },
      }),
    ).toEqual([{ kind: "meta", at: "t", model: "gpt-5.6-terra", reasoningEffort: "low" }]);
  });

  it("emits turnEnd with the duration from task_complete", () => {
    expect(
      parseCodexRecord({
        type: "event_msg",
        timestamp: "t",
        payload: { type: "task_complete", turn_id: "019f87b1", duration_ms: 17_691 },
      }),
    ).toEqual([{ kind: "turnEnd", at: "t", turnId: "019f87b1", durationMs: 17_691 }]);
  });

  it("emits turnEnd without a duration when none was reported", () => {
    expect(
      parseCodexRecord({
        type: "event_msg",
        timestamp: "t",
        payload: { type: "task_complete", turn_id: "019f87b1" },
      }),
    ).toEqual([{ kind: "turnEnd", at: "t", turnId: "019f87b1" }]);
  });

  it("emits turnAbort for turn_aborted so its tokens are not billed to the next turn", () => {
    expect(
      parseCodexRecord({
        type: "event_msg",
        timestamp: "t",
        payload: { type: "turn_aborted", reason: "interrupted" },
      }),
    ).toEqual([{ kind: "turnAbort", at: "t", reason: "interrupted" }]);
  });

  it("keeps the duration Codex reports for an interrupted turn", () => {
    expect(
      parseCodexRecord({
        type: "event_msg",
        timestamp: "t",
        payload: {
          type: "turn_aborted",
          turn_id: "019f9a00",
          reason: "interrupted",
          duration_ms: 11_452,
        },
      }),
    ).toEqual([
      { kind: "turnAbort", at: "t", turnId: "019f9a00", reason: "interrupted", durationMs: 11_452 },
    ]);
  });

  it("emits a compaction boundary for context_compacted", () => {
    expect(
      parseCodexRecord({ type: "event_msg", timestamp: "t", payload: { type: "context_compacted" } }),
    ).toEqual([{ kind: "boundary", at: "t", reason: "compacted" }]);
  });
});

describe("parseCodexRecord reads tool calls", () => {
  it("names a custom_tool_call from its name field", () => {
    expect(
      parseCodexRecord({
        type: "response_item",
        timestamp: "t",
        payload: { type: "custom_tool_call", name: "exec", call_id: "call_1" },
      }),
    ).toEqual([{ kind: "toolCall", at: "t", name: "exec", callId: "call_1" }]);
  });

  it("falls back to a normalised type name when a tool call has no name", () => {
    expect(
      parseCodexRecord({
        type: "response_item",
        timestamp: "t",
        payload: { type: "web_search_call", call_id: "call_2" },
      }),
    ).toEqual([{ kind: "toolCall", at: "t", name: "web_search", callId: "call_2" }]);
  });

  it("prefixes an mcp tool name with its namespace exactly once", () => {
    expect(
      parseCodexRecord({
        type: "response_item",
        timestamp: "t",
        payload: { type: "mcp_call", name: "search", namespace: "github", call_id: "call_3" },
      }),
    ).toEqual([{ kind: "toolCall", at: "t", name: "github.search", callId: "call_3" }]);

    expect(
      parseCodexRecord({
        type: "response_item",
        timestamp: "t",
        payload: { type: "mcp_call", name: "github.search", namespace: "github", call_id: "call_4" },
      }),
    ).toEqual([{ kind: "toolCall", at: "t", name: "github.search", callId: "call_4" }]);
  });

  it("falls back to the id field when call_id is absent", () => {
    expect(
      parseCodexRecord({
        type: "response_item",
        timestamp: "t",
        payload: { type: "function_call", name: "wait", id: "fc_0867" },
      }),
    ).toEqual([{ kind: "toolCall", at: "t", name: "wait", callId: "fc_0867" }]);
  });

  it("omits callId when the record carries no identifier", () => {
    expect(
      parseCodexRecord({
        type: "response_item",
        timestamp: "t",
        payload: { type: "shell_call" },
      }),
    ).toEqual([{ kind: "toolCall", at: "t", name: "shell" }]);
  });
});

describe("parseCodexRecord reads prompts", () => {
  it("emits prompt text from a user_message", () => {
    expect(
      parseCodexRecord({
        type: "event_msg",
        timestamp: "t",
        payload: { type: "user_message", message: "sadece a yaz" },
      }),
    ).toEqual([{ kind: "meta", at: "t", promptText: "sadece a yaz" }]);
  });

  it("ignores a user_message with no readable text", () => {
    expect(
      parseCodexRecord({
        type: "event_msg",
        timestamp: "t",
        payload: { type: "user_message", images: [] },
      }),
    ).toEqual([]);
  });

  /**
   * Codex mirrors every real prompt into a `response_item` message and also
   * writes its own notices there under the same `role: "user"`. The two shapes
   * are identical -- same payload keys, same `input_text` content item -- so a
   * reader cannot tell a prompt from a notice, and the notice arrives last.
   *
   * Reading prompts only from `event_msg` / `user_message` is what keeps them
   * apart: in the session this shape was transcribed from, that event occurred
   * exactly as often as the user actually typed something, while the two
   * notices had no counterpart.
   *
   * The Python implementation read both sources and let the later one win, so an
   * interrupted turn's preview became the interruption notice instead of the
   * prompt. This test exists to make reintroducing that a failing test rather
   * than a silent change to a column nobody watches.
   */
  it("ignores an injected user-role response item so it cannot overwrite a prompt", () => {
    expect(
      parseCodexRecord({
        type: "response_item",
        timestamp: "t",
        payload: {
          type: "message",
          role: "user",
          id: "msg_1",
          content: [
            { type: "input_text", text: "<turn_aborted>\nThe user interrupted the previous turn." },
          ],
        },
      }),
    ).toEqual([]);
  });
});
