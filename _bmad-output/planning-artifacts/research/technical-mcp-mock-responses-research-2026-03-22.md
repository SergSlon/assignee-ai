# Technical Research: MCP Mock Responses for assignee.ai

**Date:** 2026-03-22
**Status:** Complete
**Deliverable:** `apps/cli/src/test-fixtures/mcp-mock-responses.ts`

---

## 1. MCP Servers Inventory

| #   | Server Name                    | Command                                                | Tools                                                         | Purpose                                                 |
| --- | ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | `cfn-mcp-server`               | `uvx awslabs.cfn-mcp-server@latest`                    | `get_resource_schema_information`                             | CloudFormation schema fetching                          |
| 2   | `aws-knowledge-mcp-server`     | `uvx fastmcp run https://knowledge-mcp.global.api.aws` | _(not directly called by app code)_                           | AWS knowledge base (available but unused in tool calls) |
| 3   | `aws-pricing-mcp-server`       | `uvx awslabs.aws-pricing-mcp-server@latest`            | `get_pricing`                                                 | Live cost estimation                                    |
| 4   | `aws-documentation-mcp-server` | `uvx awslabs.aws-documentation-mcp-server@latest`      | `search_documentation`, `read_sections`, `read_documentation` | Contextual field help                                   |

## 2. Tool Usage Matrix

| Tool                              | Used By                                    | Input                                                 | Response Format                                                      |
| --------------------------------- | ------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------- |
| `get_resource_schema_information` | `schema-fetcher.ts`                        | `{ resource_type: string }`                           | `{ type: "text", text: "<CFN schema JSON>" }`                        |
| `get_pricing`                     | `preflight-guard.ts`, `pricing-lookup.ts`  | `{ service_code, region, filters[], output_options }` | `{ type: "text", text: "<AwsPricingResponse JSON>" }`                |
| `search_documentation`            | `display.ts` → `fetchDocText()`            | `{ search_phrase: string }`                           | `{ structuredContent: { search_results: [{ url }] } }` or plain text |
| `read_sections`                   | `display.ts` → `fetchDocText()`            | `{ url: string, section_titles: string[] }`           | `{ type: "text", text: "<doc content>" }`                            |
| `read_documentation`              | `display.ts` → `fetchDocText()` (fallback) | `{ url: string }`                                     | `{ type: "text", text: "<full page content>" }`                      |

## 3. Mock Coverage Summary

### 3.1 Schema Responses (9 variants)

| Mock Key         | Resource Type         | Has Required Fields | Use Case                                  |
| ---------------- | --------------------- | ------------------- | ----------------------------------------- |
| `s3Bucket`       | AWS::S3::Bucket       | No                  | Default happy path                        |
| `ec2Instance`    | AWS::EC2::Instance    | Yes (ImageId)       | Validation with 1 required field          |
| `lambdaFunction` | AWS::Lambda::Function | Yes (3 fields)      | Validation with multiple required fields  |
| `rdsDbInstance`  | AWS::RDS::DBInstance  | Yes (2 fields)      | RDS-specific options                      |
| `iamRole`        | AWS::IAM::Role        | No                  | Free-tier resource, compound provisioning |
| `dynamoDbTable`  | AWS::DynamoDB::Table  | Yes (2 fields)      | Compound provisioning                     |
| `ssmParameter`   | AWS::SSM::Parameter   | Yes (2 fields)      | Parameter Store                           |
| `generic`        | Custom resource       | No                  | Unknown resource fallback                 |
| `empty`          | Unknown type          | No                  | Empty schema edge case                    |

### 3.2 Pricing Responses (14 variants)

| Mock Key                    | Service | Instance/Tier             | Price (USD)        | Use Case                                  |
| --------------------------- | ------- | ------------------------- | ------------------ | ----------------------------------------- |
| `s3Storage`                 | S3      | 3-tier storage            | $0.023/0.022/0.021 | Multi-tier parsing, first-tier extraction |
| `ec2T3Micro`                | EC2     | t3.micro                  | $0.0104/hr         | Option-elicitor price injection           |
| `ec2T3Small`                | EC2     | t3.small                  | $0.0208/hr         | Multiple instance pricing                 |
| `ec2M5Large`                | EC2     | m5.large                  | $0.096/hr          | Higher-tier instance                      |
| `rdsT3MicroPostgres`        | RDS     | db.t3.micro/PostgreSQL    | $0.017/hr          | Single-AZ with deployment filter          |
| `rdsT3MicroMysql`           | RDS     | db.t3.micro/MySQL         | $0.017/hr          | MySQL engine                              |
| `rdsR6gLargeAuroraPostgres` | RDS     | db.r6g.large/Aurora PG    | $0.260/hr          | Aurora (no deployment filter)             |
| `rdsR6gLargeAuroraMysql`    | RDS     | db.r6g.large/Aurora MySQL | $0.250/hr          | Aurora MySQL                              |
| `rdsT3MicroMariadb`         | RDS     | db.t3.micro/MariaDB       | $0.017/hr          | MariaDB engine                            |
| `ssmParameter`              | SSM     | Standard                  | $0.00              | Free-tier parameter                       |
| `zeroPrice`                 | Any     | Any                       | $0.00              | Zero-price edge case                      |
| `emptyData`                 | Any     | Any                       | N/A                | No matching products                      |
| `emptyResponse`             | Any     | Any                       | N/A                | Missing data key                          |
| `malformedJson`             | Any     | Any                       | Parse error        | Invalid JSON                              |

### 3.3 Documentation Search Responses (8 variants)

| Mock Key              | Response Type       | Use Case                         |
| --------------------- | ------------------- | -------------------------------- |
| `s3BucketName`        | Structured, 2 URLs  | Happy path with multiple results |
| `ec2InstanceType`     | Structured, 1 URL   | Single result                    |
| `lambdaRuntime`       | Structured, 1 URL   | Lambda-specific                  |
| `rdsEngine`           | Structured, 1 URL   | RDS-specific                     |
| `unstructuredWithUrl` | Plain text with URL | Regex fallback extraction        |
| `emptyResults`        | Structured, 0 URLs  | No documentation found           |
| `noResultsText`       | Plain text, no URL  | Complete miss                    |
| `nullResponse`        | null                | Server returned nothing          |

### 3.4 Documentation Read Sections Responses (8 variants)

| Mock Key              | Content                    | Use Case                             |
| --------------------- | -------------------------- | ------------------------------------ |
| `s3BucketName`        | BucketName properties      | Happy path                           |
| `ec2InstanceType`     | InstanceType description   | EC2-specific                         |
| `lambdaRuntime`       | Runtime properties         | Lambda-specific                      |
| `rdsEngine`           | Engine properties          | RDS-specific                         |
| `dynamoDbBillingMode` | BillingMode properties     | DynamoDB-specific                    |
| `longContent`         | Very long content          | Truncation/synthesis stress test     |
| `withNotFoundNote`    | Contains "Note: not found" | Regex cleanup test                   |
| `noMatchingSections`  | Error                      | Triggers read_documentation fallback |

### 3.5 Documentation Read Full Responses (3 variants)

| Mock Key             | Content          | Use Case                    |
| -------------------- | ---------------- | --------------------------- |
| `s3BucketFull`       | Full S3 page     | Fallback from read_sections |
| `lambdaFunctionFull` | Full Lambda page | Lambda fallback             |
| `emptyPage`          | Empty content    | Edge case                   |

## 4. Factory Functions

| Function                                        | Purpose              | Example                |
| ----------------------------------------------- | -------------------- | ---------------------- |
| `createMockTool(name, response)`                | Single success tool  | Basic mock             |
| `createFailingMockTool(name, error?)`           | Rejection tool       | Error handling tests   |
| `createHangingMockTool(name)`                   | Never-resolving tool | Timeout tests          |
| `createDelayedMockTool(name, response, ms)`     | Delayed resolution   | Timeout boundary tests |
| `createNullMockTool(name)`                      | Returns null         | withTimeout() fallback |
| `createSequenceMockTool(name, responses[])`     | Multi-call tool      | Sequential call tests  |
| `createAllMockTools()`                          | All 5 tools          | Integration tests      |
| `createCoreMockTools(schema?, pricing?)`        | Schema + pricing     | Node tests             |
| `createDocMockTools(search?, sections?, full?)` | 3 doc tools          | Display tests          |
| `createPricingLookupTool(priceMap)`             | Dynamic per-instance | Multi-instance pricing |

## 5. Builder Functions

| Function                                     | Purpose                  |
| -------------------------------------------- | ------------------------ |
| `buildPricingResponse(priceUsd)`             | Custom single-tier price |
| `buildMultiTierPricingResponse(tiers[])`     | Custom multi-tier price  |
| `buildSchemaResponse(type, props, required)` | Custom resource schema   |
| `buildDocSearchResponse(urls[])`             | Custom search results    |
| `buildDocReadResponse(content)`              | Custom doc content       |

## 6. File Location

```
apps/cli/src/test-fixtures/mcp-mock-responses.ts
```

Import pattern:

```typescript
import {
  McpMocks,
  createMockTool,
} from "../test-fixtures/mcp-mock-responses.js";
```
