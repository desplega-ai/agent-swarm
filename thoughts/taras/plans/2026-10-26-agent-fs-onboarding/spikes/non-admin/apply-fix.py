#!/usr/bin/env python3
"""Apply the proposed Requester dead-end fixes to a scratch copy (argv[1]). Never run on the real checkout."""
import sys, os
root = sys.argv[1]
def sub(path, old, new):
    p = os.path.join(root, path)
    s = open(p).read()
    assert old in s, (path, old[:60])
    open(p, 'w').write(s.replace(old, new, 1))
t = 'src/http/tasks.ts'
sub(t, '  session: bodyTask("parentTaskId"),\n  summary: "Create a new task",', '  session: bodyTask("parentTaskId"),\n  rbac: { permission: "task.create.own" },\n  summary: "Create a new task",')
sub(t, '  summary: "Cancel a pending or in-progress task",', '  rbac: { permission: "task.cancel.own" },\n  summary: "Cancel a pending or in-progress task",')
sub(t, '  summary: "Pause an in-progress task",', '  rbac: { permission: "task.action.own" },\n  summary: "Pause an in-progress task",')
sub(t, '  summary: "Resume a paused task",', '  rbac: { permission: "task.action.own" },\n  summary: "Resume a paused task",')
sub(t, '  rbac: {\n    ungated: "mirrors the pre-RBAC PATCH /api/tasks/{id}/vcs sibling route: bearer auth only",\n  },', '  rbac: { permission: "task.action.own" },')
c = 'scripts/check-rbac-coverage.ts'
for k in ['POST /api/tasks', 'POST /api/tasks/{id}/cancel', 'POST /api/tasks/{id}/pause', 'POST /api/tasks/{id}/resume', 'PATCH /api/inbox-state']:
    sub(c, '  "%s": BACKLOG_REASON,\n' % k, '')
r = 'src/be/rbac-roles.ts'
sub(r, '      "favorite.write.own",\n      "session.share",\n      "session.presence",\n    ],', '      "favorite.write.own",\n      "session.share",\n      "session.presence",\n      "task.steer.own",\n      "comb.presence",\n    ],')
sub(r, 'verbs: ["favorite.write.own", "session.presence"],', 'verbs: ["favorite.write.own", "session.presence", "comb.presence"],')
s = 'src/http/sessions.ts'
sub(s, '  rbac: { ungated: "per-user inbox UI state, same posture as PATCH /api/inbox-state" },', '  rbac: { permission: "favorite.write.own" },')
sub(s, 'const sessionMoveRbac = {\n  ungated:\n    "per-session access, per-task task.fs.mutate, and asset-key write checks in the handler, as PATCH /api/assets/task/{id}/key",\n};', 'const sessionMoveRbac = { permission: "task.fs.mutate" } as const;')
i = 'src/http/inbox-state.ts'
sub(i, '  rbac: { ungated: "per-user inbox UI state, same posture as PATCH /api/inbox-state" },', '  rbac: { permission: "favorite.write.own" },')
sub(i, '    401: { description: "Unauthorized" },\n  },\n  auth: { apiKey: true },\n});\n\nconst bulkUpsertState', '    401: { description: "Unauthorized" },\n  },\n  auth: { apiKey: true },\n  rbac: { permission: "favorite.write.own" },\n});\n\nconst bulkUpsertState')
sub('src/http/telemetry-ui.ts' if False else 'src/http/telemetry-ui.ts', 'rbac: { ungated: "any authenticated dashboard user; event name allowlisted" },', 'rbac: { permission: "favorite.write.own" },')
print("applied")
