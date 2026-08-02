import { describe, expect, it } from "vitest";
import { bucketLabel, localDate, resolveTimeZone } from "../src/report/buckets.js";

/**
 * The weekday claims below were checked rather than assumed:
 *
 *   node -e 'for (const d of ["2026-08-02","2026-07-27","2026-08-03"]) \
 *     console.log(d, new Date(d+"T12:00:00Z").toUTCString().slice(0,3))'
 *
 * 2026-08-02 is a Sunday, 2026-07-27 and 2026-08-03 are Mondays.
 */
describe("localDate", () => {
  it("uses the given timezone, not UTC", () => {
    // 22:30 UTC on 1 August is 01:30 on 2 August in Istanbul.
    expect(localDate("2026-08-01T22:30:00.000Z", "Europe/Istanbul")).toBe("2026-08-02");
    expect(localDate("2026-08-01T22:30:00.000Z", "UTC")).toBe("2026-08-01");
  });

  it("goes backwards for a timezone behind UTC", () => {
    expect(localDate("2026-08-02T02:00:00.000Z", "America/New_York")).toBe("2026-08-01");
  });

  it("pads a single-digit month and day, so labels sort as text", () => {
    expect(localDate("2026-01-05T12:00:00.000Z", "UTC")).toBe("2026-01-05");
  });
});

describe("bucketLabel", () => {
  it("buckets a day by its local date", () => {
    expect(bucketLabel("2026-08-02T09:00:00.000Z", "daily", "UTC")).toBe("2026-08-02");
  });

  /**
   * Monday, and the label is the Monday's own date rather than an ISO week
   * number. A week number disagrees with the calendar year at both ends of it,
   * so 2027-W01 can hold days in 2026 and cannot be sorted against 2026-12.
   */
  it("buckets a week by the date of its Monday", () => {
    expect(bucketLabel("2026-08-02T09:00:00.000Z", "weekly", "UTC")).toBe("2026-07-27");
    expect(bucketLabel("2026-07-29T09:00:00.000Z", "weekly", "UTC")).toBe("2026-07-27");
  });

  it("keeps a Monday in its own week", () => {
    expect(bucketLabel("2026-08-03T00:00:00.000Z", "weekly", "UTC")).toBe("2026-08-03");
  });

  it("crosses a month boundary within a week without losing the day", () => {
    // Friday 31 July 2026 belongs to the week beginning Monday 27 July.
    expect(bucketLabel("2026-07-31T09:00:00.000Z", "weekly", "UTC")).toBe("2026-07-27");
  });

  it("buckets a month by year and month", () => {
    expect(bucketLabel("2026-08-02T09:00:00.000Z", "monthly", "UTC")).toBe("2026-08");
  });

  it("crosses a month boundary with the timezone, not against it", () => {
    expect(bucketLabel("2026-07-31T23:00:00.000Z", "monthly", "Europe/Istanbul")).toBe("2026-08");
  });

  it("takes the week from the local day, not the UTC one", () => {
    // 23:30 UTC on Sunday 2 August is Monday 3 August in Istanbul, which starts
    // a different week.
    expect(bucketLabel("2026-08-02T23:30:00.000Z", "weekly", "UTC")).toBe("2026-07-27");
    expect(bucketLabel("2026-08-02T23:30:00.000Z", "weekly", "Europe/Istanbul")).toBe("2026-08-03");
  });

  it("produces labels that sort chronologically as plain strings", () => {
    const labels = ["2026-08-02", "2026-07-27", "2026-08-10", "2026-12-28"].sort();

    expect(labels).toEqual(["2026-07-27", "2026-08-02", "2026-08-10", "2026-12-28"]);
  });
});

describe("resolveTimeZone", () => {
  it("honours TZ, which is what a user sets to ask for a different day", () => {
    expect(resolveTimeZone({ TZ: "Asia/Tokyo" })).toBe("Asia/Tokyo");
  });

  it("falls back to the system zone when TZ is unset or empty", () => {
    expect(resolveTimeZone({}).length).toBeGreaterThan(0);
    expect(resolveTimeZone({ TZ: "  " }).length).toBeGreaterThan(0);
  });

  it("names a zone the formatter accepts, so a report can print it", () => {
    const zone = resolveTimeZone({});

    expect(() => localDate("2026-08-02T09:00:00.000Z", zone)).not.toThrow();
  });
});
