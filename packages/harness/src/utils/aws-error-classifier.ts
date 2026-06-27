/**
 * AWS SDK error classifier for the pi-mono/Bedrock path.
 *
 * Provides a single shared matcher (`classifyAwsSdkError`) consumed by:
 *   - `src/providers/pi-mono-adapter.ts`  — emits ProviderEvent {type:'error'} mid-stream
 *   - `src/commands/runner.ts`            — backstop in the no-schema/no-progress branch
 *
 * The regex set lives here exactly once so the two sites never diverge.
 */

export type AwsErrorCategory = "aws-auth" | "aws-throttle" | "aws-access" | "aws-model";

export interface AwsErrorClassification {
  category: AwsErrorCategory;
  /** Human-readable, actionable error message for the session-chat red box and task failureReason. */
  message: string;
}

interface AwsErrorRule {
  patterns: RegExp[];
  category: AwsErrorCategory;
  message: string;
}

/**
 * Priority-ordered rules.  The first matching rule wins, so the most critical
 * category (auth) takes precedence over the more generic ones (model errors).
 */
const AWS_ERROR_RULES: AwsErrorRule[] = [
  {
    // Expired / missing / invalid credentials
    patterns: [
      /ExpiredToken(?:Exception)?/,
      /CredentialsProviderError/,
      /Unable to locate credentials/,
      /security token.*expired/i,
      /expired.*security token/i,
      /InvalidSignatureException/,
      /UnrecognizedClientException/,
    ],
    category: "aws-auth",
    message:
      "AWS credentials have expired or are missing. " +
      "Run `aws sso login` (or refresh your credentials via `aws configure`) and retry.",
  },
  {
    // Rate limits and quota exceeded
    patterns: [
      /ThrottlingException/,
      /TooManyRequestsException/,
      /ServiceQuotaExceededException/,
      /Rate exceeded/,
    ],
    category: "aws-throttle",
    message:
      "AWS Bedrock request was throttled (rate limit or quota exceeded). " +
      "Wait and retry, or request a quota increase in the AWS Service Quotas console.",
  },
  {
    // IAM / authorization denials
    patterns: [/AccessDeniedException/, /not authorized to perform/i],
    category: "aws-access",
    message:
      "AWS authorization denied for Bedrock. " +
      "Verify the IAM role/user has the `bedrock:InvokeModel` permission for the target model ARN and region.",
  },
  {
    // Bad model ID, region mismatch, model not ready
    patterns: [
      /ValidationException/,
      /ResourceNotFoundException/,
      /ModelTimeoutException/,
      /ModelNotReadyException/,
    ],
    category: "aws-model",
    message:
      "AWS Bedrock model error: the model ID may be invalid, unavailable in this region, or not yet ready. " +
      "Verify MODEL_OVERRIDE and the AWS region in your environment.",
  },
];

/**
 * Classify an error message string against known AWS SDK error patterns.
 *
 * Returns the first matching `{category, message}` pair (priority order:
 * aws-auth → aws-throttle → aws-access → aws-model), or `null` if no
 * known AWS SDK signature is found in `text`.
 */
export function classifyAwsSdkError(text: string): AwsErrorClassification | null {
  if (!text) return null;
  for (const rule of AWS_ERROR_RULES) {
    if (rule.patterns.some((re) => re.test(text))) {
      return { category: rule.category, message: rule.message };
    }
  }
  return null;
}
