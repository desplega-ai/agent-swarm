import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { canProvisionKind, createRuntimeProvider } from "../runtime-providers";
import { type RuntimeProviderKind, RuntimeProviderKindSchema } from "../types";

const repoRoot = join(import.meta.dir, "..", "..");
const kinds = RuntimeProviderKindSchema.options;
const notImplemented = { k8s: "adapter not implemented" };

interface TouchPoint {
  file: string;
  members: () => Promise<readonly string[]>;
  exempt: Partial<Record<RuntimeProviderKind, string>>;
}

const TOUCH_POINTS: TouchPoint[] = [
  {
    file: "src/runtime-providers/index.ts (Supported: list)",
    members: async () => {
      try {
        await createRuntimeProvider("__unregistered__" as RuntimeProviderKind);
      } catch (err) {
        const list = String(err).split("Supported:")[1];
        if (list === undefined) throw new Error('Factory error must include "Supported:".');
        return list.split(",").map((kind) => kind.trim());
      }
      throw new Error("Factory accepted an unregistered runtime provider.");
    },
    exempt: notImplemented,
  },
  {
    file: "src/runtime-providers/<kind>.ts",
    members: async () => {
      const present: string[] = [];
      for (const kind of kinds) {
        if (await Bun.file(join(repoRoot, `src/runtime-providers/${kind}.ts`)).exists()) {
          present.push(kind);
        }
      }
      return present;
    },
    exempt: notImplemented,
  },
  {
    file: "runbooks/runtime-providers.md",
    members: async () => {
      const source = await Bun.file(join(repoRoot, "runbooks/runtime-providers.md")).text();
      return kinds.filter((kind) => new RegExp(`^#{2,3} ${kind}\\s*$`, "m").test(source));
    },
    exempt: notImplemented,
  },
  {
    file: "apps/ui/src/lib/runtime-pools.ts (RUNTIME_PROVIDER_KINDS)",
    members: async () => {
      const file = Bun.file(join(repoRoot, "apps/ui/src/lib/runtime-pools.ts"));
      if (!(await file.exists())) return [];
      const match = (await file.text()).match(
        /export const RUNTIME_PROVIDER_KINDS[^=]*=\s*\[([^\]]*)\]/,
      );
      if (!match?.[1]) throw new Error("Cannot find RUNTIME_PROVIDER_KINDS in runtime-pools.ts.");
      return [...match[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1] as string);
    },
    // The UI lists k8s too (disabled, "coming soon"), so no kind is exempt.
    exempt: {},
  },
];

describe("runtime provider registration", () => {
  for (const point of TOUCH_POINTS) {
    test(`${point.file} registers every kind or has a current exemption`, async () => {
      const members = await point.members();
      for (const [kind, reason] of Object.entries(point.exempt)) {
        expect(reason.length).toBeGreaterThan(0);
        if (!kinds.includes(kind as RuntimeProviderKind) || members.includes(kind)) {
          throw new Error(
            `Stale exemption for ${kind} in ${point.file}. Remove it from the registration test.`,
          );
        }
      }
      for (const kind of kinds) {
        if (!point.exempt[kind] && !members.includes(kind)) {
          throw new Error(
            `Runtime provider ${kind} is missing from ${point.file}. Register it or add an exemption with a reason.`,
          );
        }
      }
    });
  }

  test("static provisioning lookup matches adapter traits", async () => {
    expect(canProvisionKind("k8s")).toBe(false);
    for (const kind of kinds.filter((kind) => kind !== "k8s"))
      expect(canProvisionKind(kind)).toBe((await createRuntimeProvider(kind)).traits.canProvision);
  });

  for (const kind of kinds.filter((kind) => kind !== "k8s")) {
    test(`factory creates ${kind}`, async () => {
      expect((await createRuntimeProvider(kind)).kind).toBe(kind);
    });
  }

  test("k8s explicitly rejects provisioning support", async () => {
    await expect(createRuntimeProvider("k8s")).rejects.toThrow(
      'Unknown runtime provider: "k8s" (not implemented). Supported: static, docker, e2b',
    );
  });

  test("static workers remain operator-managed", async () => {
    const provider = await createRuntimeProvider("static");
    const handle = { kind: "static" as const, externalId: "operator-worker" };
    expect(provider.traits.canProvision).toBe(false);
    expect(provider.checkConfig({})).toEqual({ ready: true, missing: [] });
    expect(await provider.status({}, handle)).toBe("unknown");
    expect(await provider.list({}, "owner")).toEqual([]);
    await expect(
      provider.provision(
        {},
        {
          runtimeId: crypto.randomUUID(),
          agentId: crypto.randomUUID(),
          poolId: "pool",
          ownerId: "owner",
          image: "unused",
          env: {},
          labels: {},
        },
      ),
    ).rejects.toThrow("static pools are operator-managed");
    await expect(provider.terminate({}, handle, "test")).rejects.toThrow(
      "static pools are operator-managed",
    );
  });
});
