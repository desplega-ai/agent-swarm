import { afterEach, describe, expect, it, mock } from "bun:test";

import { resolveCodexLoginConfig, runCodexLogin } from "../commands/codex-login.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";

describe("resolveCodexLoginConfig", () => {
  it("uses defaults without prompts when not interactive", async () => {
    const promptText = mock(async () => {
      throw new Error("should not prompt for text");
    });
    const promptSecret = mock(async () => {
      throw new Error("should not prompt for secret");
    });

    const result = await resolveCodexLoginConfig([], {
      env: {},
      isInteractive: false,
      promptText,
      promptSecret,
    });

    expect(result).toEqual({
      apiUrl: "http://localhost:3013",
      apiKey: "123123",
    });
    expect(promptText).not.toHaveBeenCalled();
    expect(promptSecret).not.toHaveBeenCalled();
  });

  it("prompts for api url and api key in interactive mode", async () => {
    const promptText = mock(async () => "https://swarm.example.com");
    const promptSecret = mock(async () => "example-super-secret");

    const result = await resolveCodexLoginConfig([], {
      env: {},
      isInteractive: true,
      promptText,
      promptSecret,
    });

    expect(result).toEqual({
      apiUrl: "https://swarm.example.com",
      apiKey: "example-super-secret",
    });
    expect(promptText).toHaveBeenCalledWith("Swarm API URL", "http://localhost:3013");
    expect(promptSecret).toHaveBeenCalledWith(
      "Swarm API key",
      "123123",
      "Press Enter to use the default local API key",
    );
  });

  it("uses environment defaults when interactive prompts are left blank", async () => {
    const promptText = mock(async () => "");
    const promptSecret = mock(async () => "");

    const result = await resolveCodexLoginConfig([], {
      env: {
        MCP_BASE_URL: "https://env.example.com",
        API_KEY: "example-env-secret",
      },
      isInteractive: true,
      promptText,
      promptSecret,
    });

    expect(result).toEqual({
      apiUrl: "https://env.example.com",
      apiKey: "example-env-secret",
    });
    expect(promptSecret).toHaveBeenCalledWith(
      "Swarm API key",
      "example-env-secret",
      "Press Enter to use AGENT_SWARM_API_KEY/API_KEY from the environment",
    );
  });

  it("does not prompt when flags are provided", async () => {
    const promptText = mock(async () => {
      throw new Error("should not prompt for text");
    });
    const promptSecret = mock(async () => {
      throw new Error("should not prompt for secret");
    });

    const result = await resolveCodexLoginConfig(
      ["--api-url", "https://flag.example.com", "--api-key", "example-flag-secret"],
      {
        env: {
          MCP_BASE_URL: "https://env.example.com",
          API_KEY: "example-env-secret",
        },
        isInteractive: true,
        promptText,
        promptSecret,
      },
    );

    expect(result).toEqual({
      apiUrl: "https://flag.example.com",
      apiKey: "example-flag-secret",
    });
    expect(promptText).not.toHaveBeenCalled();
    expect(promptSecret).not.toHaveBeenCalled();
  });

  it("prompts only for the missing value when one flag is provided", async () => {
    const promptText = mock(async () => {
      throw new Error("should not prompt for api url");
    });
    const promptSecret = mock(async () => "example-prompted-secret");

    const result = await resolveCodexLoginConfig(["--api-url", "https://flag.example.com"], {
      env: {},
      isInteractive: true,
      promptText,
      promptSecret,
    });

    expect(result).toEqual({
      apiUrl: "https://flag.example.com",
      apiKey: "example-prompted-secret",
    });
    expect(promptText).not.toHaveBeenCalled();
    expect(promptSecret).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCodexLoginConfig --slot", () => {
  it("passes slot from --slot flag through", async () => {
    const result = await resolveCodexLoginConfig(["--slot", "2"], {
      env: {},
      isInteractive: false,
      promptText: mock(async () => ""),
      promptSecret: mock(async () => ""),
    });

    expect(result.slot).toBe(2);
  });

  it("slot is undefined when --slot not provided", async () => {
    const result = await resolveCodexLoginConfig([], {
      env: {},
      isInteractive: false,
      promptText: mock(async () => ""),
      promptSecret: mock(async () => ""),
    });

    expect(result.slot).toBeUndefined();
  });
});

describe("runCodexLogin", () => {
  it("handles prompt cancellation cleanly before starting OAuth", async () => {
    const error = mock(() => {});
    const exit = mock(() => {});
    const login = mock(async () => {
      throw new Error("should not start oauth");
    });
    const store = mock(async () => {
      throw new Error("should not store");
    });

    await runCodexLogin([], {
      resolveConfig: async () => {
        throw new Error("Aborted");
      },
      login,
      store,
      log: () => {},
      error,
      exit,
    });

    expect(error).toHaveBeenCalledWith("\nError: Aborted");
    expect(exit).toHaveBeenCalledWith(1);
    expect(login).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("uses explicit --slot when provided", async () => {
    let storedSlot: number | undefined;
    const store = mock(async (_apiUrl: string, _apiKey: string, _creds: unknown, slot?: number) => {
      storedSlot = slot;
    });

    await runCodexLogin([], {
      resolveConfig: async () => ({
        apiUrl: "http://localhost:3013",
        apiKey: "example-test-key",
        slot: 3,
      }),
      login: mock(async () => ({
        access: "at_test",
        refresh: "rt_test",
        expires: Date.now() + 3600000,
        accountId: "acc-test",
      })),
      store,
      loadAllSlots: mock(async () => []),
      clearAuthBench: mock(async () => false),
      readAuthFence: mock(async () => 0),
      log: () => {},
      error: () => {},
      exit: () => {},
    });

    expect(storedSlot).toBe(3);
  });

  it("auto-picks next free slot when --slot not provided", async () => {
    let storedSlot: number | undefined;
    const store = mock(async (_apiUrl: string, _apiKey: string, _creds: unknown, slot?: number) => {
      storedSlot = slot;
    });

    await runCodexLogin([], {
      resolveConfig: async () => ({
        apiUrl: "http://localhost:3013",
        apiKey: "example-test-key",
        slot: undefined,
      }),
      login: mock(async () => ({
        access: "at_test",
        refresh: "rt_test",
        expires: Date.now() + 3600000,
        accountId: "acc-test",
      })),
      store,
      // slots 0 and 1 already occupied — next free should be 2
      loadAllSlots: mock(async () => [
        { slot: 0, creds: { access: "", refresh: "", expires: 0, accountId: "" } },
        { slot: 1, creds: { access: "", refresh: "", expires: 0, accountId: "" } },
      ]),
      clearAuthBench: mock(async () => false),
      readAuthFence: mock(async () => 0),
      log: () => {},
      error: () => {},
      exit: () => {},
    });

    expect(storedSlot).toBe(2);
  });

  it("rejects invalid slot (out of range)", async () => {
    const error = mock(() => {});
    const exit = mock(() => {});
    const store = mock(async () => {});

    await runCodexLogin([], {
      resolveConfig: async () => ({
        apiUrl: "http://localhost:3013",
        apiKey: "example-test-key",
        slot: 101,
      }),
      login: mock(async () => {
        throw new Error("should not start oauth");
      }),
      store,
      loadAllSlots: mock(async () => []),
      log: () => {},
      error,
      exit,
    });

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("--slot must be an integer between 0 and 100"),
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(store).not.toHaveBeenCalled();
  });

  it("accepts slot 10 (previously rejected by the old 0-9 cap)", async () => {
    let storedSlot: number | undefined;
    const store = mock(async (_apiUrl: string, _apiKey: string, _creds: unknown, slot?: number) => {
      storedSlot = slot;
    });

    await runCodexLogin([], {
      resolveConfig: async () => ({
        apiUrl: "http://localhost:3013",
        apiKey: "example-test-key",
        slot: 10,
      }),
      login: mock(async () => ({
        access: "at_test",
        refresh: "rt_test",
        expires: Date.now() + 3600000,
        accountId: "acc-test",
      })),
      store,
      loadAllSlots: mock(async () => []),
      clearAuthBench: mock(async () => false),
      readAuthFence: mock(async () => 0),
      log: () => {},
      error: () => {},
      exit: () => {},
    });

    expect(storedSlot).toBe(10);
  });

  it("errors when all slots are occupied", async () => {
    const error = mock(() => {});
    const exit = mock(() => {});

    // All 101 slots occupied (0-100)
    const allSlots = Array.from({ length: 101 }, (_, i) => ({
      slot: i,
      creds: { access: "", refresh: "", expires: 0, accountId: "" },
    }));

    await runCodexLogin([], {
      resolveConfig: async () => ({
        apiUrl: "http://localhost:3013",
        apiKey: "example-test-key",
        slot: undefined,
      }),
      login: mock(async () => {
        throw new Error("should not start oauth");
      }),
      store: mock(async () => {}),
      loadAllSlots: mock(async () => allSlots),
      log: () => {},
      error,
      exit,
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("All credential slots"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("lifts the auth-failure bench on the re-logged key after storing", async () => {
    const calls: string[] = [];
    const store = mock(async () => {
      calls.push("store");
    });
    const clearAuthBench = mock(
      async (_apiUrl: string, _apiKey: string, keySuffix: string, slot: number, fence: number) => {
        calls.push(`clear:${keySuffix}@${slot} fence ${fence}`);
        return true;
      },
    );
    const readAuthFence = mock(async () => {
      calls.push("read-fence");
      return 7;
    });

    await runCodexLogin([], {
      resolveConfig: async () => ({
        apiUrl: "http://localhost:3013",
        apiKey: "example-test-key",
        slot: 2,
      }),
      login: mock(async () => ({
        access: "at_test",
        refresh: "rt_test",
        expires: Date.now() + 3600000,
        accountId: "acc-test-d3Ove",
      })),
      store,
      loadAllSlots: mock(async () => []),
      clearAuthBench,
      readAuthFence,
      log: () => {},
      error: () => {},
      exit: () => {},
    });

    // at_test has no chatgpt_user_id claim, so the suffix falls back to accountId.
    // The fence is read BEFORE the credential write, so failures on the fresh login survive.
    expect(calls).toEqual(["read-fence", "store", "clear:d3Ove@2 fence 7"]);
  });

  it("skips the unfenced clear when the fence cannot be read", async () => {
    const error = mock(() => {});
    const exit = mock(() => {});
    const store = mock(async () => {});
    const clearAuthBench = mock(async () => true);

    await runCodexLogin([], {
      resolveConfig: async () => ({
        apiUrl: "http://localhost:3013",
        apiKey: "example-test-key",
        slot: 2,
      }),
      login: mock(async () => ({
        access: "at_test",
        refresh: "rt_test",
        expires: Date.now() + 3600000,
        accountId: "acc-test-d3Ove",
      })),
      store,
      loadAllSlots: mock(async () => []),
      clearAuthBench,
      readAuthFence: mock(async () => {
        throw new Error("keys/available returned 503");
      }),
      log: () => {},
      error,
      exit,
    });

    expect(store).toHaveBeenCalled();
    expect(clearAuthBench).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("keys/available returned 503"));
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps a successful login when lifting the bench fails", async () => {
    const error = mock(() => {});
    const exit = mock(() => {});

    await runCodexLogin([], {
      resolveConfig: async () => ({
        apiUrl: "http://localhost:3013",
        apiKey: "example-test-key",
        slot: 2,
      }),
      login: mock(async () => ({
        access: "at_test",
        refresh: "rt_test",
        expires: Date.now() + 3600000,
        accountId: "acc-test-d3Ove",
      })),
      store: mock(async () => {}),
      loadAllSlots: mock(async () => []),
      clearAuthBench: mock(async () => {
        throw new Error("clear-rate-limit returned 500");
      }),
      readAuthFence: mock(async () => 0),
      log: () => {},
      error,
      exit,
    });

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("could not lift the auth-failure bench"),
    );
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("runCodexLogin duplicate accounts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function credentials(userId: string | null, accountId = "team-account"): CodexOAuthCredentials {
    const payload = { "https://api.openai.com/auth": { chatgpt_user_id: userId } };
    return {
      access: `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`,
      refresh: "fixture-refresh",
      expires: Date.now() + 3600000,
      accountId,
    };
  }

  const loginCredentials = credentials("user-a-shared");
  const sameUser = { slot: 0, creds: credentials("user-a-shared") };

  it.each([
    {
      name: "warns for an automatically selected slot",
      slot: undefined,
      existing: [sameUser],
      creds: loginCredentials,
      storedSlot: 1,
      warningSlots: [0],
    },
    {
      name: "warns for another explicitly selected slot",
      slot: 2,
      existing: [sameUser],
      creds: loginCredentials,
      storedSlot: 2,
      warningSlots: [0],
    },
    {
      name: "does not warn when replacing the same slot",
      slot: 0,
      existing: [sameUser],
      creds: loginCredentials,
      storedSlot: 0,
      warningSlots: [],
    },
    {
      name: "does not confuse Team users with matching key suffixes",
      slot: 2,
      existing: [{ slot: 0, creds: credentials("user-b-shared") }],
      creds: loginCredentials,
      storedSlot: 2,
      warningSlots: [],
    },
    {
      name: "does not confuse the same user on different accounts",
      slot: 2,
      existing: [{ slot: 0, creds: credentials("user-a-shared", "other-account") }],
      creds: loginCredentials,
      storedSlot: 2,
      warningSlots: [],
    },
    {
      name: "does not infer a duplicate from an existing token without a user ID",
      slot: 2,
      existing: [{ slot: 0, creds: credentials(null) }],
      creds: loginCredentials,
      storedSlot: 2,
      warningSlots: [],
    },
    {
      name: "does not infer a duplicate from a new token without a user ID",
      slot: 2,
      existing: [sameUser],
      creds: credentials(null),
      storedSlot: 2,
      warningSlots: [],
    },
    {
      name: "lists every duplicate slot except the one being replaced",
      slot: 2,
      existing: [sameUser, { ...sameUser, slot: 2 }, { ...sameUser, slot: 3 }],
      creds: loginCredentials,
      storedSlot: 2,
      warningSlots: [0, 3],
    },
  ])("$name", async ({ slot, existing, creds, storedSlot, warningSlots }) => {
    const calls: string[] = [];
    const error = mock((_message: string) => calls.push("warning"));
    const exit = mock(() => {});
    const store = mock(async () => {
      calls.push("store");
    });

    await runCodexLogin([], {
      resolveConfig: async () => ({ apiUrl: "http://localhost:3013", apiKey: "fixture", slot }),
      login: async () => creds,
      loadAllSlots: async () => existing,
      store,
      readAuthFence: async () => 0,
      clearAuthBench: async () => false,
      log: () => {},
      error,
      exit,
    });

    expect(store).toHaveBeenCalledWith("http://localhost:3013", "fixture", creds, storedSlot);
    expect(exit).not.toHaveBeenCalled();
    if (warningSlots.length > 0) {
      expect(error).toHaveBeenCalledWith(
        `Warning: This ChatGPT user already has Codex credentials in slot(s) ${warningSlots.join(", ")}. ` +
          `This login will also be stored in slot ${storedSlot}. ` +
          `To replace existing credentials, re-run agent-swarm codex-login --slot ${warningSlots[0]}.`,
      );
      expect(calls).toEqual(["warning", "store"]);
      const warning = error.mock.calls[0]?.[0] ?? "";
      expect(warning).not.toContain(creds.access);
      expect(warning).not.toContain(creds.refresh);
    } else {
      expect(error).not.toHaveBeenCalled();
    }
  });

  it("rechecks the pool after the browser login completes", async () => {
    const error = mock(() => {});
    const store = mock(async () => {});
    const loadAllSlots = mock(async () => [{ slot: 0, creds: credentials("another-user") }]);

    await runCodexLogin([], {
      resolveConfig: async () => ({ apiUrl: "http://localhost:3013", apiKey: "fixture" }),
      login: async () => {
        loadAllSlots.mockResolvedValue([sameUser]);
        return loginCredentials;
      },
      loadAllSlots,
      store,
      readAuthFence: async () => 0,
      clearAuthBench: async () => false,
      log: () => {},
      error,
      exit: () => {},
    });

    expect(loadAllSlots).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("credentials in slot(s) 0."));
    expect(store).toHaveBeenCalledWith("http://localhost:3013", "fixture", loginCredentials, 1);
  });

  it.each([
    "HTTP 503",
    "network error",
  ])("warns and stores credentials when the slot lookup fails with %s", async (failure) => {
    const fetchSlots = mock(async () => {
      if (failure === "network error") throw new Error("Network error");
      return new Response("Service unavailable", { status: 503 });
    });
    globalThis.fetch = fetchSlots;
    const calls: string[] = [];
    const error = mock((_message: string) => calls.push("warning"));
    const exit = mock(() => {});
    const store = mock(async () => {
      calls.push("store");
    });

    await runCodexLogin([], {
      resolveConfig: async () => ({ apiUrl: "http://localhost:3013", apiKey: "fixture", slot: 2 }),
      login: async () => loginCredentials,
      store,
      readAuthFence: async () => 0,
      clearAuthBench: async () => false,
      log: () => {},
      error,
      exit,
    });

    expect(error).toHaveBeenCalledWith(
      "Warning: Could not check existing Codex slots for duplicate accounts.",
    );
    expect(fetchSlots).toHaveBeenCalledWith(
      "http://localhost:3013/api/config/resolved?includeSecrets=true",
      { headers: { Authorization: "Bearer fixture" } },
    );
    expect(calls).toEqual(["warning", "store"]);
    expect(store).toHaveBeenCalledWith("http://localhost:3013", "fixture", loginCredentials, 2);
    expect(exit).not.toHaveBeenCalled();
  });
});
