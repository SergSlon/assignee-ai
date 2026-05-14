/**
 * Tests for the sns-with-email-subscription compound pattern (CP-2 / PH1-C-2).
 *
 * 6-variation probe plan from the story spec:
 *   A — "with email subscription to <email>"
 *   B — multi-segment / plus-local email (liamin.web@gmail.com)
 *   C — invalid email token → fallback to bare SNS + advisory
 *   D — multiple emails → emit only first + advisory per extra (pick-first-and-advise)
 *   E — explicit topic name + email → TopicName=genai-events AND Subscription wired
 *   F — bare SNS topic → single resource, no Subscription regression
 *
 * Variation D decision: pick-first-and-advise. AWS::SNS::Subscription is 1:1;
 * silently spawning N resources from one intent is worse UX than a clear advisory.
 */

import { describe, it, expect } from "vitest";
import { snsWithEmailSubscriptionPattern } from "./sns-with-email-subscription.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { PatternId } from "../pattern-ids.js";
import { SnsWithEmailSubscriptionResourceId as R } from "../pattern-resource-ids.js";
import { defaultPatternRegistry } from "../index.js";
import { extractAssertedValues } from "../../graph/nodes/intent-parser/index.js";

// ── Pattern shape ─────────────────────────────────────────────────────────────

describe("snsWithEmailSubscriptionPattern shape", () => {
  it("has the correct patternId", () => {
    expect(snsWithEmailSubscriptionPattern.patternId).toBe(
      PatternId.SNS_WITH_EMAIL_SUBSCRIPTION,
    );
  });

  it("has exactly 2 resources", () => {
    expect(snsWithEmailSubscriptionPattern.resourceList).toHaveLength(2);
  });

  it("first resource is SNS::Topic", () => {
    const first = snsWithEmailSubscriptionPattern.resourceList[0];
    expect(first?.resourceType).toBe(RESOURCE_TYPES.SNS_TOPIC);
    expect(first?.resourceId).toBe(R.TOPIC);
  });

  it("second resource is SNS::Subscription", () => {
    const second = snsWithEmailSubscriptionPattern.resourceList[1];
    expect(second?.resourceType).toBe(RESOURCE_TYPES.SNS_SUBSCRIPTION);
    expect(second?.resourceId).toBe(R.SUBSCRIPTION);
  });

  it("dependencyOrder has topic before subscription", () => {
    expect(snsWithEmailSubscriptionPattern.dependencyOrder).toEqual([
      [R.TOPIC],
      [R.SUBSCRIPTION],
    ]);
  });

  it("Subscription defaultOptions has Protocol=email and markerRef TopicArn", () => {
    const subDefaults = snsWithEmailSubscriptionPattern.defaultOptions[
      R.SUBSCRIPTION
    ] as Record<string, unknown>;
    expect(subDefaults["Protocol"]).toBe("email");
    // TopicArn should be a markerRef string referencing the topic slot
    expect(typeof subDefaults["TopicArn"]).toBe("string");
    expect(String(subDefaults["TopicArn"])).toContain(R.TOPIC);
  });
});

// ── Registry detection ────────────────────────────────────────────────────────

describe("pattern detection (Variation A-F)", () => {
  it("Variation A: detects 'with email subscription to' phrase", () => {
    const pattern = defaultPatternRegistry.detect(
      "Create an SNS topic with email subscription to alice@example.com",
    );
    expect(pattern?.patternId).toBe(PatternId.SNS_WITH_EMAIL_SUBSCRIPTION);
  });

  it("Variation B: detects 'with subscriber' phrase (multi-segment email)", () => {
    const pattern = defaultPatternRegistry.detect(
      "SNS topic with subscriber liamin.web@gmail.com",
    );
    expect(pattern?.patternId).toBe(PatternId.SNS_WITH_EMAIL_SUBSCRIPTION);
  });

  it("Variation C: detects 'with email subscription to' even with invalid email token", () => {
    // The pattern keyword still matches; the email fallback is handled at extraction.
    const pattern = defaultPatternRegistry.detect(
      "Create an SNS topic with email subscription to notanemail",
    );
    expect(pattern?.patternId).toBe(PatternId.SNS_WITH_EMAIL_SUBSCRIPTION);
  });

  it("Variation D: detects pattern when multiple emails are present", () => {
    const pattern = defaultPatternRegistry.detect(
      "SNS topic with email subscriptions to alice@a.com and bob@b.com",
    );
    expect(pattern?.patternId).toBe(PatternId.SNS_WITH_EMAIL_SUBSCRIPTION);
  });

  it("Variation E: detects pattern for intent with topic name + email", () => {
    const pattern = defaultPatternRegistry.detect(
      "SNS topic genai-events with email subscription to liamin.web@gmail.com",
    );
    expect(pattern?.patternId).toBe(PatternId.SNS_WITH_EMAIL_SUBSCRIPTION);
  });

  it("Variation F: bare SNS topic does NOT match this pattern", () => {
    const pattern = defaultPatternRegistry.detect("Create an SNS topic");
    expect(pattern?.patternId).not.toBe(PatternId.SNS_WITH_EMAIL_SUBSCRIPTION);
  });

  it("negative: SQS/Lambda intents do not match this pattern", () => {
    const pattern = defaultPatternRegistry.detect(
      "Create an SNS topic with lambda subscriber",
    );
    expect(pattern?.patternId).not.toBe(PatternId.SNS_WITH_EMAIL_SUBSCRIPTION);
  });
});

// ── extractAssertedValues integration ────────────────────────────────────────

describe("extractAssertedValues for SNS_WITH_EMAIL_SUBSCRIPTION (primary=SNS_TOPIC)", () => {
  it("Variation A: extracts Endpoint from 'with email subscription to'", () => {
    const result = extractAssertedValues(
      "Create an SNS topic with email subscription to alice@example.com",
      RESOURCE_TYPES.SNS_TOPIC,
    );
    expect(result.elicited["Endpoint"]).toBe("alice@example.com");
    expect(result.errors).toHaveLength(0);
  });

  it("Variation B: extracts multi-segment email (dot + gmail domain)", () => {
    const result = extractAssertedValues(
      "SNS topic with subscriber liamin.web@gmail.com",
      RESOURCE_TYPES.SNS_TOPIC,
    );
    expect(result.elicited["Endpoint"]).toBe("liamin.web@gmail.com");
  });

  it("Variation C: invalid email produces advisory, no Endpoint", () => {
    const result = extractAssertedValues(
      "Create an SNS topic with email subscription to notanemail",
      RESOURCE_TYPES.SNS_TOPIC,
    );
    expect(result.elicited["Endpoint"]).toBeUndefined();
    expect(result.errors).toHaveLength(0);
    // Advisory should mention the invalid token
    const advisory = result.advisories.find(
      (a) => a.code === "SNS_INVALID_EMAIL",
    );
    expect(advisory).toBeDefined();
    expect(advisory?.message).toContain("invalid");
  });

  it("Variation D: multiple emails — picks first, emits advisory per extra (pick-first-and-advise)", () => {
    const result = extractAssertedValues(
      "SNS topic with email subscriptions to alice@a.com and bob@b.com",
      RESOURCE_TYPES.SNS_TOPIC,
    );
    // Only the first email is provisioned
    expect(result.elicited["Endpoint"]).toBe("alice@a.com");
    // Advisory for the extra subscriber
    const advisory = result.advisories.find(
      (a) => a.code === "SNS_EXTRA_SUBSCRIBER",
    );
    expect(advisory).toBeDefined();
    expect(advisory?.message).toContain("bob@b.com");
  });

  it("Variation E: inline topic name + email → TopicName AND Endpoint both set", () => {
    const result = extractAssertedValues(
      "SNS topic genai-events with email subscription to liamin.web@gmail.com",
      RESOURCE_TYPES.SNS_TOPIC,
    );
    expect(result.elicited["Endpoint"]).toBe("liamin.web@gmail.com");
    // SX-2 inline-name extractor fires on "genai-events" token
    expect(result.elicited["TopicName"]).toBe("genai-events");
  });

  it("Variation F: bare SNS topic — no email phrase — no Endpoint extracted", () => {
    const result = extractAssertedValues(
      "Create an SNS topic",
      RESOURCE_TYPES.SNS_TOPIC,
    );
    expect(result.elicited["Endpoint"]).toBeUndefined();
    expect(
      result.advisories.filter((a) => a.code === "SNS_INVALID_EMAIL"),
    ).toHaveLength(0);
  });
});
