export class IdempotencyError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "IdempotencyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class MissingKeyError extends IdempotencyError {
  constructor(message = "Idempotency-Key header is required") {
    super("missing_key", message, 400);
    this.name = "MissingKeyError";
  }
}

export class InvalidKeyError extends IdempotencyError {
  constructor(message = "Idempotency-Key is invalid") {
    super("invalid_key", message, 400);
    this.name = "InvalidKeyError";
  }
}

export class KeyMismatchError extends IdempotencyError {
  constructor(
    message = "Idempotency-Key was already used with a different request",
  ) {
    super("key_mismatch", message, 422);
    this.name = "KeyMismatchError";
  }
}

export class InProgressError extends IdempotencyError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 1) {
    super(
      "in_progress",
      "A request with this Idempotency-Key is still being processed",
      409,
    );
    this.name = "InProgressError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
