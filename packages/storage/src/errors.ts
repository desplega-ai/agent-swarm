/**
 * Engine errors mapped to one set of typed errors. Each engine package maps its
 * driver errors here; callers test `instanceof`, never driver text.
 *
 * `message` keeps the engine's own text so existing API responses that carry it
 * stay unchanged until a product change says otherwise.
 */
export type ConstraintKind = "unique" | "foreignKey" | "check" | "notNull";

export class StorageError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export class ConstraintViolationError extends StorageError {
  constructor(
    readonly kind: ConstraintKind,
    message: string,
    /** Table or constraint the engine named, when it named one. */
    readonly target: string | null,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = "ConstraintViolationError";
  }
}

/** A transaction lost a serialization or deadlock race and may be retried. */
export class SerializationFailureError extends StorageError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "SerializationFailureError";
  }
}

export function isConstraintViolation(
  err: unknown,
  kind?: ConstraintKind,
): err is ConstraintViolationError {
  return err instanceof ConstraintViolationError && (kind === undefined || err.kind === kind);
}
