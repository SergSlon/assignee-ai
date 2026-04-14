# Security Expert Review — commits 08c4cd0..d3504c7

## HIGH

**1. Hardcoded RDS password default** — `packages/core/src/pattern-templates/patterns/three-tier-web.ts:392`
`MasterUserPassword: "ChangeMe-REPLACE-123!"`. The comment claims the user "MUST override via --set", but nothing enforces this. Recommendation:

- (a) reject apply if value is unchanged from this sentinel, OR
- (b) generate a random password at plan time and surface it as required input

## MEDIUM

**2. RDS snapshot IAM `Resource: *`** — `packages/core/src/config/iam-actions.ts:202-205`
`rds:CreateDBSnapshot`, `DeleteDBSnapshot`, `CopyDBSnapshot` granted unscoped. `DeleteDBSnapshot` on `*` lets a compromised operator wipe ALL account snapshots. Consider tag-based condition (`aws:ResourceTag/assignee-managed`).

## LOW / OK

- RDS correctly in private subnets via DBSubnetGroup, `PubliclyAccessible` defaults to false
- SSH restricted to VPC_CIDR (not 0.0.0.0/0)
- ALB SGs open 80/443 to 0.0.0.0/0 — expected for internet-facing
- DB SG (5432) restricted to VPC_CIDR
- CloudFront OAC lockdown properly hardened (BlockPublicAcls, aws:SourceArn condition, HTTPS-only)
- No command injection surface — all AWS calls via SDK
