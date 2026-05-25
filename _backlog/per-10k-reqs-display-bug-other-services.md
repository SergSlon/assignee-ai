# /10K reqs display-label bug — KMS, SSM, SecretsManager decomposers

Cross-reference: `_archive/reviews/45427772-review.md` HIGH-2.

KMS (`packages/core/src/pricing/decomposers/kms-key.ts:77`), SSM
(`packages/core/src/pricing/decomposers/ssm.ts:86`), and SecretsManager
(`packages/core/src/pricing/decomposers/secretsmanager.ts:55`) all emit
`priceUnit: "/10K reqs"` without `scale: 10_000`. The displayed rate
is per-1-request but labeled per-10K — off by 4 orders of magnitude
in implied meaning.

CloudFront fix applied in F6-ITEM-2 amendment: change `priceUnit`
to `"/req"` (most honest minimal fix). This backlog item: audit and
apply the same fix to KMS / SSM / SecretsManager. Verify the F6
promotion path still works for each (suffix-stripping should be
agnostic to the specific unit string).

Effort: ~30 min + tests. Quinn review required.
