import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatUpdateNotice } from "../src/ui/update-notice.js";
import { checkForUpdate } from "../src/update/check.js";
import { readUpdateState, writeUpdateState } from "../src/update/state.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "turnlens-check-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Everything set so a check would run, unless a test changes one thing. */
function ready(overrides: Partial<Parameters<typeof checkForUpdate>[0]> = {}) {
  return {
    currentVersion: "0.1.1",
    offline: false,
    env: { TURNLENS_HOME: home } as NodeJS.ProcessEnv,
    isTty: true,
    now: new Date("2026-08-05T12:00:00.000Z"),
    fetchLatest: vi.fn(async () => "0.2.0" as string | undefined),
    ...overrides,
  };
}

describe("checkForUpdate", () => {
  it("reports a newer version and records the check", async () => {
    const options = ready();
    expect(await checkForUpdate(options)).toBe("0.2.0");
    expect(options.fetchLatest).toHaveBeenCalledOnce();

    const state = await readUpdateState(join(home, "update-check.json"));
    expect(state).toEqual({ checkedAt: "2026-08-05T12:00:00.000Z", latest: "0.2.0" });
  });

  it("says nothing when the running version is current or ahead", async () => {
    expect(await checkForUpdate(ready({ currentVersion: "0.2.0" }))).toBeUndefined();
    expect(await checkForUpdate(ready({ currentVersion: "0.3.0" }))).toBeUndefined();
  });

  describe("stays quiet without asking the network", () => {
    it("under --offline, decided before the state file is read", async () => {
      const options = ready({ offline: true });
      expect(await checkForUpdate(options)).toBeUndefined();
      expect(options.fetchLatest).not.toHaveBeenCalled();
    });

    it("when NO_UPDATE_NOTIFIER is set to anything, the empty string included", async () => {
      for (const value of ["1", "true", ""]) {
        const options = ready({ env: { TURNLENS_HOME: home, NO_UPDATE_NOTIFIER: value } });
        expect(await checkForUpdate(options)).toBeUndefined();
        expect(options.fetchLatest).not.toHaveBeenCalled();
      }
    });

    it("under CI, where nobody can act on it", async () => {
      const options = ready({ env: { TURNLENS_HOME: home, CI: "true" } });
      expect(await checkForUpdate(options)).toBeUndefined();
      expect(options.fetchLatest).not.toHaveBeenCalled();
    });

    it("when output is not a terminal, so a pipe carries only what was asked for", async () => {
      const options = ready({ isTty: false });
      expect(await checkForUpdate(options)).toBeUndefined();
      expect(options.fetchLatest).not.toHaveBeenCalled();
    });
  });

  it("uses the recorded answer inside the day rather than asking again", async () => {
    await writeUpdateState(join(home, "update-check.json"), {
      checkedAt: "2026-08-05T11:00:00.000Z",
      latest: "0.2.0",
    });

    const options = ready();
    expect(await checkForUpdate(options)).toBe("0.2.0");
    expect(options.fetchLatest).not.toHaveBeenCalled();
  });

  it("asks again once the day has passed", async () => {
    await writeUpdateState(join(home, "update-check.json"), {
      checkedAt: "2026-08-04T11:00:00.000Z",
      latest: "0.1.1",
    });

    const options = ready();
    expect(await checkForUpdate(options)).toBe("0.2.0");
    expect(options.fetchLatest).toHaveBeenCalledOnce();
  });

  it("says nothing and records nothing when the registry cannot be reached", async () => {
    const options = ready({ fetchLatest: vi.fn(async () => undefined) });
    expect(await checkForUpdate(options)).toBeUndefined();
    // Not recorded, so the next run tries again rather than waiting a day.
    expect(await readUpdateState(join(home, "update-check.json"))).toBeUndefined();
  });

  it("never throws, whatever the fetch does", async () => {
    const options = ready({
      fetchLatest: vi.fn(async () => {
        throw new Error("unreachable");
      }),
    });
    await expect(checkForUpdate(options)).resolves.toBeUndefined();
  });
});

describe("formatUpdateNotice", () => {
  it("names both versions and how to move between them", () => {
    const lines = formatUpdateNotice("0.2.0", "0.1.1");
    expect(lines.join("\n")).toContain("0.2.0");
    expect(lines.join("\n")).toContain("0.1.1");
    expect(lines.join("\n")).toContain("npm install -g turnlens@latest");
  });

  it("carries no colour of its own, leaving that to the caller", () => {
    // Same rule as every renderer: a Paint is passed in, never assumed.
    for (const line of formatUpdateNotice("0.2.0", "0.1.1")) {
      expect(line).not.toContain("[");
    }
  });
});
