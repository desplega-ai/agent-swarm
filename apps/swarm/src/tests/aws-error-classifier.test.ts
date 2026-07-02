/**
 * Unit tests for `classifyAwsSdkError` in `src/utils/aws-error-classifier.ts`.
 *
 * Exercises all four error categories and the no-match path.
 */

import { describe, expect, test } from "bun:test";
import { classifyAwsSdkError } from "../utils/aws-error-classifier";

describe("classifyAwsSdkError — aws-auth", () => {
  test("ExpiredTokenException", () => {
    const r = classifyAwsSdkError(
      "ExpiredTokenException: The security token included in the request is expired",
    );
    expect(r).not.toBeNull();
    expect(r!.category).toBe("aws-auth");
    expect(r!.message).toContain("aws sso login");
  });

  test("ExpiredToken (without Exception suffix)", () => {
    const r = classifyAwsSdkError("ExpiredToken: token expired");
    expect(r?.category).toBe("aws-auth");
  });

  test("CredentialsProviderError", () => {
    const r = classifyAwsSdkError("CredentialsProviderError: Could not load credentials");
    expect(r?.category).toBe("aws-auth");
  });

  test("Unable to locate credentials", () => {
    const r = classifyAwsSdkError(
      'Unable to locate credentials. You can configure credentials by running "aws configure".',
    );
    expect(r?.category).toBe("aws-auth");
  });

  test("security token ... expired (lower-case)", () => {
    const r = classifyAwsSdkError("The security token included in the request is expired");
    expect(r?.category).toBe("aws-auth");
  });

  test("InvalidSignatureException", () => {
    const r = classifyAwsSdkError(
      "InvalidSignatureException: The request signature we calculated does not match the signature you provided",
    );
    expect(r?.category).toBe("aws-auth");
  });

  test("UnrecognizedClientException", () => {
    const r = classifyAwsSdkError(
      "UnrecognizedClientException: The security token included in the request is invalid",
    );
    expect(r?.category).toBe("aws-auth");
  });
});

describe("classifyAwsSdkError — aws-throttle", () => {
  test("ThrottlingException", () => {
    const r = classifyAwsSdkError("ThrottlingException: Rate exceeded");
    expect(r?.category).toBe("aws-throttle");
    expect(r!.message).toContain("quota");
  });

  test("TooManyRequestsException", () => {
    const r = classifyAwsSdkError("TooManyRequestsException: Too many requests");
    expect(r?.category).toBe("aws-throttle");
  });

  test("ServiceQuotaExceededException", () => {
    const r = classifyAwsSdkError(
      "ServiceQuotaExceededException: You have exceeded your request quota for this service",
    );
    expect(r?.category).toBe("aws-throttle");
  });

  test("Rate exceeded (standalone phrase)", () => {
    const r = classifyAwsSdkError("Rate exceeded. Reduce your request rate.");
    expect(r?.category).toBe("aws-throttle");
  });
});

describe("classifyAwsSdkError — aws-access", () => {
  test("AccessDeniedException with bedrock:InvokeModel", () => {
    const r = classifyAwsSdkError(
      "AccessDeniedException: User: arn:aws:iam::123:user/dev is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2",
    );
    expect(r?.category).toBe("aws-access");
    expect(r!.message).toContain("bedrock:InvokeModel");
  });

  test("not authorized to perform (phrase match)", () => {
    const r = classifyAwsSdkError("User is not authorized to perform: bedrock:InvokeModel");
    expect(r?.category).toBe("aws-access");
  });
});

describe("classifyAwsSdkError — aws-model", () => {
  test("ValidationException", () => {
    const r = classifyAwsSdkError(
      "ValidationException: Invocation of model ID anthropic.claude-v99 with on-demand throughput isn't supported",
    );
    expect(r?.category).toBe("aws-model");
    expect(r!.message).toContain("MODEL_OVERRIDE");
  });

  test("ResourceNotFoundException", () => {
    const r = classifyAwsSdkError("ResourceNotFoundException: Could not find model");
    expect(r?.category).toBe("aws-model");
  });

  test("ModelTimeoutException", () => {
    const r = classifyAwsSdkError(
      "ModelTimeoutException: The model timed out processing your request",
    );
    expect(r?.category).toBe("aws-model");
  });

  test("ModelNotReadyException", () => {
    const r = classifyAwsSdkError("ModelNotReadyException: The model is not ready for inference");
    expect(r?.category).toBe("aws-model");
  });
});

describe("classifyAwsSdkError — priority ordering", () => {
  test("aws-auth wins over aws-model when both match (ExpiredToken + ValidationException)", () => {
    // Should not happen in practice, but priority must be deterministic
    const r = classifyAwsSdkError("ExpiredTokenException and also ValidationException");
    expect(r?.category).toBe("aws-auth");
  });
});

describe("classifyAwsSdkError — no-match", () => {
  test("returns null for empty string", () => {
    expect(classifyAwsSdkError("")).toBeNull();
  });

  test("returns null for unrelated error", () => {
    expect(classifyAwsSdkError("TypeError: Cannot read property 'foo' of undefined")).toBeNull();
  });

  test("returns null for generic network error", () => {
    expect(classifyAwsSdkError("ECONNREFUSED 127.0.0.1:3013")).toBeNull();
  });

  test("returns null for Claude API error (not AWS)", () => {
    expect(classifyAwsSdkError("401 Unauthorized: Invalid API key")).toBeNull();
  });
});
