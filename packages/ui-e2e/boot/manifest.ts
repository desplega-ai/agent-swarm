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
  };
  pages: {
    public: { id: string; apiUrl: string };
    authed: { id: string; apiUrl: string };
  };
  session: { id: string };
  memory: { name: string };
}
