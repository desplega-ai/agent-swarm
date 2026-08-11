import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlinkSync } from "node:fs";
import {
  addMeetingContribution,
  cancelMeeting,
  closeDb,
  computeMeetingAttendance,
  concludeMeeting,
  countMeetings,
  createMeeting,
  getMeeting,
  getMeetingDetail,
  initDb,
  listMeetingContributions,
  listMeetings,
  MeetingConclusionError,
} from "../be/db";

const TEST_DB_PATH = "./test-meetings-storage.sqlite";

function makeAgentId() {
  return `agent-${crypto.randomUUID().slice(0, 8)}`;
}

beforeAll(() => {
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("meetings storage + attendance gate", () => {
  test("create → contribute → conclude happy path", () => {
    const creator = makeAgentId();
    const alice = makeAgentId();
    const bob = makeAgentId();

    const meeting = createMeeting({
      agentId: creator,
      title: "Ship it?",
      agenda: "Decide whether to ship the feature.",
      participants: [alice, bob],
    });
    expect(meeting.id).toMatch(/^[0-9a-f]{32}$/);
    expect(meeting.status).toBe("open");
    expect(meeting.participants).toEqual([alice, bob]);

    // Only alice has spoken → attendance gate must block conclusion.
    addMeetingContribution({ meetingId: meeting.id, agentId: alice, content: "I vote ship." });
    expect(() =>
      concludeMeeting({ meetingId: meeting.id, agentId: creator, conclusion: "Ship it." }),
    ).toThrow(MeetingConclusionError);

    const partial = getMeetingDetail(meeting.id);
    expect(partial?.fullyAttended).toBe(false);
    expect(partial?.attendance.find((a) => a.participant === bob)?.present).toBe(false);

    // Bob speaks → gate satisfied.
    addMeetingContribution({ meetingId: meeting.id, agentId: bob, content: "Agreed, ship." });
    const detail = concludeMeeting({
      meetingId: meeting.id,
      agentId: creator,
      conclusion: "Decision: ship Monday. Owner: alice.",
    });
    expect(detail.status).toBe("concluded");
    expect(detail.conclusion).toBe("Decision: ship Monday. Owner: alice.");
    expect(detail.concludedBy).toBe(creator);
    expect(detail.fullyAttended).toBe(true);
    expect(detail.contributions).toHaveLength(2);
  });

  test("empty conclusion is rejected even when fully attended", () => {
    const creator = makeAgentId();
    const solo = makeAgentId();
    const meeting = createMeeting({
      agentId: creator,
      title: "Solo",
      agenda: "x",
      participants: [solo],
    });
    addMeetingContribution({ meetingId: meeting.id, agentId: solo, content: "present" });
    expect(() =>
      concludeMeeting({ meetingId: meeting.id, agentId: creator, conclusion: "   " }),
    ).toThrow(/non-empty conclusion/i);
  });

  test("cannot contribute to a concluded meeting", () => {
    const creator = makeAgentId();
    const p = makeAgentId();
    const meeting = createMeeting({ agentId: creator, title: "T", agenda: "a", participants: [p] });
    addMeetingContribution({ meetingId: meeting.id, agentId: p, content: "hi" });
    concludeMeeting({ meetingId: meeting.id, agentId: creator, conclusion: "done" });
    expect(() =>
      addMeetingContribution({ meetingId: meeting.id, agentId: p, content: "late" }),
    ).toThrow(/concluded/);
  });

  test("observers (non-participants) do not affect attendance", () => {
    const creator = makeAgentId();
    const p = makeAgentId();
    const observer = makeAgentId();
    const meeting = createMeeting({ agentId: creator, title: "T", agenda: "a", participants: [p] });
    addMeetingContribution({ meetingId: meeting.id, agentId: observer, content: "just watching" });
    const detail = getMeetingDetail(meeting.id);
    expect(detail?.fullyAttended).toBe(false); // p still hasn't spoken
    expect(detail?.contributions).toHaveLength(1);
  });

  test("participants are de-duped and trimmed on create", () => {
    const creator = makeAgentId();
    const meeting = createMeeting({
      agentId: creator,
      title: "T",
      agenda: "a",
      participants: [" x ", "x", "y", ""],
    });
    expect(meeting.participants).toEqual(["x", "y"]);
  });

  test("cancel moves an open meeting to cancelled", () => {
    const creator = makeAgentId();
    const meeting = createMeeting({
      agentId: creator,
      title: "T",
      agenda: "a",
      participants: ["z"],
    });
    const cancelled = cancelMeeting(meeting.id);
    expect(cancelled?.status).toBe("cancelled");
    // Contributing to a cancelled meeting is blocked.
    expect(() =>
      addMeetingContribution({ meetingId: meeting.id, agentId: "z", content: "x" }),
    ).toThrow(/cancelled/);
  });

  test("list + count filter by status", () => {
    const creator = makeAgentId();
    const before = countMeetings({ agentId: creator });
    createMeeting({ agentId: creator, title: "A", agenda: "a", participants: ["p"] });
    const m2 = createMeeting({ agentId: creator, title: "B", agenda: "b", participants: ["p"] });
    addMeetingContribution({ meetingId: m2.id, agentId: "p", content: "hi" });
    concludeMeeting({ meetingId: m2.id, agentId: creator, conclusion: "ok" });

    expect(countMeetings({ agentId: creator })).toBe(before + 2);
    const open = listMeetings({ agentId: creator, status: "open" });
    expect(open.every((m) => m.status === "open")).toBe(true);
    const concluded = listMeetings({ agentId: creator, status: "concluded" });
    expect(concluded.map((m) => m.id)).toContain(m2.id);
  });

  test("computeMeetingAttendance counts per participant", () => {
    const { attendance, fullyAttended } = computeMeetingAttendance(
      ["a", "b"],
      [
        { id: "1", meetingId: "m", agentId: "a", round: 1, content: "x", createdAt: "t" },
        { id: "2", meetingId: "m", agentId: "a", round: 1, content: "y", createdAt: "t" },
      ],
    );
    expect(fullyAttended).toBe(false);
    expect(attendance.find((x) => x.participant === "a")?.contributionCount).toBe(2);
    expect(attendance.find((x) => x.participant === "b")?.present).toBe(false);
  });

  test("getMeeting / listMeetingContributions round-trip", () => {
    const creator = makeAgentId();
    const meeting = createMeeting({
      agentId: creator,
      title: "RT",
      agenda: "a",
      participants: ["p"],
    });
    addMeetingContribution({ meetingId: meeting.id, agentId: "p", content: "one", round: 1 });
    addMeetingContribution({ meetingId: meeting.id, agentId: "p", content: "two", round: 2 });
    expect(getMeeting(meeting.id)?.title).toBe("RT");
    const contribs = listMeetingContributions(meeting.id);
    expect(contribs.map((c) => c.content)).toEqual(["one", "two"]);
  });
});
