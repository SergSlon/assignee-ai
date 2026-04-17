/**
 * Dedicated unit tests for `createEC2Client` (Story 50-6).
 *
 * `createEC2Client` is the single grep anchor for `new EC2Client(...)`
 * — the whole point of the helper is that any future policy change
 * (user-agent, retry strategy, endpoint override) lives here. These
 * tests pin:
 *
 *   - Returns a real `EC2Client` instance (not a mock, not a proxy).
 *   - Region is passed through verbatim (aws / aws-cn / aws-us-gov regions).
 *   - Credentials provider is passed through verbatim.
 *   - NO module-level caching: two calls with the same config return
 *     DISTINCT client instances (current behaviour — callers own the
 *     lifecycle, pin it so a future cache layer is a conscious change).
 *   - .destroy() is present and callable on the returned client (the
 *     CLI + MCP dispose paths depend on it).
 */
import { describe, it, expect } from "vitest";
import { EC2Client } from "@aws-sdk/client-ec2";
import { createEC2Client } from "./ec2-client-factory.js";

// Static credentials shape matches `AwsCredentialIdentity` from
// @aws-sdk/types (which EC2ClientConfig.credentials accepts directly).
// Avoiding the @aws-sdk/types import keeps this test portable across
// SDK peer-dep choices in the monorepo.
const realCreds = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("createEC2Client", () => {
  it("returns a real EC2Client instance", () => {
    const client = createEC2Client({ region: "us-east-1" });
    expect(client).toBeInstanceOf(EC2Client);
  });

  it("propagates the region verbatim (commercial)", async () => {
    const client = createEC2Client({ region: "us-east-1" });
    expect(await client.config.region()).toBe("us-east-1");
    client.destroy();
  });

  it("propagates the region verbatim (aws-cn)", async () => {
    const client = createEC2Client({ region: "cn-north-1" });
    expect(await client.config.region()).toBe("cn-north-1");
    client.destroy();
  });

  it("propagates the region verbatim (aws-us-gov)", async () => {
    const client = createEC2Client({ region: "us-gov-west-1" });
    expect(await client.config.region()).toBe("us-gov-west-1");
    client.destroy();
  });

  it("accepts an explicit credentials provider and stores it", async () => {
    const client = createEC2Client({
      region: "us-east-1",
      credentials: realCreds,
    });
    // config.credentials is a provider — invoking it returns the
    // original object passed in (the AWS SDK wraps static credentials
    // in a memoized provider).
    const resolved = await client.config.credentials();
    expect(resolved.accessKeyId).toBe(realCreds.accessKeyId);
    expect(resolved.secretAccessKey).toBe(realCreds.secretAccessKey);
    client.destroy();
  });

  it("is NOT a module-level cache — two calls return DISTINCT instances", () => {
    // This is the current documented behaviour: callers own the
    // lifecycle (CLI short-lived, MCP long-lived with manual .destroy()).
    // If we ever switch to pooling by (region, account), this test
    // surfaces that change as a conscious decision.
    const a = createEC2Client({ region: "us-east-1" });
    const b = createEC2Client({ region: "us-east-1" });
    expect(a).not.toBe(b);
    a.destroy();
    b.destroy();
  });

  it("different regions produce different instances", () => {
    const east = createEC2Client({ region: "us-east-1" });
    const west = createEC2Client({ region: "us-west-2" });
    expect(east).not.toBe(west);
    east.destroy();
    west.destroy();
  });

  it("the returned client exposes a callable .destroy() (disposable contract)", () => {
    const client = createEC2Client({ region: "us-east-1" });
    expect(typeof client.destroy).toBe("function");
    // Calling .destroy() is idempotent and must not throw.
    expect(() => client.destroy()).not.toThrow();
    expect(() => client.destroy()).not.toThrow();
  });
});
