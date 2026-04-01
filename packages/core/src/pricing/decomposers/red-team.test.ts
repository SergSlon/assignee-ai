/**
 * Red-team tests — try to break every pricing decomposer with weird inputs.
 *
 * We verify that NO decomposer throws and that every returned item has
 * the required fields (label, serviceCode, filters, kind).
 */

import { describe, expect, it } from "vitest";

import type { PricingLineItem } from "../decomposer-types.js";

// Paid decomposers
import { ec2PricingDecomposer } from "./ec2.js";
import { rdsPricingDecomposer } from "./rds.js";
import { s3PricingDecomposer } from "./s3.js";
import { lambdaPricingDecomposer } from "./lambda.js";
import { dynamodbPricingDecomposer } from "./dynamodb.js";
import { natGatewayPricingDecomposer } from "./nat-gateway.js";
import { elbv2PricingDecomposer } from "./elbv2.js";
import { apigatewayV2PricingDecomposer } from "./apigatewayv2.js";
import { sqsPricingDecomposer } from "./sqs.js";
import { snsPricingDecomposer } from "./sns.js";
import { secretsManagerPricingDecomposer } from "./secretsmanager.js";
import { cloudWatchAlarmPricingDecomposer } from "./cloudwatch-alarm.js";
import { logsPricingDecomposer } from "./logs.js";
import { ecrPricingDecomposer } from "./ecr.js";
import { ssmPricingDecomposer } from "./ssm.js";

// Free decomposers
import {
  vpcPricingDecomposer,
  subnetPricingDecomposer,
  securityGroupPricingDecomposer,
  iamRolePricingDecomposer,
  internetGatewayPricingDecomposer,
  routeTablePricingDecomposer,
  routePricingDecomposer,
  ecsClusterPricingDecomposer,
} from "./free.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DecomposerEntry {
  name: string;
  decompose: (state: Record<string, unknown>) => PricingLineItem[];
}

const ALL_DECOMPOSERS: DecomposerEntry[] = [
  // Paid
  { name: "ec2", decompose: (s) => ec2PricingDecomposer.decompose(s) },
  { name: "rds", decompose: (s) => rdsPricingDecomposer.decompose(s) },
  { name: "s3", decompose: (s) => s3PricingDecomposer.decompose(s) },
  { name: "lambda", decompose: (s) => lambdaPricingDecomposer.decompose(s) },
  {
    name: "dynamodb",
    decompose: (s) => dynamodbPricingDecomposer.decompose(s),
  },
  {
    name: "natGateway",
    decompose: (s) => natGatewayPricingDecomposer.decompose(s),
  },
  { name: "elbv2", decompose: (s) => elbv2PricingDecomposer.decompose(s) },
  {
    name: "apigatewayV2",
    decompose: (s) => apigatewayV2PricingDecomposer.decompose(s),
  },
  { name: "sqs", decompose: (s) => sqsPricingDecomposer.decompose(s) },
  { name: "sns", decompose: (s) => snsPricingDecomposer.decompose(s) },
  {
    name: "secretsManager",
    decompose: (s) => secretsManagerPricingDecomposer.decompose(s),
  },
  {
    name: "cloudWatchAlarm",
    decompose: (s) => cloudWatchAlarmPricingDecomposer.decompose(s),
  },
  { name: "logs", decompose: (s) => logsPricingDecomposer.decompose(s) },
  { name: "ecr", decompose: (s) => ecrPricingDecomposer.decompose(s) },
  { name: "ssm", decompose: (s) => ssmPricingDecomposer.decompose(s) },
  // Free
  { name: "vpc", decompose: (s) => vpcPricingDecomposer.decompose(s) },
  { name: "subnet", decompose: (s) => subnetPricingDecomposer.decompose(s) },
  {
    name: "securityGroup",
    decompose: (s) => securityGroupPricingDecomposer.decompose(s),
  },
  { name: "iamRole", decompose: (s) => iamRolePricingDecomposer.decompose(s) },
  {
    name: "internetGateway",
    decompose: (s) => internetGatewayPricingDecomposer.decompose(s),
  },
  {
    name: "routeTable",
    decompose: (s) => routeTablePricingDecomposer.decompose(s),
  },
  { name: "route", decompose: (s) => routePricingDecomposer.decompose(s) },
  {
    name: "ecsCluster",
    decompose: (s) => ecsClusterPricingDecomposer.decompose(s),
  },
];

/** Assert every item in the array has the required PricingLineItem fields. */
function assertValidItems(items: PricingLineItem[]): void {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    expect(item.label, `item[${i}].label`).toBeTypeOf("string");
    expect(item.label.length, `item[${i}].label not empty`).toBeGreaterThan(0);
    expect(item.serviceCode, `item[${i}].serviceCode`).toBeTypeOf("string");
    expect(
      item.serviceCode.length,
      `item[${i}].serviceCode not empty`,
    ).toBeGreaterThan(0);
    expect(Array.isArray(item.filters), `item[${i}].filters is array`).toBe(
      true,
    );
    expect(item.kind, `item[${i}].kind`).toMatch(/^(fixed|usage_based)$/);
  }
}

// ---------------------------------------------------------------------------
// Poisonous input payloads
// ---------------------------------------------------------------------------

const EVIL_INPUTS: Record<string, Record<string, unknown>> = {
  "undefined values": {
    Period: undefined,
    Type: undefined,
    InstanceType: undefined,
    Engine: undefined,
    MemorySize: undefined,
    BillingMode: undefined,
    FifoQueue: undefined,
    FifoTopic: undefined,
    Tier: undefined,
    LogGroupClass: undefined,
    ProtocolType: undefined,
    AllocatedStorage: undefined,
    StorageType: undefined,
    DBInstanceClass: undefined,
    MultiAZ: undefined,
    BackupRetentionPeriod: undefined,
    ProvisionedThroughput: undefined,
    BlockDeviceMappings: undefined,
    ConnectivityType: undefined,
    QueueName: undefined,
    TopicName: undefined,
  },

  "null values": {
    Period: null,
    Type: null,
    InstanceType: null,
    Engine: null,
    MemorySize: null,
    BillingMode: null,
    FifoQueue: null,
    FifoTopic: null,
    Tier: null,
    LogGroupClass: null,
    ProtocolType: null,
    AllocatedStorage: null,
    StorageType: null,
    DBInstanceClass: null,
    MultiAZ: null,
    BackupRetentionPeriod: null,
    ProvisionedThroughput: null,
    BlockDeviceMappings: null,
    ConnectivityType: null,
    QueueName: null,
    TopicName: null,
  },

  "NaN-producing string inputs": {
    Period: "not-a-number",
    MemorySize: "abc",
    AllocatedStorage: "xyz",
    BackupRetentionPeriod: "never",
    InstanceType: 12345,
    Engine: false,
    DBInstanceClass: [],
  },

  "empty string values": {
    Type: "",
    FifoQueue: "",
    FifoTopic: "",
    Tier: "",
    InstanceType: "",
    Engine: "",
    MemorySize: "",
    BillingMode: "",
    LogGroupClass: "",
    ProtocolType: "",
    StorageType: "",
    DBInstanceClass: "",
    ConnectivityType: "",
    QueueName: "",
    TopicName: "",
  },

  "negative numbers": {
    Period: -1,
    AllocatedStorage: -100,
    MemorySize: -512,
    BackupRetentionPeriod: -7,
  },

  "very large numbers": {
    Period: 999_999_999,
    MemorySize: Infinity,
    AllocatedStorage: Number.MAX_SAFE_INTEGER,
    BackupRetentionPeriod: Infinity,
  },

  "wrong types (booleans, numbers where strings expected)": {
    FifoQueue: 1,
    FifoTopic: 0,
    Period: true,
    Type: 42,
    InstanceType: false,
    Engine: 99,
    BillingMode: true,
    Tier: -1,
    LogGroupClass: {},
    ProtocolType: [],
    StorageType: 3.14,
    DBInstanceClass: null,
    ConnectivityType: 0,
    QueueName: 123,
    TopicName: Symbol("bad"),
  },

  "nested undefined (ProvisionedThroughput)": {
    ProvisionedThroughput: undefined,
    BlockDeviceMappings: undefined,
  },

  "ProvisionedThroughput with garbage inside": {
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: {
      ReadCapacityUnits: "banana",
      WriteCapacityUnits: null,
    },
  },

  "BlockDeviceMappings with garbage inside": {
    BlockDeviceMappings: [
      { Ebs: { VolumeType: undefined, VolumeSize: "big" } },
      { Ebs: null },
      { Ebs: undefined },
      null,
      undefined,
      42,
      "not-an-object",
    ],
  },

  "BlockDeviceMappings as wrong type": {
    BlockDeviceMappings: "not-an-array",
  },

  "BlockDeviceMappings as empty array": {
    BlockDeviceMappings: [],
  },

  "completely empty object": {},

  "Symbol and function values": {
    InstanceType: Symbol("foo"),
    Period: () => 42,
    Type: Symbol.iterator,
  },

  "object where string expected": {
    InstanceType: { nested: "object" },
    Engine: { a: 1 },
    Type: { x: "y" },
    Tier: { tier: 1 },
  },

  "array where scalar expected": {
    Period: [1, 2, 3],
    MemorySize: [128],
    AllocatedStorage: [],
    Type: ["application"],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Red-team: pricing decomposers survive adversarial inputs", () => {
  for (const decomposer of ALL_DECOMPOSERS) {
    describe(decomposer.name, () => {
      for (const [inputName, input] of Object.entries(EVIL_INPUTS)) {
        it(`does not throw with ${inputName}`, () => {
          let result: PricingLineItem[];

          // Must not throw
          expect(() => {
            result = decomposer.decompose(input);
          }).not.toThrow();

          // Must return an array
          expect(Array.isArray(result!)).toBe(true);

          // Every item must have required fields
          assertValidItems(result!);
        });
      }
    });
  }
});
