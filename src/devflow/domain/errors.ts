export class DevFlowError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly errorCode: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DevFlowError";
  }
}
