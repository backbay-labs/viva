import { describe, expect, test } from "bun:test";
import { Rating } from "ts-fsrs";
import {
  conceptStatusToRating,
  dueDateForStatus,
  humanInterval,
  reviewIntervalForStatus,
} from "./scheduling";

const NOW = new Date("2026-06-17T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("conceptStatusToRating", () => {
  test("maps each concept status to an FSRS rating", () => {
    expect(conceptStatusToRating("missed")).toBe(Rating.Again);
    expect(conceptStatusToRating("shaky")).toBe(Rating.Hard);
    expect(conceptStatusToRating("review")).toBe(Rating.Good);
    expect(conceptStatusToRating("strong")).toBe(Rating.Easy);
  });
});

describe("humanInterval", () => {
  test("renders calendar distance in warm, number-free-ish language", () => {
    expect(humanInterval(NOW, NOW)).toBe("today");
    expect(humanInterval(NOW, new Date(NOW.getTime() + DAY))).toBe("tomorrow");
    expect(humanInterval(NOW, new Date(NOW.getTime() + 5 * DAY))).toBe("in 5 days");
  });
});

describe("dueDateForStatus", () => {
  test("schedules every status into the future", () => {
    for (const status of ["strong", "shaky", "missed", "review"] as const) {
      expect(dueDateForStatus(status, NOW).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  test("a strong answer earns a longer interval than a missed one", () => {
    expect(dueDateForStatus("strong", NOW).getTime()).toBeGreaterThan(
      dueDateForStatus("missed", NOW).getTime(),
    );
  });
});

describe("reviewIntervalForStatus", () => {
  test("returns a non-empty human interval string", () => {
    const phrase = reviewIntervalForStatus("shaky", NOW);
    expect(phrase.length).toBeGreaterThan(0);
    expect(/today|tomorrow|day/.test(phrase)).toBe(true);
  });
});
