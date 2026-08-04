import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDue,
  readUpdateState,
  resolveUpdateStatePath,
  writeUpdateState,
} from "../src/update/state.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "turnlens-update-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("resolveUpdateStatePath", () => {
  it("sits inside TURNLENS_HOME, beside the pricing cache", () => {
    expect(resolveUpdateStatePath({ TURNLENS_HOME: "/somewhere" })).toBe(
      join("/somewhere", "update-check.json"),
    );
  });

  it("falls back to .turnlens under the home directory", () => {
    expect(resolveUpdateStatePath({ HOME: "/home/someone" })).toBe(
      join("/home/someone", ".turnlens", "update-check.json"),
    );
  });
});

describe("readUpdateState", () => {
  it("round-trips what was written", async () => {
    const path = join(directory, "update-check.json");
    await writeUpdateState(path, { checkedAt: "2026-08-05T10:00:00.000Z", latest: "0.2.0" });
    expect(await readUpdateState(path)).toEqual({
      checkedAt: "2026-08-05T10:00:00.000Z",
      latest: "0.2.0",
    });
  });

  it("creates the directory it needs", async () => {
    const path = join(directory, "nested", "deeper", "update-check.json");
    await writeUpdateState(path, { checkedAt: "2026-08-05T10:00:00.000Z", latest: "0.2.0" });
    expect(await readUpdateState(path)).not.toBeUndefined();
  });

  it("treats every unreadable form as no state", async () => {
    // A notice is a convenience. Nothing here may stop a run from starting.
    const missing = join(directory, "absent.json");
    expect(await readUpdateState(missing)).toBeUndefined();

    const notJson = join(directory, "broken.json");
    await writeFile(notJson, "{ not json", "utf8");
    expect(await readUpdateState(notJson)).toBeUndefined();

    const notObject = join(directory, "array.json");
    await writeFile(notObject, "[1, 2, 3]", "utf8");
    expect(await readUpdateState(notObject)).toBeUndefined();

    const missingField = join(directory, "partial.json");
    await writeFile(missingField, JSON.stringify({ checkedAt: "2026-08-05T10:00:00.000Z" }), "utf8");
    expect(await readUpdateState(missingField)).toBeUndefined();

    const blankField = join(directory, "blank.json");
    await writeFile(blankField, JSON.stringify({ checkedAt: "   ", latest: "0.2.0" }), "utf8");
    expect(await readUpdateState(blankField)).toBeUndefined();
  });
});

describe("isDue", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");

  it("is due when nothing has been recorded", () => {
    expect(isDue(undefined, now)).toBe(true);
  });

  it("is not due within the day", () => {
    expect(isDue({ checkedAt: "2026-08-05T11:00:00.000Z", latest: "0.2.0" }, now)).toBe(false);
    expect(isDue({ checkedAt: "2026-08-04T12:30:00.000Z", latest: "0.2.0" }, now)).toBe(false);
  });

  it("is due once a day has passed", () => {
    expect(isDue({ checkedAt: "2026-08-04T11:59:00.000Z", latest: "0.2.0" }, now)).toBe(true);
  });

  it("is due when the timestamp cannot be read, rather than never checking again", () => {
    expect(isDue({ checkedAt: "not a date", latest: "0.2.0" }, now)).toBe(true);
  });

  it("is due when the timestamp is in the future, which a clock change can cause", () => {
    expect(isDue({ checkedAt: "2027-01-01T00:00:00.000Z", latest: "0.2.0" }, now)).toBe(true);
  });
});
