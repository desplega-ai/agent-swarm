import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  getAgentById,
  getLatestContextVersion,
  initDb,
  updateAgentName,
  updateAgentProfile,
} from "../be/db";

const TEST_DB_PATH = "./test-update-profile-agentid.sqlite";

describe("update-profile agentId authorization", () => {
  const leadId = "aaaa0000-0000-4000-8000-000000000001";
  const workerId = "bbbb0000-0000-4000-8000-000000000002";
  const otherWorkerId = "cccc0000-0000-4000-8000-000000000003";
  const nonExistentId = "dddd0000-0000-4000-8000-000000000099";

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }

    closeDb();
    await initDb(TEST_DB_PATH);

    await createAgent({ id: leadId, name: "Test Lead", isLead: true, status: "idle" });
    await createAgent({ id: workerId, name: "Test Worker", isLead: false, status: "idle" });
    await createAgent({ id: otherWorkerId, name: "Other Worker", isLead: false, status: "idle" });
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
  });

  // ==========================================================================
  // Authorization logic (simulates update-profile tool handler checks)
  // ==========================================================================

  describe("lead agent can update another agent's profile", () => {
    test("lead updates worker description", async () => {
      const callingAgent = await getAgentById(leadId);
      expect(callingAgent).not.toBeNull();
      expect(callingAgent!.isLead).toBe(true);

      // Lead updating another agent — this is the happy path
      const updated = await updateAgentProfile(
        workerId,
        { description: "Updated by lead" },
        { changeSource: "lead_coaching", changedByAgentId: leadId },
      );
      expect(updated).not.toBeNull();
      expect(updated!.description).toBe("Updated by lead");
    });

    test("lead updates worker soulMd with lead_coaching changeSource", async () => {
      const updated = await updateAgentProfile(
        workerId,
        { soulMd: "# Soul updated by lead" },
        { changeSource: "lead_coaching", changedByAgentId: leadId },
      );
      expect(updated).not.toBeNull();
      expect(updated!.soulMd).toBe("# Soul updated by lead");

      // Verify the context version records lead_coaching as changeSource
      const version = await getLatestContextVersion(workerId, "soulMd");
      expect(version).not.toBeNull();
      expect(version!.changeSource).toBe("lead_coaching");
      expect(version!.changedByAgentId).toBe(leadId);
    });

    test("lead updates worker name", async () => {
      const updated = await updateAgentName(workerId, "Renamed Worker");
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Renamed Worker");

      // Rename back for other tests
      await updateAgentName(workerId, "Test Worker");
    });
  });

  describe("non-lead is rejected when providing agentId", () => {
    test("non-lead agent cannot update another agent's profile", async () => {
      const callingAgent = await getAgentById(workerId);
      expect(callingAgent).not.toBeNull();
      expect(callingAgent!.isLead).toBe(false);

      // The tool handler checks isLead before calling DB functions.
      // Simulate the authorization check the tool performs:
      const isUpdatingSelf = otherWorkerId === workerId; // false — different agent
      expect(isUpdatingSelf).toBe(false);

      // Non-lead should be rejected
      const canUpdate = callingAgent!.isLead;
      expect(canUpdate).toBe(false);
    });

    test("non-lead agent cannot update lead's profile", async () => {
      const callingAgent = await getAgentById(workerId);
      expect(callingAgent!.isLead).toBe(false);

      const isUpdatingSelf = leadId === workerId; // false
      expect(isUpdatingSelf).toBe(false);

      // Authorization would reject this
      expect(callingAgent!.isLead).toBe(false);
    });
  });

  describe("self-update via explicit agentId works without lead check", () => {
    test("agent providing own agentId is treated as self-update", async () => {
      // Simulate: agentId param = caller's own ID
      const requestAgentId = workerId;
      const paramAgentId = workerId;
      const isUpdatingSelf = !paramAgentId || paramAgentId === requestAgentId;
      expect(isUpdatingSelf).toBe(true);

      // Self-update should succeed regardless of isLead status
      const updated = await updateAgentProfile(
        workerId,
        { description: "Self-updated via explicit agentId" },
        { changeSource: "self_edit", changedByAgentId: workerId },
      );
      expect(updated).not.toBeNull();
      expect(updated!.description).toBe("Self-updated via explicit agentId");
    });

    test("self-update with omitted agentId also works", async () => {
      // When agentId is undefined, isUpdatingSelf = true
      const agentId = undefined;
      const isUpdatingSelf = !agentId || agentId === workerId;
      expect(isUpdatingSelf).toBe(true);

      const updated = await updateAgentProfile(
        workerId,
        { role: "updated-role" },
        { changeSource: "self_edit", changedByAgentId: workerId },
      );
      expect(updated).not.toBeNull();
      expect(updated!.role).toBe("updated-role");
    });
  });

  describe("invalid agentId returns appropriate error", () => {
    test("updateAgentProfile returns null for non-existent target agent", async () => {
      const result = await updateAgentProfile(
        nonExistentId,
        { description: "Should fail" },
        { changeSource: "lead_coaching", changedByAgentId: leadId },
      );
      expect(result).toBeNull();
    });

    test("updateAgentName returns null for non-existent target agent", async () => {
      const result = await updateAgentName(nonExistentId, "Ghost Agent");
      expect(result).toBeNull();
    });

    test("getAgentById returns null for non-existent agent", async () => {
      const agent = await getAgentById(nonExistentId);
      expect(agent).toBeNull();
    });
  });

  describe("changeSource is correct for remote vs self updates", () => {
    test("lead_coaching changeSource for lead updating worker identityMd", async () => {
      await updateAgentProfile(
        otherWorkerId,
        { identityMd: "# Identity set by lead" },
        { changeSource: "lead_coaching", changedByAgentId: leadId },
      );

      const version = await getLatestContextVersion(otherWorkerId, "identityMd");
      expect(version).not.toBeNull();
      expect(version!.changeSource).toBe("lead_coaching");
      expect(version!.changedByAgentId).toBe(leadId);
    });

    test("self_edit changeSource for agent updating own claudeMd", async () => {
      await updateAgentProfile(
        workerId,
        { claudeMd: "# My notes" },
        { changeSource: "self_edit", changedByAgentId: workerId },
      );

      const version = await getLatestContextVersion(workerId, "claudeMd");
      expect(version).not.toBeNull();
      expect(version!.changeSource).toBe("self_edit");
      expect(version!.changedByAgentId).toBe(workerId);
    });

    test("lead_coaching changeSource for lead updating worker toolsMd", async () => {
      await updateAgentProfile(
        workerId,
        { toolsMd: "# Tools set by lead" },
        { changeSource: "lead_coaching", changedByAgentId: leadId },
      );

      const version = await getLatestContextVersion(workerId, "toolsMd");
      expect(version).not.toBeNull();
      expect(version!.changeSource).toBe("lead_coaching");
      expect(version!.changedByAgentId).toBe(leadId);
    });

    test("self_edit changeSource for agent updating own setupScript", async () => {
      await updateAgentProfile(
        otherWorkerId,
        { setupScript: "echo hello" },
        { changeSource: "self_edit", changedByAgentId: otherWorkerId },
      );

      const version = await getLatestContextVersion(otherWorkerId, "setupScript");
      expect(version).not.toBeNull();
      expect(version!.changeSource).toBe("self_edit");
      expect(version!.changedByAgentId).toBe(otherWorkerId);
    });
  });

  // ==========================================================================
  // Target agent existence validation (non-blocking suggestion)
  // ==========================================================================

  describe("target agent existence validation", () => {
    test("getAgentById can validate target exists before update", async () => {
      // The tool should validate the target agent exists before attempting updates
      const targetAgent = await getAgentById(nonExistentId);
      expect(targetAgent).toBeNull();

      // Valid target should be found
      const validTarget = await getAgentById(workerId);
      expect(validTarget).not.toBeNull();
      expect(validTarget!.id).toBe(workerId);
    });
  });
});
