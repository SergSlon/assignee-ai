# BP engine vs AWS Guard Rules Registry — gap analysis

> 2026-04-08 — rule-by-rule diff of our 132-rule best-practices YAML set
> against the 209-rule AWS Guard Rules Registry
> (`github.com/aws-cloudformation/aws-guard-rules-registry`).
>
> **Output:** a 32-rule work-list, ranked by security value and feasibility,
> for the **A5 BP expansion** epic from the sprint plan. Each gap rule is
> authorable in our existing YAML format with `severity` / `category` /
> `propertyPath` / `autoFixable` / `desiredStatePatch` retained, and
> enforceable at plan time against the structured `desiredState` JSON —
> no new engine work needed.
>
> **Scope note:** this is a capability diff, not an adoption recommendation.
> Per `docs/iac-mcp-evaluation.md`, we declined to adopt the AWS Labs IaC
> MCP server that wraps cfn-guard itself. This memo extracts the _rule
> content_ from the Guard Rules Registry (which lives in its own open-
> source repo) and ports the high-value gaps into our format, keeping
> plan-time enforcement + autoFixable patches + structured `propertyPath`.

## Inventory summary

| Side                     | Count                                     | Source                                                                       |
| ------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------- |
| Our BP rules             | **132** YAML files across 19 services     | `packages/best-practices/*/BP-*.yaml`                                        |
| AWS Guard Rules Registry | **209** `.guard` files across 46 services | `github.com/aws-cloudformation/aws-guard-rules-registry/tree/main/rules/aws` |

Our coverage is concentrated in the services we actually provision
(EC2/S3/RDS/Lambda/IAM/ECS/SQS/SNS/SecretsManager/DynamoDB/ELBv2/
APIGateway/CloudWatch/Logs/ECR/VPC/SG/IGW/RouteTable/Subnet/NatGateway/
AutoScaling/SSM). Guard covers many more AWS services (OpenSearch,
Redshift, SageMaker, EMR, EKS, CloudFront, CloudTrail, Kinesis, KMS,
WAF, etc.) — **those are out of scope** because we don't provision
them and don't plan to before Phase 3.

## Overlap matrix (services we cover, with counts)

| Service                              | Ours | Guard           | Coverage verdict                                                                                                                                      |
| ------------------------------------ | ---- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| EC2 (instances, SGs, volumes, NACLs) | 20   | 23              | **~even** — our coverage is broader on cost + rightsizing, Guard's is broader on NACLs which we don't provision                                       |
| IAM                                  | 10   | 20              | **major gap** — Guard's policy-document anti-pattern rules (wildcards, NotAction, NotPrincipal) are entirely absent from our set                      |
| S3                                   | 14   | 17              | **small gap** — our PAB/encryption/versioning coverage is complete; Guard adds 3 bucket policy anti-pattern rules we miss                             |
| RDS                                  | 13   | 12              | **we win** — Aurora backtracking is the only Guard rule we don't have, and it's niche                                                                 |
| Lambda                               | 10   | 6               | **we win** — our runtime/memory/arm64/codesign coverage is broader; Guard adds 2 `AWS::Lambda::Permission` checks we miss                             |
| ECS                                  | 9    | 1               | **we win** — Guard only has host-mode-user check                                                                                                      |
| SQS                                  | 5    | 5               | **gap** — our rules are transport/reliability; Guard's are all policy anti-patterns. Near-zero overlap.                                               |
| SecretsManager                       | 5    | 2               | **we win** — rotation + KMS are covered by both; our DynamicReference + plaintext rules go further                                                    |
| DynamoDB                             | 5    | 8               | **small gap** — Guard adds backup-plan coverage rules                                                                                                 |
| ELBv2                                | 3    | 8               | **major gap** — we have deletion-protection/access-logs/invalid-headers; Guard adds HTTP→HTTPS redirect, WAF, ACM cert, SSL policy, listener protocol |
| API Gateway                          | 3    | 6+2             | **moderate gap** — we have access logs + CORS + auth; Guard adds cache encryption, endpoint type, execution logging, custom domain TLS                |
| SNS                                  | 4    | 4               | **small gap** — our rules are encryption + delivery + access; Guard adds 2 policy anti-pattern rules                                                  |
| CloudWatch Alarm                     | 5    | 1               | **we win** (we check actions, evaluation periods, treatMissingData)                                                                                   |
| CloudWatch Logs                      | 3    | 2               | **we win**                                                                                                                                            |
| ECR                                  | 3    | 1               | **we win**                                                                                                                                            |
| AutoScaling                          | 1    | 2               | **gap** — we only check MaxSize; Guard adds ELB healthcheck + no-public-IP on launch config                                                           |
| VPC / IGW / RT / Subnet / NAT / SG   | 16   | (in amazon_ec2) | **we win** — Guard's EC2 folder has SG rules we already cover                                                                                         |

## Services Guard covers that we don't provision (out of scope)

CloudFront (9), OpenSearch (17), Redshift (6), SageMaker (3), EMR (3),
Cognito (2), FSx (1), EKS (2), EFS (2, this would apply **if we land
A1 EFS**), MQ (2), IoT (2), Kinesis (4), KMS (3), CloudTrail (6),
Backup (1), Batch (1), ACM (1), DLM (1), DMS (2), ElastiCache (2),
Elastic Beanstalk (2), CodeBuild (3), DAX (1), WAF (1+1), Workspaces
(1), GameLift (1), Kendra (1), Microsoft AD (1), all_resources (1).

**Note:** `amazon_efs` has 2 rules (`efs_encrypted_check`,
`efs_resources_protected_by_backup_plan`) — these should be **carried
into A1 EFS resource-type expansion** as BP-EFS-001 / BP-EFS-002 when
that epic lands.

## The 32-rule gap work-list (ranked by value)

Each entry is a concrete BP YAML file to author, in the same format
as an existing rule (see `packages/best-practices/s3/BP-S3-001.yaml`).

### Tier 1 — IAM policy-document anti-patterns (7 rules) — **HIGHEST VALUE**

These are the archetypal privilege-escalation rules and are all
statically inspectable on the structured policy document we already
generate. A shared helper (`inspectPolicyDocument(doc, rule)`) can back
all of them.

| New BP ID      | Title                                                              | Guard source rule                                                                           | Why it matters                                                                                                                                     |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BP-IAM-011** | IAM policy must not grant wildcard `Resource: *`                   | `iam_policydocument_no_wildcard_resource`                                                   | The classic least-privilege violation. Plan-time catchable.                                                                                        |
| **BP-IAM-012** | IAM `PassRole` permission must not use wildcard resource           | `iam_policy_no_wildcard_resource_on_passrole` + `iam_role_no_wildcard_resource_on_passrole` | Direct privilege-escalation vector (assume any role).                                                                                              |
| **BP-IAM-013** | IAM policy must not use `Allow` + `NotAction`                      | `iam_role_or_policy_no_allow_plus_not_action`                                               | The "deny all but X" anti-pattern silently grants new AWS services as AWS adds them.                                                               |
| **BP-IAM-014** | IAM policy must not use `Allow` + `NotResource`                    | `iam_role_or_policy_no_allow_plus_not_resource`                                             | Same shape as BP-IAM-013 but for resources.                                                                                                        |
| **BP-IAM-015** | IAM role trust policy must not use `Allow` + `NotPrincipal`        | `iam_role_no_allow_plus_not_principal`                                                      | Inverts trust — anyone except N can assume. Catastrophic on a role with real permissions.                                                          |
| **BP-IAM-016** | IAM role must not attach `AdministratorAccess` managed policy      | `iam_role_administrator_access_policy_rule`                                                 | Explicit admin check; we already have a "no full admin privileges" rule but it inspects the policy document, not the attached-managed-policy list. |
| **BP-IAM-017** | IAM role must not attach `*FullAccess` managed policies unreviewed | `iam_role_elevated_managed_policy_rule`                                                     | Heuristic check for broad managed policies.                                                                                                        |

**Effort:** ~1 day for the shared helper + 7 YAML files + tests.

### Tier 2 — ELBv2 HTTPS hygiene (5 rules) — **HIGH VALUE**

Straightforward property checks on `AWS::ElasticLoadBalancingV2::
Listener` and `AWS::ElasticLoadBalancingV2::LoadBalancer`.

| New BP ID      | Title                                                | Guard source                          | autoFixable?                                                 |
| -------------- | ---------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| **BP-ELB-004** | ALB HTTP listener must redirect to HTTPS             | `alb_http_to_https_redirection_check` | Yes — emit a `RedirectConfig` default action                 |
| **BP-ELB-005** | HTTPS listener must reference an ACM certificate     | `elbv2_acm_certificate_required`      | No (requires a real cert ARN)                                |
| **BP-ELB-006** | HTTPS listener SSL policy must be modern (TLS 1.2+)  | `elbv2_listener_ssl_policy_rule`      | Yes — patch `SslPolicy: ELBSecurityPolicy-TLS13-1-2-2021-06` |
| **BP-ELB-007** | Internet-facing ALB listener must not use plain HTTP | `elbv2_listener_protocol_rule`        | No (user intent decision)                                    |
| **BP-ELB-008** | ALB should be associated with a WAFv2 WebACL         | `alb_waf_enabled`                     | No (requires WAF resource)                                   |

**Effort:** ~½ day. No shared helper needed.

### Tier 3 — Policy anti-patterns on S3 / SQS / SNS (9 rules) — **HIGH VALUE**

Reuses the Tier-1 shared `inspectPolicyDocument()` helper — same
wildcard/NotAction/NotPrincipal patterns on different resource types.

| New BP ID      | Target resource                                       | Source Guard rule                            |
| -------------- | ----------------------------------------------------- | -------------------------------------------- |
| **BP-S3-015**  | `BucketPolicy.PolicyDocument` wildcard `Action: *`    | `s3_bucket_policy_no_wildcard_action`        |
| **BP-S3-016**  | `BucketPolicy.PolicyDocument` wildcard `Principal: *` | `s3_bucket_policy_no_wildcard_principal`     |
| **BP-S3-017**  | `BucketPolicy.PolicyDocument` `Allow` + `NotAction`   | `s3_bucket_policy_no_allow_plus_not_action`  |
| **BP-SQS-006** | `QueuePolicy.PolicyDocument` wildcard `Action: *`     | `sqs_queuepolicy_no_wildcard_action`         |
| **BP-SQS-007** | `QueuePolicy.PolicyDocument` wildcard `Principal: *`  | `sqs_queuepolicy_no_wildcard_principal`      |
| **BP-SQS-008** | `QueuePolicy.PolicyDocument` `Allow` + `NotAction`    | `sqs_queuepolicy_no_allow_plus_not_action`   |
| **BP-SQS-009** | `QueuePolicy.PolicyDocument` `Allow` + `NotPrincipal` | `sqs_queuepolicy_no_allow_plus_notprincipal` |
| **BP-SNS-005** | `TopicPolicy.PolicyDocument` `Allow` + `NotAction`    | `sns_topicpolicy_no_allow_plus_not_action`   |
| **BP-SNS-006** | `TopicPolicy.PolicyDocument` `Allow` + `NotPrincipal` | `sns_topicpolicy_no_allow_plus_notprincipal` |

**Effort:** ~½ day assuming the shared helper exists from Tier 1.

### Tier 4 — API Gateway / Lambda permission hygiene (5 rules)

| New BP ID         | Title                                                   | Source Guard rule                                                           |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| **BP-APIGW-004**  | REST API method cache must be encrypted                 | `api_gw_cache_enabled_and_encrypted`                                        |
| **BP-APIGW-005**  | REST API execution logging must be enabled              | `api_gw_execution_logging_enabled`                                          |
| **BP-APIGW-006**  | REST API custom domain must deny non-TLS traffic        | `api_gw_domain_deny_non_tls_traffic`                                        |
| **BP-LAMBDA-011** | `AWS::Lambda::Permission` must not grant `Principal: *` | `lambda_function_public_access_prohibited` + `lambda_no_wildcard_principal` |
| **BP-LAMBDA-012** | `AWS::Lambda::Permission.Action` must not be `lambda:*` | `lambda_permission_invoke_function_action`                                  |

**Effort:** ~½ day.

### Tier 5 — AutoScaling + DynamoDB (3 rules)

| New BP ID           | Title                                                                           | Source Guard rule                              | Notes                                                                                              |
| ------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **BP-ASG-002**      | Auto Scaling Group must use `ELB` health check when attached to a load balancer | `autoscaling_group_elb_healthcheck_required`   | Default `HealthCheckType: ELB`, autoFixable                                                        |
| **BP-ASG-003**      | Launch configuration / template must not assign public IPs                      | `autoscaling_launch_config_public_ip_disabled` | autoFixable patch                                                                                  |
| **BP-DYNAMODB-006** | DynamoDB table should have backup plan or PITR                                  | `dynamodb_resources_protected_by_backup_plan`  | Partial overlap with existing BP-DYNAMODB-001 (PITR); expand to also accept backup plan membership |

**Effort:** ~¼ day.

### Tier 6 — carried forward to A1 EFS epic (2 rules)

| New BP ID      | Title                                                | Source Guard rule                        | Blocker                               |
| -------------- | ---------------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| **BP-EFS-001** | EFS file system must be encrypted at rest            | `efs_encrypted_check`                    | Awaits A1 EFS resource-type expansion |
| **BP-EFS-002** | EFS file system should be protected by a backup plan | `efs_resources_protected_by_backup_plan` | Awaits A1 EFS resource-type expansion |

These are **not** in the A5 expansion work-list — they ship with the
A1 plugin so the rules and the resource type land in the same PR.

## What we intentionally skip

| Guard rule                                                            | Why skip                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aurora_mysql_backtracking_enabled`                                   | Aurora-only, niche feature. Low value for our user base.                                                                                           |
| `ec2_network_acl_*` (4 rules)                                         | We don't provision NACLs as a primary type.                                                                                                        |
| `restricted_common_ports` / `restricted_ssh`                          | Covered by existing BP-SG-002 (SSH) and BP-SG-005 (high-risk ports); Guard's port list is more comprehensive but our matching logic is equivalent. |
| `ec2_instance_profile_attached`                                       | Covered by BP-EC2-004.                                                                                                                             |
| `secretsmanager_rotation_enabled_check`                               | Covered by BP-SM-003 / BP-SM-005.                                                                                                                  |
| `cw_loggroup_retention_period_check`                                  | Covered by BP-LOGS-001.                                                                                                                            |
| `ecr_repo_scan_on_push_rule`                                          | Covered by BP-ECR-001.                                                                                                                             |
| `sns_topicpolicy_no_wildcard_principal`                               | Covered by BP-SNS-004 (no public access).                                                                                                          |
| All services we don't provision (CloudFront, OpenSearch, Redshift, …) | Out of scope for CLI phase.                                                                                                                        |

## Shared infrastructure — `inspectPolicyDocument()` helper

Tiers 1 and 3 together are **16 rules** that all follow the same
pattern: walk a `PolicyDocument` (CloudFormation JSON form) and
check for wildcard Action, wildcard Principal, wildcard Resource,
Allow + NotAction, Allow + NotPrincipal, Allow + NotResource.

Authoring 16 hand-written checks would be repetitive and drift-prone.
A single helper in `packages/best-practices/src/policy-inspector.ts`
(new file) exposing:

```ts
export type PolicyAntiPattern =
  | "wildcard-action"
  | "wildcard-principal"
  | "wildcard-resource"
  | "allow-plus-not-action"
  | "allow-plus-not-principal"
  | "allow-plus-not-resource";

export function inspectPolicyDocument(
  doc: unknown,
  pattern: PolicyAntiPattern,
): { matched: boolean; offendingStatementIndex?: number };
```

…lets each of the 16 YAML rules reference a `check_type:
"policy-antipattern"` with a `pattern:` field rather than embedding
bespoke expected-value logic. This also sets up A5 to ship additional
policy-antipattern rules for future resource types (KMS, EFS, etc.)
for free.

**Recommendation:** build the helper first, then author the 16 rules
against it in a single coherent PR.

## Proposed A5 sprint breakdown

| Phase    | Scope                                                                                                                             | Effort |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **A5.1** | `policy-inspector.ts` helper + its tests (positive + negative cases for all 6 anti-patterns)                                      | ½ day  |
| **A5.2** | Tier 1 IAM rules (BP-IAM-011 to BP-IAM-017) — 7 rules against the helper                                                          | 1 day  |
| **A5.3** | Tier 3 S3/SQS/SNS policy rules (BP-S3-015/016/017, BP-SQS-006/007/008/009, BP-SNS-005/006) — 9 rules against the helper           | ½ day  |
| **A5.4** | Tier 2 ELBv2 HTTPS hygiene (BP-ELB-004 to BP-ELB-008) — 5 rules                                                                   | ½ day  |
| **A5.5** | Tier 4 API Gateway / Lambda permission (BP-APIGW-004/005/006, BP-LAMBDA-011/012) — 5 rules                                        | ½ day  |
| **A5.6** | Tier 5 AutoScaling / DynamoDB (BP-ASG-002/003, BP-DYNAMODB-006) — 3 rules                                                         | ¼ day  |
| **A5.7** | Regenerate `manifest.json` + hash, run `pnpm build && pnpm lint && pnpm test` CI gate, update `docs/best-practices.md` rule count | ¼ day  |

**Total: ~3.5 engineering days**, delivers **30 new rules**, lifts
coverage from 132 → 162, and **closes the cfn-guard overlap gap** for
the services we actually provision.

Tier 6 (EFS) is deliberately excluded — it ships with the A1 epic to
keep the resource type + its rules in a single coherent change.

## Follow-up: update project memory

After A5 ships, update `project_assignee_ai.md`:

- `BP rules: 136+` → `BP rules: 162` (or whatever the post-A5 count is)
- Add a one-line note that the cfn-guard overlap gap is closed + this
  memo is the historical record.

## Related documents

- `docs/iac-mcp-evaluation.md` — the upstream decision to skip
  `awslabs.aws-iac-mcp-server` adoption. This gap analysis is the
  independent follow-up from that memo's "concrete follow-ups" section.
- `packages/best-practices/src/integrity.ts` — `computeManifest()` /
  `verifyManifest()`, which A5.7 will need to re-run to include the
  new YAML files in the integrity hash.
- `feedback_excellence_bar.md` — the standard this expansion pushes
  toward: "Tests are the floor; CLI must be excellent across every
  command for every supported resource before release/SaaS."
