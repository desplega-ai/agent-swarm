import { describe, expect, it, mock } from "bun:test";

import { resolveCodexLoginConfig, runCodexLogin } from "../commands/codex-login.js";

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
    const promptSecret = mock(async () => "super-secret");

    const result = await resolveCodexLoginConfig([], {
      env: {},
      isInteractive: true,
      promptText,
      promptSecret,
    });

    expect(result).toEqual({
      apiUrl: "https://swarm.example.com",
      apiKey: "super-secret",
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
        API_KEY: "env-secret",
      },
      isInteractive: true,
      promptText,
      promptSecret,
    });

    expect(result).toEqual({
      apiUrl: "https://env.example.com",
      apiKey: "env-secret",
    });
    expect(promptSecret).toHaveBeenCalledWith(
      "Swarm API key",
      "env-secret",
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
      ["--api-url", "https://flag.example.com", "--api-key", "flag-secret"],
      {
        env: {
          MCP_BASE_URL: "https://env.example.com",
          API_KEY: "env-secret",
        },
        isInteractive: true,
        promptText,
        promptSecret,
      },
    );

    expect(result).toEqual({
      apiUrl: "https://flag.example.com",
      apiKey: "flag-secret",
    });
    expect(promptText).not.toHaveBeenCalled();
    expect(promptSecret).not.toHaveBeenCalled();
  });

  it("prompts only for the missing value when one flag is provided", async () => {
    const promptText = mock(async () => {
      throw new Error("should not prompt for api url");
    });
    const promptSecret = mock(async () => "prompted-secret");

    const result = await resolveCodexLoginConfig(["--api-url", "https://flag.example.com"], {
      env: {},
      isInteractive: true,
      promptText,
      promptSecret,
    });

    expect(result).toEqual({
      apiUrl: "https://flag.example.com",
      apiKey: "prompted-secret",
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
        apiKey: "test-key",
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
        apiKey: "test-key",
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
        apiKey: "test-key",
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
        apiKey: "test-key",
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
        apiKey: "test-key",
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
});
