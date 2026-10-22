export interface SeedManifest {
  user: { id: string; name: string };
  agents: {
    lead: string;
    workerA: string;
    workerB: string;
  };
  tasks: {
    pool: string[];
    inProgress: string;
    completed: string;
    failed: string;
    pendingLead: string;
    offered: string;
    draft: string;
    /** In progress on workerA, for codex-logs.spec.ts only: its logs stay off `inProgress`. */
    codexLogs: string;
  };
  pages: {
    public: { id: string; apiUrl: string };
    authed: { id: string; apiUrl: string };
  };
  session: { id: string };
  /**
   * The sessions v2 chain: a root and a follow-up that `user` requested in the
   * `groupKey` group, shared read-only with `teammate`.
   */
  sessionChain: {
    groupKey: string;
    /** The group as the sidebar names it: the last segment of `groupKey`. */
    groupName: string;
    /** The root's title in the dashboard (its task text). */
    title: string;
    root: string;
    child: string;
    teammate: { id: string; name: string };
  };
  memory: { name: string };
  /** Seeded only when the seed has DB access (a local SUT). */
  workflowRuns?: { foreach: string };
}
