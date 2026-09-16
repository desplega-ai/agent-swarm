export class TaskCreationBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly extension: { id: string; name: string },
  ) {
    super(reason);
    this.name = "TaskCreationBlockedError";
  }
}
