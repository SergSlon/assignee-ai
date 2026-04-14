# Architect Expert Review — commits 08c4cd0..d3504c7

## BLOCKER

**1. Silent NOT_FOUND bug affects more types than just ELBv2** — `apps/cli/src/services/destroy-service.ts` ARN_IDENTIFIED_TYPES

The fix in commit 663471c only added ELBv2 to `ARN_IDENTIFIED_TYPES`. Same pattern affects:

| Type             | Primary ID | extractIdentifier output  | Risk |
| ---------------- | ---------- | ------------------------- | ---- |
| SNS_TOPIC        | TopicArn   | topic-name (last segment) | HIGH |
| ECS_CLUSTER      | Arn        | cluster-name              | HIGH |
| EVENTS_RULE      | Arn        | rule-name or bus/rule     | HIGH |
| SNS_SUBSCRIPTION | Arn        | UUID suffix               | HIGH |

Recommend deriving `ARN_IDENTIFIED_TYPES` declaratively from `RESOURCE_IDENTIFIER_KEYS` where value matches `/Arn$/`, not a hand-maintained set.

## WARNING

**2. `isRetryableCloudFrontS3Error` too loose** — `apps/cli/src/nodes/status-poller.ts`
`lower.includes("does not exist")` is unqualified — matches ANY CCAPI error containing that substring (IAM role, KMS key, etc). Should be scoped with origin/bucket/s3 co-occurrence.

**3. DBSubnetGroup + Subnet same tier (4)** — `apps/cli/src/services/bulk-destroy.ts`
Same-tier parallelism risks DependencyViolation. Move DBSubnetGroup to its own tier between RDS (3) and Subnets (4).

**4. Missing destroy tiers** — ELBv2 TargetGroup/Listener/ListenerRule must precede LoadBalancer. ECS Service must precede Cluster.

**5. CCAPI_TYPE_PATTERN silent drop** — `bulk-destroy.ts` silently drops non-conforming types. Should log at INFO so users see why "AWS::Backup::Recovery-point" wasn't deleted.

**6. Embedded marker regex duplicated** — same regex in `plan-generator.ts` `resolveValue` AND `resolveString`. Extract to shared constant in `marker-tokens.ts`.

**7. Embedded marker regex catastrophic backtracking risk** — `[^\s]*?__` could backtrack on pathological inputs. Consider `[^_\s]*` or anchored alternative.

**8. Dynamic SDK import in hot path** — `await import("@aws-sdk/client-ec2")` inside ALB destroy. Hoist to module-level.

**9. 60s blind sleep fallback for non-ALB LBs** — Regex only matches `app/` (ALB), misses `net/` (NLB), `gwy/` (GWLB). Add variants.

## INFO / OK

- CloudFront retry architecture sound (hard cap 3 retries via retryCount check)
- ALB ENI drain polling is canonical AWS technique
- Destroy tier order mostly correct
- markerRegion() integrates cleanly with existing markers
