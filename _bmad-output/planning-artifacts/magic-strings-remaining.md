# Magic Strings — Remaining Work

## Status

Constants created for ALL categories. ~280 usages in business logic files still use raw strings instead of the constant. Each is a 1-line import+replace.

## How to complete

Run this to get the exact list:

```bash
# For each string, find files that use it raw instead of the constant
grep -rn '"unknown"' apps/ packages/ --include="*.ts" | grep -v test | grep -v dist | grep -v '.d.ts' | grep -v constants/ | grep -v config/ | grep -v 'WorkloadProfile\|UNKNOWN_FALLBACK\|//'
```

Then for each file, add the import and replace the string.

## Top remaining by count

| String                     | Constant to use                            | ~Files |
| -------------------------- | ------------------------------------------ | ------ |
| "unknown"                  | WorkloadProfile.UNKNOWN / UNKNOWN_FALLBACK | 8      |
| "N/A"                      | CostEstimate.NA / CostEstimateLabel.NA     | 6      |
| "cache"/"memory"/"compute" | WorkloadProfile.\*                         | 7 each |
| "SUCCESS"/"FAILED"         | ExecutionStatus.\*                         | 5      |
| "enforce"                  | BPEnforcementLevel.ENFORCE                 | 2      |
| discover-\* keys           | DiscoveryCacheKey.\*                       | 5 each |
| "public"/"private"         | AwsDefault.CONNECTIVITY\_\*                | varies |
