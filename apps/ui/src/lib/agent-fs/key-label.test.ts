import { describe, expect, test } from "bun:test";
import { browserKeyLabel } from "./key-label";

const DAY = new Date(2026, 10, 4, 9, 30);
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("browserKeyLabel", () => {
  test("names the browser, the platform and the local date", () => {
    expect(browserKeyLabel({ userAgent: MAC_CHROME }, DAY)).toBe(
      "Swarm dashboard · Chrome on macOS · 2026-11-04",
    );
  });

  test("prefers client hints when the browser has them", () => {
    const hint = {
      userAgent: MAC_CHROME,
      userAgentData: {
        brands: [{ brand: "Not=A?Brand" }, { brand: "Chromium" }, { brand: "Microsoft Edge" }],
        platform: "Windows",
      },
    };
    expect(browserKeyLabel(hint, DAY)).toBe("Swarm dashboard · Edge on Windows · 2026-11-04");
  });

  test("reads Firefox, Safari and phones from the user agent", () => {
    expect(
      browserKeyLabel(
        { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" },
        DAY,
      ),
    ).toBe("Swarm dashboard · Firefox on Linux · 2026-11-04");
    expect(
      browserKeyLabel(
        {
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        },
        DAY,
      ),
    ).toBe("Swarm dashboard · Safari on iOS · 2026-11-04");
  });

  test("an unknown client still gets a label", () => {
    expect(browserKeyLabel({}, DAY)).toBe("Swarm dashboard · Browser · 2026-11-04");
  });
});
