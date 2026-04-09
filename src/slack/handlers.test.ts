import { describe, expect, test } from "bun:test";
import type { SlackFile } from "./files";
import {
  buildAttachmentText,
  buildEffectiveText,
  checkUserAccess,
  formatFileSize,
  isBotMessage,
  type UserFilterConfig,
} from "./handlers";

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

// Helper to create a minimal SlackFile for testing
function makeFile(overrides: Partial<SlackFile> = {}): SlackFile {
  return {
    id: "F0TEST123",
    name: "test_file.txt",
    mimetype: "text/plain",
    filetype: "txt",
    size: 1024,
    url_private: "https://files.slack.com/private",
    url_private_download: "https://files.slack.com/download",
    ...overrides,
  };
}

describe("formatFileSize", () => {
  test("formats bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  test("formats kilobytes", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1024 * 100)).toBe("100.0 KB");
  });

  test("formats megabytes", () => {
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatFileSize(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  test("formats gigabytes", () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatFileSize(1024 * 1024 * 1024 * 1.5)).toBe("1.5 GB");
  });
});

describe("buildAttachmentText", () => {
  test("formats a single file", () => {
    const files = [
      makeFile({ id: "F001", name: "voice.m4a", mimetype: "audio/mp4", size: 156000 }),
    ];
    expect(buildAttachmentText(files)).toBe("[File: voice.m4a (audio/mp4, 152.3 KB) id=F001]");
  });

  test("formats multiple files", () => {
    const files = [
      makeFile({ id: "F001", name: "photo.png", mimetype: "image/png", size: 2048000 }),
      makeFile({ id: "F002", name: "doc.pdf", mimetype: "application/pdf", size: 512000 }),
    ];
    const result = buildAttachmentText(files);
    expect(result).toContain("[File: photo.png (image/png,");
    expect(result).toContain("[File: doc.pdf (application/pdf,");
    expect(result).toContain("id=F001");
    expect(result).toContain("id=F002");
    expect(result.split("\n")).toHaveLength(2);
  });

  test("handles empty array", () => {
    expect(buildAttachmentText([])).toBe("");
  });
});

describe("buildEffectiveText", () => {
  test("returns text as-is when no files", () => {
    expect(buildEffectiveText("hello world")).toBe("hello world");
    expect(buildEffectiveText("hello world", undefined)).toBe("hello world");
    expect(buildEffectiveText("hello world", [])).toBe("hello world");
  });

  test("returns attachment text when no text", () => {
    const files = [makeFile({ id: "F001", name: "voice.m4a", mimetype: "audio/mp4", size: 1024 })];
    const result = buildEffectiveText(undefined, files);
    expect(result).toBe("[File: voice.m4a (audio/mp4, 1.0 KB) id=F001]");
  });

  test("returns attachment text when text is empty string", () => {
    const files = [makeFile({ id: "F001", name: "voice.m4a", mimetype: "audio/mp4", size: 1024 })];
    const result = buildEffectiveText("", files);
    expect(result).toBe("[File: voice.m4a (audio/mp4, 1.0 KB) id=F001]");
  });

  test("returns attachment text when text is whitespace only", () => {
    const files = [makeFile({ id: "F001", name: "voice.m4a", mimetype: "audio/mp4", size: 1024 })];
    const result = buildEffectiveText("   ", files);
    expect(result).toBe("[File: voice.m4a (audio/mp4, 1.0 KB) id=F001]");
  });

  test("combines text and files when both present", () => {
    const files = [
      makeFile({ id: "F001", name: "screenshot.png", mimetype: "image/png", size: 2048 }),
    ];
    const result = buildEffectiveText("<@UBOT> fix this bug", files);
    expect(result).toContain("<@UBOT> fix this bug");
    expect(result).toContain("[File: screenshot.png (image/png,");
    expect(result).toContain("\n\n");
  });

  test("returns empty string when neither text nor files", () => {
    expect(buildEffectiveText(undefined)).toBe("");
    expect(buildEffectiveText(undefined, [])).toBe("");
    expect(buildEffectiveText("")).toBe("");
  });
});

describe("isBotMessage", () => {
  describe("detects bot messages", () => {
    test("returns true for subtype bot_message", () => {
      expect(isBotMessage({ subtype: "bot_message" })).toBe(true);
    });

    test("returns true when bot_id is present", () => {
      expect(isBotMessage({ bot_id: "B0123456" })).toBe(true);
    });

    test("returns true when both subtype and bot_id are present", () => {
      expect(isBotMessage({ subtype: "bot_message", bot_id: "B0123456" })).toBe(true);
    });
  });

  describe("allows human messages", () => {
    test("returns false for regular user message (no subtype, no bot_id)", () => {
      expect(isBotMessage({})).toBe(false);
    });

    test("returns false for message_changed subtype (not a bot message)", () => {
      expect(isBotMessage({ subtype: "message_changed" })).toBe(false);
    });

    test("returns false when subtype is undefined and bot_id is undefined", () => {
      expect(isBotMessage({ subtype: undefined, bot_id: undefined })).toBe(false);
    });
  });

  describe("regression: agent completion messages do not re-trigger tasks", () => {
    test("agent posting via chat.postMessage with bot_id is detected as bot", () => {
      // When agents post completion messages to Slack threads via chat.postMessage,
      // the resulting event has bot_id set. This must be filtered to prevent
      // duplicate task creation (the re-trigger bug).
      expect(isBotMessage({ bot_id: "B_SWARM_BOT" })).toBe(true);
    });

    test("agent posting with username override still detected as bot via bot_id", () => {
      // slack-reply tool posts with username override but bot_id is still present
      expect(isBotMessage({ bot_id: "B_SWARM_BOT" })).toBe(true);
    });

    test("human follow-up in same thread is NOT filtered", () => {
      // Human says "hey lead why did you process this 3 times" — no bot_id, no bot subtype
      expect(isBotMessage({})).toBe(false);
    });
  });
});
