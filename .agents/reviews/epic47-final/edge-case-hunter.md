# Edge Case Hunter — cf55d7d + c269379

## HIGH

- H1 arn-type-map fallback miscapitalizes 10+ services (fsx/iot/wafv2/codebuild/mediaconvert/appstream/elasticbeanstalk/apprunner/etc). My KMS fix patched one symptom. Need explicit allowlist or throw on unmapped.
- H2 presetFields coercion depends on desired-state-sanitizer schema knowledge. Safe today; latent for future string-typed CCAPI fields.
- H3 LogGroup regex `/[.\/]+` matches garbage like `/./`.

## MEDIUM

- M1 EngineVersion "16.9" hardcode — deprecation time bomb. Dynamic discovery via DescribeDBEngineVersions when RDS un-skipped.
- M2 isRetryable missing "origin shield region" / "origin server" exclusions.
- M3 recursionLimit:500 masks loops — 2s×500 = 17min before vitest timeout surfaces.

## LOW

- L1 three-tier-web compound presence in repo not verified during skip claim
- L3 buildResourceArn verified — SecretsManager path safe
- L4 MasterUserPassword literal in source — scanner noise
