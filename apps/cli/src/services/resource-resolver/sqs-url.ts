/**
 * SQS queue URL recognition and parsing.
 *
 * The CloudControl identifier for AWS::SQS::Queue IS the queue URL, so
 * we accept queue URLs as an alternate resolve target alongside ARN /
 * name.
 *
 * @see Story 18.5
 */

/**
 * Checks if a string is an SQS queue URL.
 * Format: https://sqs.{region}.amazonaws.com/{account-id}/{queue-name}
 */
export function isSqsQueueUrl(input: string): boolean {
  return /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d+\/[^/]+$/.test(input);
}

/**
 * Parses an SQS queue URL into its components.
 * @param url - SQS queue URL like https://sqs.us-east-1.amazonaws.com/210987654321/my-queue
 * @returns Parsed components or null if not a valid SQS URL
 */
export function parseSqsQueueUrl(url: string): {
  region: string;
  accountId: string;
  queueName: string;
} | null {
  const match = url.match(
    /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d+)\/([^/]+)$/,
  );
  if (!match) return null;
  return {
    region: match[1]!,
    accountId: match[2]!,
    queueName: match[3]!,
  };
}
