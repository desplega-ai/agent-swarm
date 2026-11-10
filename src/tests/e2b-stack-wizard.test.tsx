import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { act } from "react";
import { StackWizard, type StackWizardResult } from "../commands/e2b-stack-wizard";

for (const field of [
  {
    step: "workers",
    key: "workers",
    prompt: "How many workers?",
    error: "Enter a positive integer (at least 1 worker).",
    fallback: 3,
  },
  {
    step: "timeout",
    key: "timeoutSec",
    prompt: "Sandbox TTL (seconds):",
    error: "Enter a positive integer (seconds).",
    fallback: 60,
  },
] as const) {
  describe(`stack wizard ${field.step}`, () => {
    test("rejects malformed integers without advancing and accepts a corrected value", async () => {
      const wizard = await startWizard();
      try {
        for (const value of [
          "2.5",
          "2workers",
          "30seconds",
          "1.0",
          "0",
          "-1",
          "NaN",
          "Infinity",
          "1e2",
          "0x10",
          "9007199254740993",
        ]) {
          await wizard.submit(value);
          expect(wizard.frame()).toContain(field.prompt);
          expect(wizard.frame()).toContain(field.error);
          expect(wizard.result()).toBeUndefined();
        }
        await wizard.submit("12");
        expect(wizard.result()?.[field.key]).toBe(12);
        expect(wizard.frame()).not.toContain(field.error);
      } finally {
        wizard.cleanup();
      }
    });

    test.each([
      ["1", 1],
      ["30", 30],
      [" 12 ", 12],
      ["", field.fallback],
      ["   ", field.fallback],
    ])("accepts %j as %i", async (input, expected) => {
      const wizard = await startWizard();
      try {
        await wizard.submit(input);
        expect(wizard.result()?.[field.key]).toBe(expected);
      } finally {
        wizard.cleanup();
      }
    });

    async function startWizard() {
      const stdin = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode() {
          return this;
        },
        ref() {
          return this;
        },
        unref() {
          return this;
        },
      });
      const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40 });
      let frame = "";
      stdout.on("data", (chunk) => {
        frame = chunk.toString();
      });
      let result: StackWizardResult | undefined;
      const app = render(
        <StackWizard
          defaults={{
            swarmSlug: "test-swarm",
            workers: 3,
            timeoutSec: 60,
            provider: "claude",
            envFiles: [],
            integrations: { slack: true, github: true, jira: true, linear: true },
            noLead: false,
          }}
          skips={{
            swarm: true,
            workers: true,
            timeout: true,
            provider: true,
            envFiles: true,
            integrations: true,
            [field.step]: false,
          }}
          onComplete={(value) => {
            result = value;
          }}
        />,
        {
          stdin: stdin as NodeJS.ReadStream,
          stdout: stdout as NodeJS.WriteStream,
          debug: true,
          patchConsole: false,
        },
      );
      const send = async (input: string) => {
        const environment = globalThis as typeof globalThis & {
          IS_REACT_ACT_ENVIRONMENT?: boolean;
        };
        const previous = environment.IS_REACT_ACT_ENVIRONMENT;
        environment.IS_REACT_ACT_ENVIRONMENT = true;
        try {
          await act(async () => {
            stdin.write(input);
            await new Promise((resolve) => setImmediate(resolve));
          });
        } finally {
          environment.IS_REACT_ACT_ENVIRONMENT = previous;
        }
      };
      await new Promise((resolve) => setImmediate(resolve));
      await send("\r");
      expect(frame).toContain(field.prompt);
      let previous = String(field.fallback);
      return {
        frame: () => frame,
        result: () => result,
        submit: async (input: string) => {
          for (const _ of previous) await send("\u007f");
          if (input) await send(input);
          await send("\r");
          previous = input;
        },
        cleanup: () => {
          app.unmount();
          app.cleanup();
          stdin.destroy();
          stdout.destroy();
        },
      };
    }
  });
}
