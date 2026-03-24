# Story 24.8: ECS Cluster Plugin

## Status: Done

## Summary

Implement the ResourcePlugin and PricingStrategy for AWS::ECS::Cluster.

## Deliverables

1. **Plugin**: `packages/core/src/resource-plugins/plugins/ecs-cluster.ts`
   - Common fields: ClusterName, ContainerInsights (boolean, default true), Tags
   - Advanced fields: CapacityProviders (multi: FARGATE/FARGATE_SPOT), DefaultCapacityProviderStrategy
2. **Pricing**: `packages/core/src/pricing/strategies/ecs-cluster.ts` — Free (cluster itself is free)
3. **IAM actions**: ecs:CreateCluster, ecs:PutClusterCapacityProviders, ecs:TagResource
4. **Tests**: `packages/core/src/resource-plugins/plugins/ecs-cluster.test.ts`
5. **Registration**: Plugin registered in `resource-plugins/index.ts`, pricing in `pricing/index.ts`

## Acceptance Criteria

- [x] Plugin has ≤10 commonFields
- [x] ContainerInsights toCfn produces ClusterSettings array
- [x] CapacityProviders is a multi field with FARGATE and FARGATE_SPOT
- [x] DefaultCapacityProviderStrategy toCfn produces correct strategy arrays
- [x] Pricing returns Free with isFree=true
- [x] IAM actions registered in iam-actions.ts
- [x] Plugin and pricing registered in respective index files
