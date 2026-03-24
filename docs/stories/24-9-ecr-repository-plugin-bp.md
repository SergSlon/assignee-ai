# Story 24.9: ECR Repository Plugin + Best Practices

## Status: Done

## Summary

Implement the ResourcePlugin, PricingStrategy, and Best Practice rules for AWS::ECR::Repository.

## Deliverables

1. **Plugin**: `packages/core/src/resource-plugins/plugins/ecr-repository.ts`
   - Common fields: RepositoryName (required), ImageTagMutability (enum: MUTABLE/IMMUTABLE, default IMMUTABLE), ScanOnPush (boolean, default true), Tags
   - Advanced fields: EncryptionType (enum: AES256/KMS), KmsKey (showIf KMS), LifecyclePolicyText
2. **Pricing**: `packages/core/src/pricing/strategies/ecr.ts`
   - estimateLocal: "~$0.10/GB-mo storage"
   - mcpConfig: serviceCode "AmazonECR", productFamily "EC2 Container Registry"
3. **IAM actions**: ecr:CreateRepository, ecr:PutImageScanningConfiguration, ecr:PutLifecyclePolicy, ecr:TagResource
4. **Best Practices**:
   - `packages/best-practices/ecr/BP-ECR-001.yaml` — Image scanning enabled
   - `packages/best-practices/ecr/BP-ECR-002.yaml` — Tag immutability
5. **Tests**: `packages/core/src/resource-plugins/plugins/ecr-repository.test.ts`
6. **Registration**: Plugin registered in `resource-plugins/index.ts`, pricing in `pricing/index.ts`

## Acceptance Criteria

- [x] Plugin has ≤10 commonFields
- [x] RepositoryName is required with 2-256 char validation
- [x] ImageTagMutability defaults to IMMUTABLE
- [x] ScanOnPush defaults to true
- [x] KmsKey field has showIf on EncryptionType=KMS
- [x] Pricing has both estimateLocal and mcpConfig
- [x] BP-ECR-001 checks ScanOnPush=true (severity HIGH)
- [x] BP-ECR-002 checks ImageTagMutability=IMMUTABLE (severity HIGH)
- [x] IAM actions registered in iam-actions.ts
