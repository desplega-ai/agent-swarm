import { describe, expect, test } from "bun:test";
import {
  formatWakeShort,
  localInputValue,
  menuTime,
  snoozeOptions,
  wakePhrase,
} from "./snooze-times";

/** Local time, so the tests hold in any time zone. Wed 2026-10-21. */
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes);
const iso = (d: Date) => d.toISOString();

describe("snoozeOptions", () => {
  test("offers This evening while 18:00 is more than 30 minutes away", () => {
    const options = snoozeOptions(at(21, 15, 0));
    expect(options.map((o) => o.id)).toEqual(["hour", "evening", "tomorrow", "week"]);
    expect(options[0].at).toBe(iso(at(21, 16, 0)));
    expect(options[1].at).toBe(iso(at(21, 18, 0)));
    expect(options[2].at).toBe(iso(at(22, 9, 0)));
    expect(snoozeOptions(at(21, 17, 31)).map((o) => o.id)).toEqual(["hour", "tomorrow", "week"]);
  });

  test("Next week is the next Monday at 09:00, a full week on from a Monday", () => {
    // Wed 21 Oct 2026: the next Monday is the 26th.
    expect(snoozeOptions(at(21, 10)).at(-1)?.at).toBe(iso(at(26, 9)));
    // Mon 26 Oct: the Monday after, not today.
    expect(snoozeOptions(at(26, 8)).at(-1)?.at).toBe(iso(new Date(2026, 10, 2, 9)));
  });
});

describe("wake time text", () => {
  const now = at(21, 15, 0);
  test("formatWakeShort: minutes, then the time today, then the day, then the date", () => {
    expect(formatWakeShort(iso(at(21, 15, 0)), now)).toBe("now");
    expect(formatWakeShort(iso(at(21, 15, 40)), now)).toBe("in 40m");
    expect(formatWakeShort(iso(at(21, 16, 0)), now)).toBe("16:00");
    expect(formatWakeShort(iso(at(22, 9, 0)), now)).toBe("Thu 09:00");
    expect(formatWakeShort(iso(at(30, 9, 0)), now)).toBe("Oct 30");
  });

  test("wakePhrase fits a sentence", () => {
    expect(wakePhrase(iso(at(21, 15, 1)), now)).toBe("in a minute");
    expect(wakePhrase(iso(at(21, 18, 0)), now)).toBe("at 18:00");
    expect(wakePhrase(iso(at(23, 9, 0)), now)).toBe("on Fri at 09:00");
    expect(wakePhrase(iso(at(30, 9, 0)), now)).toBe("on Oct 30 at 09:00");
  });

  test("menuTime and the datetime-local value", () => {
    expect(menuTime(iso(at(21, 18, 0)), now)).toBe("18:00");
    expect(menuTime(iso(at(26, 9, 0)), now)).toBe("Mon 09:00");
    expect(localInputValue(at(2, 7, 5))).toBe("2026-10-02T07:05");
  });
});
