# Story 24.10: ELBv2 LoadBalancer Plugin + Pricing + Best Practices

## Status: Done

## Summary

Implement the ResourcePlugin, PricingStrategy, and Best Practice rules for AWS::ElasticLoadBalancingV2::LoadBalancer.

## Deliverables

1. **Plugin**: `packages/core/src/resource-plugins/plugins/elbv2-loadbalancer.ts`
   - Common fields: Name (required), Type (enum: application/network), Scheme (enum: internet-facing/internal), Subnets (multi, fetcher: discover-subnets), Tags
   - Advanced fields: SecurityGroups (multi, showIf type=application, fetcher: discover-security-groups), IpAddressType (enum: ipv4/dualstack), DeletionProtection (boolean, default true)
2. **Pricing**: `packages/core/src/pricing/strategies/elbv2.ts`
   - estimateLocal: "~$0.0225/hr + LCU charges"
   - mcpConfig: serviceCode "ElasticLoadBalancing", productFamily "Load Balancer"
3. **IAM actions**: elasticloadbalancing:CreateLoadBalancer, elasticloadbalancing:AddTags, ec2:DescribeSubnets, ec2:DescribeSecurityGroups
4. **Best Practices**:
   - `packages/best-practices/elbv2/BP-ELB-001.yaml` — Deletion protection
   - `packages/best-practices/elbv2/BP-ELB-002.yaml` — Access logging
   - `packages/best-practices/elbv2/BP-ELB-003.yaml` — Drop invalid headers for ALB
5. **Tests**: `packages/core/src/resource-plugins/plugins/elbv2-loadbalancer.test.ts`
6. **Registration**: Plugin registered in `resource-plugins/index.ts`, pricing in `pricing/index.ts`

## Acceptance Criteria

- [x] Plugin has ≤10 commonFields
- [x] Name is required with 1-32 char validation
- [x] Type defaults to application with ALB/NLB options
- [x] Subnets uses discover-subnets fetcher
- [x] SecurityGroups has showIf on Type=application with discover-security-groups fetcher
- [x] DeletionProtection defaults to true with attribute-style toCfn
- [x] Pricing has both estimateLocal and mcpConfig
- [x] BP-ELB-001 checks deletion protection (severity HIGH)
- [x] BP-ELB-002 checks access logging (severity MEDIUM)
- [x] BP-ELB-003 checks drop invalid headers (severity MEDIUM)
- [x] IAM actions registered in iam-actions.ts
