import { describe, expect, test } from "bun:test";
import { checkUserAccess, type UserFilterConfig } from "./handlers";

describe("checkUserAccess", () => {
  describe("when filtering is disabled (empty config)", () => {
    const config: UserFilterConfig = {
      allowedEmailDomains: [],
      allowedUserIds: [],
    };

    test("allows any user regardless of email", () => {
      expect(checkUserAccess("U123", "user@example.com", config)).toBe(true);
    });

    test("allows user with null email", () => {
      expect(checkUserAccess("U123", null, config)).toBe(true);
    });
  });

  describe("when only user IDs are configured", () => {
    const config: UserFilterConfig = {
      allowedEmailDomains: [],
      allowedUserIds: ["U123", "U456"],
    };

    test("allows whitelisted user ID", () => {
      expect(checkUserAccess("U123", null, config)).toBe(true);
      expect(checkUserAccess("U456", "any@example.com", config)).toBe(true);
    });

    test("denies non-whitelisted user ID", () => {
      expect(checkUserAccess("U789", null, config)).toBe(false);
      expect(checkUserAccess("U999", "user@company.com", config)).toBe(false);
    });

    test("ignores email when user ID matches", () => {
      expect(checkUserAccess("U123", null, config)).toBe(true);
      expect(checkUserAccess("U123", "invalid-email", config)).toBe(true);
    });
  });

  describe("when only email domains are configured", () => {
    const config: UserFilterConfig = {
      allowedEmailDomains: ["company.com", "partner.org"],
      allowedUserIds: [],
    };

    test("allows user with allowed email domain", () => {
      expect(checkUserAccess("U123", "user@company.com", config)).toBe(true);
      expect(checkUserAccess("U456", "admin@partner.org", config)).toBe(true);
    });

    test("denies user with non-allowed email domain", () => {
      expect(checkUserAccess("U123", "user@other.com", config)).toBe(false);
      expect(checkUserAccess("U456", "user@competitor.org", config)).toBe(false);
    });

    test("denies user with null email", () => {
      expect(checkUserAccess("U123", null, config)).toBe(false);
    });

    test("denies user with invalid email format", () => {
      expect(checkUserAccess("U123", "invalid-email", config)).toBe(false);
      expect(checkUserAccess("U123", "no-at-sign", config)).toBe(false);
      expect(checkUserAccess("U123", "@no-local-part.com", config)).toBe(false);
    });

    test("handles email domain case-insensitively", () => {
      expect(checkUserAccess("U123", "user@COMPANY.COM", config)).toBe(true);
      expect(checkUserAccess("U123", "user@Company.Com", config)).toBe(true);
    });
  });

  describe("when both user IDs and email domains are configured", () => {
    const config: UserFilterConfig = {
      allowedEmailDomains: ["company.com"],
      allowedUserIds: ["U123"],
    };

    test("allows whitelisted user ID (fast path)", () => {
      expect(checkUserAccess("U123", null, config)).toBe(true);
      expect(checkUserAccess("U123", "wrong@other.com", config)).toBe(true);
    });

    test("allows non-whitelisted user with allowed email domain", () => {
      expect(checkUserAccess("U456", "user@company.com", config)).toBe(true);
    });

    test("denies non-whitelisted user with non-allowed email domain", () => {
      expect(checkUserAccess("U456", "user@other.com", config)).toBe(false);
    });

    test("denies non-whitelisted user with null email", () => {
      expect(checkUserAccess("U456", null, config)).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("handles empty string user ID", () => {
      const config: UserFilterConfig = {
        allowedEmailDomains: ["company.com"],
        allowedUserIds: [],
      };
      expect(checkUserAccess("", "user@company.com", config)).toBe(true);
      expect(checkUserAccess("", "user@other.com", config)).toBe(false);
    });

    test("handles empty string email", () => {
      const config: UserFilterConfig = {
        allowedEmailDomains: ["company.com"],
        allowedUserIds: [],
      };
      expect(checkUserAccess("U123", "", config)).toBe(false);
    });

    test("handles email with multiple @ symbols", () => {
      const config: UserFilterConfig = {
        allowedEmailDomains: ["company.com"],
        allowedUserIds: [],
      };
      // The domain extraction takes everything after first @
      expect(checkUserAccess("U123", "user@fake@company.com", config)).toBe(false);
    });

    test("handles subdomain emails", () => {
      const config: UserFilterConfig = {
        allowedEmailDomains: ["company.com"],
        allowedUserIds: [],
      };
      // Subdomain should NOT match parent domain
      expect(checkUserAccess("U123", "user@sub.company.com", config)).toBe(false);
    });

    test("exact domain match required (not partial)", () => {
      const config: UserFilterConfig = {
        allowedEmailDomains: ["company.com"],
        allowedUserIds: [],
      };
      expect(checkUserAccess("U123", "user@mycompany.com", config)).toBe(false);
      expect(checkUserAccess("U123", "user@company.com.au", config)).toBe(false);
    });

    test("handles whitespace in user IDs config", () => {
      const config: UserFilterConfig = {
        allowedEmailDomains: [],
        allowedUserIds: ["U123", " U456 "],
      };
      // Note: In production, config is trimmed during parsing
      // This test shows the function itself doesn't trim
      expect(checkUserAccess("U123", null, config)).toBe(true);
      expect(checkUserAccess("U456", null, config)).toBe(false); // " U456 " !== "U456"
    });

    test("handles multiple allowed domains", () => {
      const config: UserFilterConfig = {
        allowedEmailDomains: ["company.com", "partner.org", "vendor.net"],
        allowedUserIds: [],
      };
      expect(checkUserAccess("U1", "a@company.com", config)).toBe(true);
      expect(checkUserAccess("U2", "b@partner.org", config)).toBe(true);
      expect(checkUserAccess("U3", "c@vendor.net", config)).toBe(true);
      expect(checkUserAccess("U4", "d@other.io", config)).toBe(false);
    });
  });
});
