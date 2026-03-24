# Auto-Fix Patterns Guide

Reference guide for annotating BP rules with `autoFixable`, `desiredStatePatch`, and `fixType`.

## Classification

### Type A — Auto-fixable (`fixType: "auto"`)

- Single property set/change
- No resource recreation required
- No dependencies on other resources

**Criteria:** `autoFixable: true` + `desiredStatePatch` required.

### Type B — Interactive (`fixType: "interactive"`)

- Requires user input (CIDR range, retention period, etc.)
- Multiple valid options exist

**Criteria:** `interactiveOptions` array with `label`, `action`, and optional `targetField`.

### Manual Only

- Requires resource recreation
- Complex multi-step remediation
- Architecture-level changes

**Criteria:** No `fixType`, `autoFixable`, or `desiredStatePatch`.

## Common Patterns by Service

### S3

```yaml
# Enable encryption
desiredStatePatch:
  ServerSideEncryptionConfiguration:
    Rules:
      - ServerSideEncryptionByDefault:
          SSEAlgorithm: "aws:kms"

# Block public access
desiredStatePatch:
  PublicAccessBlockConfiguration:
    BlockPublicAcls: true
    IgnorePublicAcls: true
    BlockPublicPolicy: true
    RestrictPublicBuckets: true
```

### EC2

```yaml
# Enforce IMDSv2
desiredStatePatch:
  MetadataOptions:
    HttpTokens: "required"
    HttpPutResponseHopLimit: 1

# Enable EBS optimization
desiredStatePatch:
  EbsOptimized: true
```

### RDS

```yaml
# Enable Multi-AZ (add cost warning in remediation)
desiredStatePatch:
  MultiAZ: true

# Enable IAM auth
desiredStatePatch:
  EnableIAMDatabaseAuthentication: true
```

### DynamoDB

```yaml
# Enable deletion protection
desiredStatePatch:
  DeletionProtectionEnabled: true

# Enable PITR
desiredStatePatch:
  PointInTimeRecoverySpecification:
    PointInTimeRecoveryEnabled: true
```

## Not Auto-Fixable Examples

| Pattern                      | Why                                           |
| ---------------------------- | --------------------------------------------- |
| Switch SSM to SecureString   | Requires parameter deletion + recreation      |
| VPC Flow Logs                | Creates a new resource, not a property change |
| Restrict Security Group CIDR | Needs user-specific CIDR (Type B)             |
| Change instance type         | Requires stop/start, may change pricing       |
