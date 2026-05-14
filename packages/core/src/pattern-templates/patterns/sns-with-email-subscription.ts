import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { markerRef } from "../../config/marker-tokens.js";
import type { ArchitecturePattern } from "../types.js";
import { SnsWithEmailSubscriptionResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

/**
 * SNS Topic + Email Subscription compound.
 *
 * Routes intents that mention "with email subscription to <email>" or
 * "with subscriber <email>". The email address is extracted by
 * `email-extractor.ts` and injected into the Subscription's Endpoint
 * field via the `extractAssertedValues` pathway (the extractor writes
 * `__snsSubscriptionEndpoint` into `elicited`; the plan-generator
 * reads it when resourceType is SNS_SUBSCRIPTION).
 *
 * TopicArn on the Subscription is wired via markerRef(TOPIC) so it
 * resolves to the topic ARN returned by CCAPI after the topic lands.
 *
 * Dependency order:
 *   1. sns-topic   — AWS::SNS::Topic (must exist before Subscription)
 *   2. sns-sub     — AWS::SNS::Subscription (TopicArn refs the topic)
 */
export const snsWithEmailSubscriptionPattern: ArchitecturePattern = {
  patternId: PatternId.SNS_WITH_EMAIL_SUBSCRIPTION,
  displayName: "SNS Topic with Email Subscription",
  keywords: [
    "with email subscription",
    "with subscriber",
    "sns email",
    "sns with email",
    "sns topic email",
    "topic with email subscription",
    "topic with subscriber",
  ],
  negativeKeywords: [
    // Prevent collision with message-processing compound (SQS+Lambda pipeline)
    "lambda",
    "sqs",
    "queue",
    "message processing",
    // Bare HTTP/HTTPS/SQS/Lambda/ARN-targeted subscriptions are single-resource
    // SNS_SUBSCRIPTION intents, not email compound intents.
    "http://",
    "https://",
    "arn:aws:sns",
  ],
  resourceList: [
    {
      resourceType: RESOURCE_TYPES.SNS_TOPIC,
      resourceId: R.TOPIC,
      displayName: "SNS Topic",
    },
    {
      resourceType: RESOURCE_TYPES.SNS_SUBSCRIPTION,
      resourceId: R.SUBSCRIPTION,
      displayName: "Email Subscription",
    },
  ],
  dependencyOrder: [
    // Topic must be created first — Subscription's TopicArn references it.
    [R.TOPIC],
    [R.SUBSCRIPTION],
  ],
  defaultOptions: {
    [R.TOPIC]: {},
    [R.SUBSCRIPTION]: {
      Protocol: "email",
      // TopicArn resolves to the SNS topic ARN via markerRef at apply time.
      TopicArn: markerRef(R.TOPIC),
      // Endpoint is populated at plan time by extractEmail() → elicitedOptions.
      // The plan-generator copies elicitedOptions[Endpoint] into desiredState
      // for the SNS_SUBSCRIPTION resource. If no valid email was extracted, the
      // bare SNS path is used instead (see intent-parser/index.ts).
    },
  },
};
