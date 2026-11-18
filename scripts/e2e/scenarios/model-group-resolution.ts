import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { Cleanup, retireAgent } from "./platformb-helpers";

/**
 * Model groups resolve per agent: create-time exclusivity and the pinned-agent
 * gate, claim through the first member on the claiming harness, the pool wait
 * for an agent where a member runs, schedules and workflow nodes carrying the
 * group, and a provider-error hop through the group order that never repeats a
 * member.
 */
export const modelGroupResolution: Scenario = {
  name: "model-group-resolution",
  order: 662,
  async run(ctx) {
    const cleanup = new Cleanup();
    const agents: string[] = [];
    const groups: string[] = [];
    const scheduleIds: string[] = [];
    cleanup.add("retire agents", async () => {
      for (const id of agents) await retireAgent(ctx, id);
    });
    cleanup.add("delete schedules", async () => {
      for (const id of scheduleIds) await ctx.api("DELETE", `/api/schedules/${id}`);
    });
    cleanup.add("delete groups", async () => {
      // A group stays referenced by its tasks; the delete guard keeps those, so ignore 409s.
      for (const name of groups) await ctx.api("DELETE", `/api/model-groups/${name}`);
    });

    const register = async (name: string, harness: string) => {
      const response = await ctx.api("POST", "/api/agents", {
        body: { name, role: "worker", status: "online", harness_provider: harness },
      });
      expectStatus(response, [201], `register ${harness} worker`);
      const id = String(asRecord(response.json).id);
      agents.push(id);
      return id;
    };
    const createGroup = async (suffix: string, members: string[]) => {
      const name = `e2e-mgr-${suffix}-${ctx.nonce}`;
      const response = await ctx.api("POST", "/api/model-groups", { body: { name, members } });
      expectStatus(response, [201], `create group ${name}`);
      groups.push(name);
      return name;
    };
    const claim = async (agentId: string, taskId: string, label: string) => {
      const response = await ctx.api("GET", "/api/poll", { agentId });
      expectStatus(response, [200], `${label}: poll`);
      const trigger = asRecord(asRecord(response.json).trigger ?? {});
      expect(
        trigger.type === "task_assigned" && trigger.taskId === taskId,
        `${label}: poll did not return ${taskId} (${JSON.stringify(trigger).slice(0, 300)})`,
      );
      return asRecord(trigger.task);
    };

    await cleanup.around(async () => {
      const codexId = await register(`e2e-mgr-codex-${ctx.nonce}`, "codex");
      const claudeId = await register(`e2e-mgr-claude-${ctx.nonce}`, "claude");
      const mixed = await createGroup("mixed", ["claude-smol", "codex-smol"]);
      const claudeOnly = await createGroup("claude", ["claude-smol"]);

      // ===== create-time gates =====
      let response = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `mgr excl ${ctx.nonce}`,
          source: "api",
          modelGroup: mixed,
          profile: "codex-smol",
        },
      });
      expectStatus(response, [400], "modelGroup beside profile");
      expect(
        String(asRecord(response.json).error).includes("Pass `modelGroup`"),
        `Exclusivity error is ${String(asRecord(response.json).error)}`,
      );
      response = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `mgr unknown ${ctx.nonce}`,
          source: "api",
          modelGroup: `no-such-${ctx.nonce}`,
        },
      });
      expectStatus(response, [400], "unknown model group");
      expect(
        String(asRecord(response.json).error).includes("Unknown model group"),
        `Unknown-group error is ${String(asRecord(response.json).error)}`,
      );
      response = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `mgr pinned none ${ctx.nonce}`,
          source: "api",
          agentId: codexId,
          routingReason: "human_pinned",
          modelGroup: claudeOnly,
        },
      });
      expectStatus(response, [400], "pinned agent with no member on its harness");
      const noMember = String(asRecord(response.json).error);
      expect(
        noMember.includes("[model-group-unavailable]") &&
          noMember.includes("claude-smol (harness: runs on claude)"),
        `No-member error is ${noMember}`,
      );

      // ===== claim on a pinned agent: first member on its harness =====
      response = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `mgr pinned ${ctx.nonce}`,
          source: "api",
          agentId: codexId,
          routingReason: "human_pinned",
          modelGroup: mixed,
        },
      });
      expectStatus(response, [201], "pinned group task");
      const pinnedId = String(asRecord(response.json).id);
      let task = await claim(codexId, pinnedId, "codex claims the group task");
      expect(
        task.resolvedProfile === "codex-smol" &&
          task.modelSource === "profile:group" &&
          task.modelGroup === mixed,
        `Group task resolved to ${String(task.resolvedProfile)} (${String(task.modelSource)})`,
      );
      const log = ctx.db.get<{ metadata: string }>(
        "SELECT metadata FROM agent_log WHERE taskId = ? AND eventType = 'task_model_group_resolved'",
        [pinnedId],
      );
      const meta = JSON.parse(log?.metadata ?? "{}") as {
        member?: string;
        skipped?: { profile: string; reason: string }[];
      };
      expect(
        meta.member === "codex-smol" && meta.skipped?.[0]?.profile === "claude-smol",
        `Group resolution log is ${log?.metadata}`,
      );
      expectStatus(
        await ctx.api("POST", `/api/tasks/${pinnedId}/finish`, {
          agentId: codexId,
          body: { status: "completed", output: "done" },
        }),
        [200],
        "finish the pinned group task",
      );

      // ===== pool: only an agent where a member runs claims it =====
      response = await ctx.api("POST", "/api/tasks", {
        body: { task: `mgr pool ${ctx.nonce}`, source: "api", modelGroup: claudeOnly },
      });
      expectStatus(response, [201], "pool group task");
      const poolId = String(asRecord(response.json).id);
      response = await ctx.api("GET", "/api/poll", { agentId: codexId });
      expectStatus(response, [200], "codex polls the pool");
      const codexTrigger = asRecord(asRecord(response.json).trigger ?? {});
      expect(
        codexTrigger.taskId !== poolId,
        "A codex worker claimed a pool task whose group has no codex member",
      );
      task = await claim(claudeId, poolId, "claude claims the pool group task");
      expect(
        task.resolvedProfile === "claude-smol" && task.modelSource === "profile:group",
        `Pool group task resolved to ${String(task.resolvedProfile)} (${String(task.modelSource)})`,
      );
      expectStatus(
        await ctx.api("POST", `/api/tasks/${poolId}/finish`, {
          agentId: claudeId,
          body: { status: "completed", output: "done" },
        }),
        [200],
        "finish the pool group task",
      );

      // ===== hop through the group order, never repeating a member =====
      const chain = await createGroup("chain", ["codex-smol", "claude-smol", "codex-regular"]);
      response = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `mgr hop ${ctx.nonce}`,
          source: "api",
          agentId: codexId,
          routingReason: "human_pinned",
          modelGroup: chain,
        },
      });
      expectStatus(response, [201], "group task to hop");
      const hopId = String(asRecord(response.json).id);
      task = await claim(codexId, hopId, "codex claims the hop task");
      expect(
        task.resolvedProfile === "codex-smol",
        `Hop task started on ${String(task.resolvedProfile)}`,
      );
      response = await ctx.api("POST", `/api/tasks/${hopId}/supersede`, {
        agentId: codexId,
        body: { reason: "provider_fallback", errorClass: "model_window" },
      });
      expectStatus(response, [200], "first provider-error supersede");
      const resumeId = String(asRecord(response.json).resumeTaskId);
      response = await ctx.api("GET", `/api/tasks/${resumeId}`);
      expectStatus(response, [200], "read the hop resume");
      const resume = asRecord(response.json);
      const hops = resume.fallbackHops as { from: string; profile: string }[] | undefined;
      expect(
        resume.profile === "codex-regular" &&
          resume.modelGroup === chain &&
          hops?.length === 1 &&
          hops[0]?.from === "codex-smol" &&
          hops[0]?.profile === "codex-regular",
        `Hop resume is ${JSON.stringify({ profile: resume.profile, modelGroup: resume.modelGroup, hops })}`,
      );
      task = await claim(codexId, resumeId, "codex claims the hop resume");
      expect(
        task.resolvedProfile === "codex-regular" && task.modelSource === "profile:task",
        `Hop resume resolved to ${String(task.resolvedProfile)} (${String(task.modelSource)})`,
      );
      response = await ctx.api("POST", `/api/tasks/${resumeId}/supersede`, {
        agentId: codexId,
        body: { reason: "provider_fallback", errorClass: "model_window" },
      });
      expectStatus(response, [200], "second provider-error supersede");
      expect(
        asRecord(response.json).kind === "noFallback",
        `The last member hopped again: ${JSON.stringify(response.json).slice(0, 300)}`,
      );
      expectStatus(
        await ctx.api("POST", `/api/tasks/${resumeId}/finish`, {
          agentId: codexId,
          body: { status: "completed", output: "done" },
        }),
        [200],
        "finish the hop resume",
      );

      // ===== a tier task its group resolved hops through the group order =====
      // The tier group is a boot seed shared by the run: restore its members and
      // the seeded profiles' fallbacks whatever happens below.
      const readJson = async (path: string, label: string) => {
        const read = await ctx.api("GET", path);
        expectStatus(read, [200], label);
        return asRecord(read.json);
      };
      const tierMembers = (await readJson("/api/model-groups/ultra", "read the ultra group"))
        .members as string[];
      const savedFallbacks = new Map<string, string[]>();
      for (const name of ["codex-regular", "claude-ultra"]) {
        const profile = await readJson(`/api/model-profiles/${name}`, `read ${name}`);
        savedFallbacks.set(name, (profile.fallbacks as string[] | undefined) ?? []);
      }
      cleanup.add("restore the ultra group and seeded fallbacks", async () => {
        await ctx.api("PUT", "/api/model-groups/ultra/members", { body: { members: tierMembers } });
        for (const [name, fallbacks] of savedFallbacks) {
          await ctx.api("PATCH", `/api/model-profiles/${name}`, { body: { fallbacks } });
        }
      });
      expectStatus(
        await ctx.api("PUT", "/api/model-groups/ultra/members", {
          body: { members: ["codex-regular", "codex-smart", "codex-ultra"] },
        }),
        [200],
        "edit the ultra group",
      );
      // A member fallback the group order must override.
      expectStatus(
        await ctx.api("PATCH", "/api/model-profiles/codex-regular", {
          body: { fallbacks: ["codex-ultra"] },
        }),
        [200],
        "give codex-regular a fallback outside the group order",
      );
      const tierCodexId = await register(`e2e-mgr-tier-${ctx.nonce}`, "codex");
      // Two pooled keys, so a rate limit retries the profile on the other key first.
      const poolKeys = [`sk-e2e-mgr-${ctx.nonce}-k1aaa`, `sk-e2e-mgr-${ctx.nonce}-k2bbb`];
      response = await ctx.api("PUT", "/api/config", {
        body: {
          scope: "agent",
          scopeId: tierCodexId,
          key: "OPENAI_API_KEY",
          value: poolKeys.join(","),
          isSecret: true,
        },
      });
      expectStatus(response, [200], "pool two OpenAI keys on the tier worker");
      const poolConfigId = String(asRecord(response.json).id);
      cleanup.add("delete the pooled keys", () => ctx.api("DELETE", `/api/config/${poolConfigId}`));

      const supersede = async (agentId: string, taskId: string, errorClass: string) => {
        const res = await ctx.api("POST", `/api/tasks/${taskId}/supersede`, {
          agentId,
          body: { reason: "provider_fallback", errorClass },
        });
        expectStatus(res, [200], `supersede ${taskId} on ${errorClass}`);
        return asRecord(res.json);
      };
      const finish = async (agentId: string, taskId: string, label: string) =>
        expectStatus(
          await ctx.api("POST", `/api/tasks/${taskId}/finish`, {
            agentId,
            body: { status: "completed", output: "done" },
          }),
          [200],
          label,
        );
      const createTierTask = async (agentId: string, label: string) => {
        const res = await ctx.api("POST", "/api/tasks", {
          body: {
            task: `mgr ${label} ${ctx.nonce}`,
            source: "api",
            agentId,
            routingReason: "human_pinned",
            modelTier: "ultra",
          },
        });
        expectStatus(res, [201], `create ${label}`);
        return String(asRecord(res.json).id);
      };
      // One hop: the resume carries the group and the expected profile.
      const hopTo = async (
        agentId: string,
        taskId: string,
        errorClass: string,
        profile: string,
        hopCount: number,
      ) => {
        const result = await supersede(agentId, taskId, errorClass);
        expect(
          result.kind === "resumed" && typeof result.resumeTaskId === "string",
          `${errorClass} on ${taskId} did not resume: ${JSON.stringify(result).slice(0, 300)}`,
        );
        const resume = await readJson(`/api/tasks/${String(result.resumeTaskId)}`, "read resume");
        const hops = resume.fallbackHops as { from: string; profile: string }[] | undefined;
        expect(
          resume.profile === profile && resume.modelGroup === "ultra" && hops?.length === hopCount,
          `Resume after ${errorClass} is ${JSON.stringify({ profile: resume.profile, modelGroup: resume.modelGroup, hops })}`,
        );
        const claimed = await claim(agentId, String(resume.id), `claim the ${profile} resume`);
        expect(
          claimed.resolvedProfile === profile && claimed.modelSource === "profile:task",
          `Resume resolved to ${String(claimed.resolvedProfile)} (${String(claimed.modelSource)})`,
        );
        return String(resume.id);
      };

      const tierId = await createTierTask(tierCodexId, "tier hop");
      task = await claim(tierCodexId, tierId, "codex claims the tier task");
      expect(
        task.resolvedProfile === "codex-regular" && task.modelSource === "profile:group",
        `Tier task resolved to ${String(task.resolvedProfile)} (${String(task.modelSource)})`,
      );
      // Key retry first: same profile on the other key, still in the group.
      expectStatus(
        await ctx.api("POST", "/api/keys/report-usage", {
          agentId: tierCodexId,
          body: {
            keyType: "OPENAI_API_KEY",
            keySuffix: poolKeys[0]!.slice(-5),
            keyIndex: 0,
            taskId: tierId,
          },
        }),
        [200],
        "record the key the tier task drew",
      );
      let tierResume = await hopTo(tierCodexId, tierId, "rate_limit", "codex-regular", 1);
      // Then the group order: codex-smart (not codex-regular's own fallback), codex-ultra, stop.
      tierResume = await hopTo(tierCodexId, tierResume, "model_window", "codex-smart", 2);
      tierResume = await hopTo(tierCodexId, tierResume, "model_window", "codex-ultra", 3);
      const lastTier = await supersede(tierCodexId, tierResume, "model_window");
      expect(
        lastTier.kind === "noFallback",
        `The tier task hopped past the group: ${JSON.stringify(lastTier).slice(0, 300)}`,
      );
      await finish(tierCodexId, tierResume, "finish the last tier resume");

      // ===== a worker-env override still wins and never hops through the group =====
      response = await ctx.api("POST", "/api/agents", {
        body: {
          name: `e2e-mgr-env-${ctx.nonce}`,
          role: "worker",
          status: "online",
          harness_provider: "codex",
          modelTierOverrides: { codex: { ultra: "gpt-6.1-sol" } },
        },
      });
      expectStatus(response, [201], "register a codex worker with a tier override");
      const envId = String(asRecord(response.json).id);
      agents.push(envId);
      const envTask = await createTierTask(envId, "tier env");
      task = await claim(envId, envTask, "the override worker claims the tier task");
      expect(
        task.modelSource === "worker-env" && task.resolvedModel === "gpt-6.1-sol",
        `Override tier task resolved to ${String(task.resolvedModel)} (${String(task.modelSource)})`,
      );
      const envResult = await supersede(envId, envTask, "model_window");
      expect(
        envResult.kind === "noFallback",
        `A worker-env tier task hopped: ${JSON.stringify(envResult).slice(0, 300)}`,
      );
      await finish(envId, envTask, "finish the override tier task");

      // ===== no member on the harness: the seeded profile and its own fallbacks =====
      expectStatus(
        await ctx.api("PATCH", "/api/model-profiles/claude-ultra", {
          body: { fallbacks: ["claude-smart"] },
        }),
        [200],
        "give claude-ultra a fallback",
      );
      const seededTask = await createTierTask(claudeId, "tier seeded");
      task = await claim(claudeId, seededTask, "claude claims the tier task");
      expect(
        task.resolvedProfile === "claude-ultra" && task.modelSource === "profile:tier-alias",
        `Seeded tier task resolved to ${String(task.resolvedProfile)} (${String(task.modelSource)})`,
      );
      const seededResult = await supersede(claudeId, seededTask, "model_window");
      const seededResume = await readJson(
        `/api/tasks/${String(seededResult.resumeTaskId)}`,
        "read the seeded resume",
      );
      expect(
        seededResume.profile === "claude-smart" && seededResume.modelGroup === undefined,
        `Seeded resume is ${JSON.stringify({ profile: seededResume.profile, modelGroup: seededResume.modelGroup })}`,
      );
      await ctx.api("POST", `/api/tasks/${String(seededResume.id)}/cancel`, { body: {} });

      // ===== schedules carry the group =====
      const scheduleBody = {
        name: `e2e-mgr-sched-${ctx.nonce}`,
        taskTemplate: `mgr schedule ${ctx.nonce}`,
        intervalMs: 3_600_000,
        targetAgentId: codexId,
      };
      response = await ctx.api("POST", "/api/schedules", {
        body: { ...scheduleBody, modelGroup: mixed, modelTier: "smol" },
      });
      expectStatus(response, [400], "schedule with modelGroup beside modelTier");
      response = await ctx.api("POST", "/api/schedules", {
        body: { ...scheduleBody, modelGroup: claudeOnly },
      });
      expectStatus(response, [400], "schedule group with no member on its agent");
      response = await ctx.api("POST", "/api/schedules", {
        body: { ...scheduleBody, modelGroup: mixed },
      });
      expectStatus(response, [201], "schedule with a model group");
      const schedule = asRecord(response.json);
      const scheduleId = String(schedule.id);
      scheduleIds.push(scheduleId);
      expect(
        schedule.modelGroup === mixed,
        `Schedule modelGroup is ${String(schedule.modelGroup)}`,
      );
      response = await ctx.api("POST", `/api/schedules/${scheduleId}/run`);
      expectStatus(response, [200], "run the schedule now");
      const fired = asRecord(asRecord(response.json).task ?? {});
      expect(fired.modelGroup === mixed, `Fired task modelGroup is ${String(fired.modelGroup)}`);
      response = await ctx.api("PUT", `/api/schedules/${scheduleId}`, {
        body: { profile: "codex-smol" },
      });
      expectStatus(response, [200], "a profile replaces the schedule's group");
      const replaced = asRecord(response.json);
      expect(
        replaced.profile === "codex-smol" && replaced.modelGroup === undefined,
        `Updated schedule is ${JSON.stringify({ profile: replaced.profile, modelGroup: replaced.modelGroup })}`,
      );
      if (fired.id) {
        await ctx.api("POST", `/api/tasks/${String(fired.id)}/cancel`, { body: {} });
      }

      // ===== workflow nodes are validated like profile =====
      response = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `e2e-mgr-wf-${ctx.nonce}`,
          definition: {
            nodes: [
              {
                id: "t",
                type: "agent-task",
                config: { agentId: codexId, template: "work", modelGroup: claudeOnly },
              },
            ],
          },
        },
      });
      expectStatus(response, [400], "workflow node group with no member on its agent");
      expect(
        String(asRecord(response.json).error).includes("config.modelGroup"),
        `Workflow error is ${String(asRecord(response.json).error)}`,
      );
    });
  },
};
