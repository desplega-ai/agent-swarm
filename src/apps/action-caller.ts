export type AppActionCaller = {
  kind: "user" | "agent" | "operator" | "guest";
  id: string | null;
  name?: string;
  pageId?: string;
};
