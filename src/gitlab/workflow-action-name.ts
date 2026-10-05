/** Map GitLab raw webhook actions to the past-tense names documented for workflow waits. */
export function gitlabWorkflowActionName(action: string): string {
  switch (action) {
    case "open":
      return "opened";
    case "close":
      return "closed";
    case "merge":
      return "merged";
    case "reopen":
      return "reopened";
    default:
      return action;
  }
}
