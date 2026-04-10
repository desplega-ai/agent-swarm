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
      "Press Enter to use API_KEY from the environment",
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
});
