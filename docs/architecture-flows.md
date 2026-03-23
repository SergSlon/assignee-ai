# Assignee.ai — Architecture & Flow Diagrams

Complete reference of all execution flows, resource types, MCP integrations, and data sources.

---

## 1. Main Graph Flow (All Commands)

```mermaid
flowchart TD
    START(["`**CLI Entry**`"]) --> CMD{Command?}

    CMD -->|"assignee plan &lt;intent&gt;"| PLAN_MODE
    CMD -->|"assignee apply &lt;intent&gt;"| APPLY_MODE
    CMD -->|"assignee apply -c checkpoint"| RESUME
    CMD -->|"assignee destroy &lt;arn&gt;"| DESTROY
    CMD -->|"assignee list"| LIST
    CMD -->|"assignee setup"| SETUP
    CMD -->|"assignee init"| INIT
    CMD -->|"assignee status &lt;token&gt;"| STATUS

    subgraph GRAPH["LangGraph Agent (11 Nodes)"]
        direction TB

        subgraph PHASE1["Phase 1 — Planning"]
            IP["1. INTENT_PARSER<br/>—————<br/>Pattern match OR<br/>Bedrock LLM classify"]
            SF["2. SCHEMA_FETCHER<br/>—————<br/>MCP: cfn-mcp-server<br/>get_resource_schema"]
            OE["3. OPTION_ELICITOR<br/>—————<br/>Interactive wizard<br/>+ live pricing<br/>+ AWS discovery"]
            CD["4. COMPOUND_DISPATCHER<br/>—————<br/>Single vs multi-resource<br/>routing"]
            PG["5. PLAN_GENERATOR<br/>—————<br/>LLM generates CFN JSON<br/>+ toCfn transforms<br/>+ assembleComposites"]
            BP["6. BP_EVALUATOR<br/>—————<br/>YAML best practices<br/>evaluate findings"]
            PF["7. PREFLIGHT_GUARD<br/>—————<br/>Cost estimate<br/>+ IAM pre-check<br/>+ blocking BP check"]
        end

        HA["8. HUMAN_APPROVAL<br/>—————<br/>Display plan + cost<br/>User confirms / cancels<br/>⚡ LangGraph INTERRUPT"]

        subgraph PHASE2["Phase 2 — Provisioning"]
            RP["9. RESOURCE_PROVISIONER<br/>—————<br/>CloudControl CreateResource<br/>OR SDK fallback"]
            SP["10. STATUS_POLLER<br/>—————<br/>Poll every 2s<br/>max 60 attempts (5 min)"]
            RF["11. RESULT_FORMATTER<br/>—————<br/>SUCCESS / FAILED<br/>+ security posture check"]
        end

        IP --> SF --> OE --> CD --> PG --> BP --> PF

        PF -->|"PLAN mode"| RF
        PF -->|"APPLY mode"| HA
        PF -->|"preflightFailed"| RF

        HA -->|"confirmed"| RP
        HA -->|"cancelled"| RF

        RP -->|"IN_PROGRESS"| SP
        RP -->|"SUCCESS/FAILED"| RF

        SP -->|"still IN_PROGRESS"| SP
        SP -->|"done"| RF

        RF -->|"compound: next resource"| PG
        RF -->|"all done"| DONE
    end

    PLAN_MODE --> IP
    APPLY_MODE --> IP
    RESUME -->|"checkpoint loaded"| HA

    DESTROY["DESTROY<br/>—————<br/>Resolve ARN via Tags API<br/>CloudControl DeleteResource<br/>OR SDK fallback<br/>+ Billing MCP cost savings"]
    LIST["LIST<br/>—————<br/>Resource Groups Tagging API<br/>Filter: managed-by=assignee-ai"]
    SETUP["SETUP<br/>—————<br/>Create 3 IAM users<br/>operator / reader / auditor<br/>Least-privilege policies"]
    INIT["INIT<br/>—————<br/>Detect AWS creds/region<br/>Create .assignee/config.yaml"]
    STATUS["STATUS<br/>—————<br/>CloudControl<br/>GetRequestStatus"]

    DONE(["`**END**`"])

    style PHASE1 fill:#e8f4fd,stroke:#2196F3
    style PHASE2 fill:#fff3e0,stroke:#FF9800
    style HA fill:#fce4ec,stroke:#E91E63
```

---

## 2. MCP Servers & Data Sources

```mermaid
flowchart LR
    subgraph CORE["Core MCP Servers (Required)"]
        direction TB
        CFN["☁️ cfn-mcp-server<br/>uvx awslabs.cfn-mcp-server<br/>—————<br/>Creds: READER<br/>Region: us-east-1"]
        PRICING["💰 aws-pricing-mcp-server<br/>uvx awslabs.aws-pricing-mcp-server<br/>—————<br/>Creds: READER<br/>Region: us-east-1"]
        DOCS["📖 aws-documentation-mcp-server<br/>uvx awslabs.aws-documentation-mcp-server<br/>—————<br/>Creds: None (public)"]
        KNOW["🧠 aws-knowledge-mcp-server<br/>fastmcp remote API<br/>—————<br/>Creds: None (public)"]
    end

    subgraph OPT["Optional MCP Servers (Graceful Degrade)"]
        direction TB
        IAM["🔐 iam-mcp-server<br/>uvx --readonly<br/>—————<br/>Creds: AUDITOR"]
        SEC["🛡️ well-architected-security<br/>uvx awslabs server<br/>—————<br/>Creds: AUDITOR"]
        BILL["📊 cost-management-mcp-server<br/>uvx awslabs server<br/>—————<br/>Creds: READER"]
    end

    subgraph NODES["Graph Nodes Consuming MCP"]
        SF2["schema_fetcher"]
        OE2["option_elicitor"]
        PF2["preflight_guard"]
        RF2["result_formatter"]
        DS2["destroy cmd"]
    end

    CFN -->|"get_resource_schema"| SF2
    PRICING -->|"get_pricing"| OE2
    PRICING -->|"get_pricing"| PF2
    DOCS -->|"search_documentation<br/>read_sections"| OE2
    IAM -->|"simulate_principal_policy"| PF2
    SEC -->|"AnalyzeSecurityPosture"| RF2
    BILL -->|"get_cost_and_usage"| DS2

    subgraph SDK["Direct AWS SDK Calls"]
        direction TB
        EC2["EC2 API<br/>DescribeInstanceTypes<br/>DescribeSubnets<br/>DescribeSecurityGroups<br/>DescribeKeyPairs"]
        SSM["SSM API<br/>GetParameter<br/>(AMI discovery)"]
        CC["CloudControl API<br/>CreateResource<br/>DeleteResource<br/>GetRequestStatus"]
        TAGS["Resource Groups<br/>Tagging API<br/>GetResources"]
        STS["STS API<br/>GetCallerIdentity"]
    end

    EC2 -->|"dynamic options"| OE2
    SSM -->|"AMI lookup"| OE2
    CC -->|"provisioning"| RP2["resource_provisioner"]
    TAGS -->|"list/resolve"| LIST2["list / destroy"]

    subgraph LOCAL["Hardcoded / Embedded"]
        direction TB
        PLUGINS["Resource Plugins<br/>5 plugins × fields<br/>Labels, hints, validators<br/>toCfn transforms"]
        BPYAML["Best Practices<br/>YAML rules<br/>Severity + remediation"]
        PATTERNS["Intent Patterns<br/>Regex matchers<br/>Zero-latency shortcut"]
        LOCALP["Local Pricing Registry<br/>Fallback estimates"]
    end

    PLUGINS -->|"field definitions"| OE2
    BPYAML -->|"evaluate rules"| BP2["bp_evaluator"]
    PATTERNS -->|"pattern match"| IP2["intent_parser"]
    LOCALP -->|"fallback pricing"| PF2

    style CORE fill:#e8f5e9,stroke:#4CAF50
    style OPT fill:#fff3e0,stroke:#FF9800
    style SDK fill:#e3f2fd,stroke:#2196F3
    style LOCAL fill:#f3e5f5,stroke:#9C27B0
```

---

## 3. AWS::S3::Bucket — Wizard Flow

```mermaid
flowchart TD
    START([Option Elicitor]) --> Q1

    subgraph COMMON["Common Fields (6)"]
        Q1["🔤 BucketName<br/>type: string<br/>placeholder: my-bucket<br/>validation: 3-63 chars, lowercase<br/>─────<br/>📦 HARDCODED"]
        Q2["✅ BucketEncryption<br/>type: boolean<br/>initial: true<br/>hint: SSE-S3 free, KMS ~$1/mo<br/>─────<br/>📦 HARDCODED"]
        Q3["🔤 KMSMasterKeyID<br/>type: string<br/>showIf: BucketEncryption=true<br/>validation: arn:aws:kms:...<br/>─────<br/>📦 HARDCODED"]
        Q4["✅ PublicAccessBlockConfiguration<br/>type: boolean<br/>initial: true<br/>toCfn: BlockPublicAcls etc.<br/>─────<br/>📦 HARDCODED"]
        Q5["✅ VersioningConfiguration<br/>type: boolean<br/>initial: false<br/>toCfn: Status=Enabled<br/>─────<br/>📦 HARDCODED"]
        Q6["🔤 Tags<br/>type: string<br/>placeholder: env:production<br/>toCfn: parse Key:Value pairs<br/>─────<br/>📦 HARDCODED"]
    end

    Q1 --> Q2 --> Q2D{Encryption?}
    Q2D -->|true| Q3
    Q2D -->|false| Q4
    Q3 --> Q4 --> Q5 --> Q6

    Q6 --> ADV{Advanced?}

    subgraph ADVANCED["Advanced Fields (8)"]
        A1["✅ EnableLifecycle<br/>type: boolean, initial: false<br/>─────<br/>📦 HARDCODED"]
        A2["📋 LifecycleTransitionDays<br/>type: enum: 30/60/90/180<br/>showIf: EnableLifecycle=true<br/>─────<br/>📦 HARDCODED"]
        A3["🔤 LifecycleExpirationDays<br/>type: string<br/>showIf: EnableLifecycle=true<br/>─────<br/>📦 HARDCODED"]
        A4["✅ EnableCors<br/>type: boolean, initial: false<br/>─────<br/>📦 HARDCODED"]
        A5["🔤 CorsAllowedOrigins<br/>type: string<br/>showIf: EnableCors=true<br/>─────<br/>📦 HARDCODED"]
        A6["📋 CorsAllowedMethods<br/>type: enum: GET / GET,PUT / All<br/>showIf: EnableCors=true<br/>─────<br/>📦 HARDCODED"]
        A7["✅ EnableReplication<br/>type: boolean, initial: false<br/>─────<br/>📦 HARDCODED"]
        A8["🔤 ReplicationDestinationBucket<br/>type: string, arn:aws:s3:::<br/>showIf: EnableReplication=true<br/>─────<br/>📦 HARDCODED"]
    end

    ADV -->|yes| A1
    ADV -->|no| TOCFN

    A1 --> A1D{Lifecycle?}
    A1D -->|true| A2 --> A3 --> A4
    A1D -->|false| A4

    A4 --> A4D{CORS?}
    A4D -->|true| A5 --> A6 --> A7
    A4D -->|false| A7

    A7 --> A7D{Replication?}
    A7D -->|true| A8 --> TOCFN
    A7D -->|false| TOCFN

    TOCFN["applyToCfnTransforms<br/>+ assembleS3Composites<br/>─────<br/>BucketEncryption true → CFN object<br/>false booleans → omitted<br/>Tags → Key/Value array<br/>Composite assembly:<br/>Lifecycle/CORS/Replication"]

    TOCFN --> PG([Plan Generator])

    style COMMON fill:#e8f5e9,stroke:#4CAF50
    style ADVANCED fill:#fff3e0,stroke:#FF9800
    style TOCFN fill:#f3e5f5,stroke:#9C27B0
```

---

## 4. AWS::EC2::Instance — Wizard Flow

```mermaid
flowchart TD
    START([Option Elicitor]) --> Q1

    subgraph COMMON["Common Fields (6)"]
        Q1["📋 InstanceType<br/>type: categorySelect<br/>4 categories, 28 types<br/>initial: t3.micro<br/>─────<br/>📦 HARDCODED categories<br/>🔄 DYNAMIC: DescribeInstanceTypes<br/>fetches current-gen types<br/>💰 DYNAMIC: Pricing MCP<br/>fetches live $/hr per type"]
        Q2["📋 ImageId / AMI<br/>type: enum<br/>options: EMPTY at build<br/>─────<br/>🔄 DYNAMIC: fetcher=discover-amis<br/>SSM GetParameter<br/>/aws/service/ami-amazon-linux-latest<br/>+ EC2 DescribeImages<br/>6s timeout, fallback: manual"]
        Q3["📋 KeyName<br/>type: enum<br/>options: EMPTY at build<br/>─────<br/>🔄 DYNAMIC: fetcher=discover-key-pairs<br/>EC2 DescribeKeyPairs<br/>6s timeout, fallback: manual"]
        Q4["📋 SubnetId<br/>type: enum<br/>options: EMPTY at build<br/>─────<br/>🔄 DYNAMIC: fetcher=discover-subnets<br/>EC2 DescribeSubnets<br/>6s timeout, fallback: manual"]
        Q5["📋 SecurityGroupIds<br/>type: multi-select<br/>options: EMPTY at build<br/>─────<br/>🔄 DYNAMIC: fetcher=discover-security-groups<br/>EC2 DescribeSecurityGroups<br/>6s timeout, fallback: manual"]
        Q6["🔤 Tags<br/>type: string<br/>toCfn: parse Key:Value<br/>─────<br/>📦 HARDCODED"]
    end

    Q1 --> Q2 --> Q3 --> Q4 --> Q5 --> Q6

    Q6 --> ADV{Advanced?}

    subgraph ADVANCED["Advanced Fields (2)"]
        A1["🔤 IamInstanceProfile<br/>type: string<br/>─────<br/>📦 HARDCODED"]
        A2["🔤 UserData<br/>type: string<br/>base64 script<br/>─────<br/>📦 HARDCODED"]
    end

    ADV -->|yes| A1 --> A2 --> PG
    ADV -->|no| PG

    subgraph CATS["categorySelect: 4 Instance Categories"]
        C1["⚡ Burstable t3/t4g<br/>10 types<br/>$0.008-0.17/hr"]
        C2["⚖️ General Purpose m5/m6i<br/>6 types<br/>$0.096-0.38/hr"]
        C3["🖥️ Compute Optimized c5/c6i<br/>6 types<br/>$0.085-0.34/hr"]
        C4["🧠 Memory Optimized r5/r6i<br/>6 types<br/>$0.126-0.50/hr"]
    end

    Q1 -.->|"user picks category"| CATS

    subgraph FETCH["Runtime Discovery (6s timeout each)"]
        F1["EC2 DescribeInstanceTypes<br/>current-generation=true<br/>grouped by family"]
        F2["SSM /aws/service/ami-*<br/>+ EC2 DescribeImages"]
        F3["EC2 DescribeKeyPairs"]
        F4["EC2 DescribeSubnets"]
        F5["EC2 DescribeSecurityGroups"]
    end

    PG([Plan Generator])

    style COMMON fill:#e3f2fd,stroke:#2196F3
    style ADVANCED fill:#fff3e0,stroke:#FF9800
    style CATS fill:#fce4ec,stroke:#E91E63
    style FETCH fill:#e8f5e9,stroke:#4CAF50
```

---

## 5. AWS::RDS::DBInstance — Wizard Flow

```mermaid
flowchart TD
    START([Option Elicitor]) --> Q1

    subgraph COMMON["Common Fields (13+)"]
        Q1["📋 DBInstanceClass<br/>type: enum, 7 options<br/>db.t3.micro → db.r6g.xlarge<br/>initial: db.t3.micro<br/>─────<br/>📦 HARDCODED options<br/>💰 DYNAMIC: Pricing MCP<br/>fetches live $/hr per class"]
        Q2["📋 Engine<br/>type: enum, 5 options<br/>mysql / postgres / mariadb<br/>aurora-mysql / aurora-postgresql<br/>initial: postgres<br/>─────<br/>📦 HARDCODED"]
        Q3P["📋 EngineVersion (Postgres)<br/>enum: 16, 15<br/>showIf: Engine=postgres<br/>📦 HARDCODED"]
        Q3M["📋 EngineVersion (MySQL)<br/>enum: 8.4, 8.0<br/>showIf: Engine=mysql<br/>📦 HARDCODED"]
        Q3D["📋 EngineVersion (MariaDB)<br/>enum: 11.4, 10.11<br/>showIf: Engine=mariadb<br/>📦 HARDCODED"]
        Q3AM["📋 EngineVersion (Aurora MySQL)<br/>enum: 3.07.1, 3.05.2<br/>showIf: Engine=aurora-mysql<br/>📦 HARDCODED"]
        Q3AP["📋 EngineVersion (Aurora PG)<br/>enum: 16.4, 15.8<br/>showIf: Engine=aurora-postgresql<br/>📦 HARDCODED"]
        Q4["🔤 DBName<br/>type: string<br/>placeholder: myapp<br/>📦 HARDCODED"]
        Q5["🔤 MasterUsername<br/>type: string, REQUIRED<br/>validation: non-empty<br/>📦 HARDCODED"]
        Q6["🔤 MasterUserPassword<br/>type: string<br/>blank = auto-generate<br/>📦 HARDCODED"]
        Q7["✅ MultiAZ<br/>type: boolean<br/>initial: false<br/>hint: doubles cost<br/>📦 HARDCODED"]
        Q8["✅ DeletionProtection<br/>type: boolean<br/>initial: false<br/>📦 HARDCODED"]
        Q9["📋 StorageType<br/>enum: gp3 / gp2 / io1<br/>initial: gp3<br/>📦 HARDCODED"]
        Q10["📋 AllocatedStorage<br/>enum: 20/50/100/200 GB<br/>initial: 20<br/>📦 HARDCODED"]
        Q11["🔤 Tags<br/>toCfn: parse Key:Value<br/>📦 HARDCODED"]
    end

    Q1 --> Q2

    Q2 --> ENG{Engine?}
    ENG -->|postgres| Q3P
    ENG -->|mysql| Q3M
    ENG -->|mariadb| Q3D
    ENG -->|aurora-mysql| Q3AM
    ENG -->|aurora-postgresql| Q3AP

    Q3P --> Q4
    Q3M --> Q4
    Q3D --> Q4
    Q3AM --> Q4
    Q3AP --> Q4

    Q4 --> Q5 --> Q6 --> Q7 --> Q8 --> Q9 --> Q10 --> Q11

    Q11 --> ADV{Advanced?}

    subgraph ADVANCED["Advanced Fields (1)"]
        A1["🔤 BackupRetentionPeriod<br/>type: string<br/>placeholder: 7<br/>validation: 0-35 days<br/>📦 HARDCODED"]
    end

    ADV -->|yes| A1 --> PG
    ADV -->|no| PG

    PG([Plan Generator])

    style COMMON fill:#fff9c4,stroke:#FFC107
    style ADVANCED fill:#fff3e0,stroke:#FF9800
```

---

## 6. AWS::Lambda::Function — Wizard Flow

```mermaid
flowchart TD
    START([Option Elicitor]) --> Q1

    subgraph COMMON["Common Fields (8)"]
        Q1["🔤 FunctionName<br/>type: string, REQUIRED<br/>validation: max 64 chars<br/>letters/numbers/hyphens<br/>─────<br/>📦 HARDCODED"]
        Q2["📋 Runtime<br/>type: enum, 8 options<br/>nodejs22.x / nodejs20.x<br/>python3.13 / python3.12<br/>java21 / dotnet8 / ruby3.3<br/>provided.al2023<br/>initial: nodejs22.x<br/>─────<br/>📦 HARDCODED"]
        Q3["🔤 Handler<br/>type: string<br/>placeholder: index.handler<br/>validation: must contain dot<br/>─────<br/>📦 HARDCODED"]
        Q4["🔤 Role<br/>type: string, REQUIRED<br/>validation: arn:aws:iam::<br/>hint: omit for auto-create<br/>─────<br/>📦 HARDCODED"]
        Q5["📋 MemorySize<br/>type: enum, 5 options<br/>128/256/512/1024/2048 MB<br/>initial: 128<br/>cost: calculated per 100ms<br/>─────<br/>📦 HARDCODED<br/>🧮 COMPUTED: cost/100ms<br/>from LAMBDA_USD_PER_GB_SECOND"]
        Q6["🔤 Timeout<br/>type: string<br/>initial: 30<br/>validation: 1-900<br/>─────<br/>📦 HARDCODED"]
        Q7["🔤 Environment<br/>type: string<br/>placeholder: DB_HOST=localhost<br/>toCfn: parse KEY=VALUE<br/>→ Variables object<br/>─────<br/>📦 HARDCODED"]
        Q8["🔤 Tags<br/>type: string<br/>toCfn: parse Key:Value<br/>─────<br/>📦 HARDCODED"]
    end

    Q1 --> Q2 --> Q3 --> Q4 --> Q5 --> Q6 --> Q7 --> Q8

    Q8 --> ADV{Advanced?}

    subgraph ADVANCED["Advanced Fields (2)"]
        A1["🔤 Description<br/>type: string<br/>validation: max 256 chars<br/>─────<br/>📦 HARDCODED"]
        A2["🔤 ReservedConcurrentExecutions<br/>type: string<br/>validation: -1 or non-negative int<br/>─────<br/>📦 HARDCODED"]
    end

    ADV -->|yes| A1 --> A2 --> HINTS
    ADV -->|no| HINTS

    HINTS["configHints for LLM<br/>─────<br/>1. Runtime MUST be valid enum<br/>   NEVER use deprecated runtimes<br/>2. If no Role ARN provided<br/>   OMIT Role property<br/>─────<br/>📦 HARDCODED"]

    HINTS --> PG([Plan Generator])

    style COMMON fill:#e8eaf6,stroke:#3F51B5
    style ADVANCED fill:#fff3e0,stroke:#FF9800
    style HINTS fill:#f3e5f5,stroke:#9C27B0
```

---

## 7. Generic Resource (Fallback) — Wizard Flow

```mermaid
flowchart TD
    START([Option Elicitor]) --> CHECK{Plugin exists<br/>for resourceType?}

    CHECK -->|"S3/EC2/RDS/Lambda"| SPECIFIC([Use dedicated plugin])
    CHECK -->|"Any other type"| GENERIC

    subgraph GENERIC["Generic Plugin (Fallback)"]
        Q1["🔤 ResourceName<br/>type: string<br/>placeholder: my-resource<br/>─────<br/>📦 HARDCODED"]
        Q2["🔤 Tags<br/>type: string<br/>toCfn: parse Key:Value<br/>─────<br/>📦 HARDCODED"]
    end

    Q1 --> Q2

    Q2 --> SCHEMA

    SCHEMA["Additional fields from<br/>CloudFormation Schema<br/>─────<br/>🔄 DYNAMIC: cfn-mcp-server<br/>required[] properties<br/>surfaced to user"]

    SCHEMA --> PG([Plan Generator<br/>LLM fills remaining<br/>properties from schema])

    NOTE["Note: Generic plugin has<br/>• No configHints<br/>• No defaults<br/>• No advanced fields<br/>• Schema-driven discovery<br/>  fills the gap"]

    style GENERIC fill:#f5f5f5,stroke:#9E9E9E
    style SCHEMA fill:#e3f2fd,stroke:#2196F3
    style NOTE fill:#fffde7,stroke:#FDD835
```

---

## 8. 3-User Credential Model & MCP Routing

```mermaid
flowchart TB
    subgraph CREDS["3 IAM User Classes (Least Privilege)"]
        direction LR
        OP["🔧 OPERATOR<br/>ASSIGNEE_OPERATOR_*<br/>─────<br/>Bedrock InvokeModel<br/>CloudControl CRUD<br/>Resource provisioning"]
        RD["📖 READER<br/>ASSIGNEE_READER_*<br/>─────<br/>CFN Schema registry<br/>Pricing API<br/>Cost Explorer"]
        AU["🔐 AUDITOR<br/>ASSIGNEE_AUDITOR_*<br/>─────<br/>IAM SimulatePolicy<br/>SecurityHub<br/>GuardDuty<br/>Inspector<br/>Access Analyzer"]
    end

    subgraph CORE_MCP["Core MCP Servers"]
        CFN["cfn-mcp-server"]
        PRICE["aws-pricing-mcp-server"]
        DOCS["aws-documentation-mcp-server<br/>(no creds needed)"]
        KNOW["aws-knowledge-mcp-server<br/>(no creds needed)"]
    end

    subgraph OPT_MCP["Optional MCP Servers"]
        IAM_S["iam-mcp-server --readonly"]
        SEC_S["well-architected-security"]
        BILL_S["cost-management-mcp-server"]
    end

    subgraph DIRECT["Direct AWS SDK Calls"]
        BED["Bedrock<br/>InvokeModel<br/>(LLM calls)"]
        CC["CloudControl<br/>Create/Delete/Get"]
        EC2D["EC2<br/>Describe*<br/>(discovery)"]
        SSMD["SSM<br/>GetParameter<br/>(AMI lookup)"]
        STSD["STS<br/>GetCallerIdentity"]
        TAGD["ResourceGroups<br/>Tagging API"]
        IAMD["IAM<br/>Create/Attach<br/>(setup only)"]
    end

    RD -->|"AWS_* env mapped"| CFN
    RD -->|"AWS_* env mapped"| PRICE
    RD -->|"AWS_* env mapped"| BILL_S
    AU -->|"AWS_* env mapped"| IAM_S
    AU -->|"AWS_* env mapped"| SEC_S

    OP --> BED
    OP --> CC
    OP --> EC2D
    OP --> SSMD
    OP --> STSD
    OP --> TAGD
    OP --> IAMD

    subgraph NODES["Graph Nodes"]
        N_IP["intent_parser"]
        N_SF["schema_fetcher"]
        N_OE["option_elicitor"]
        N_PF["preflight_guard"]
        N_RP["resource_provisioner"]
        N_RF["result_formatter"]
    end

    BED --> N_IP
    BED --> N_OE
    BED --> N_PF
    CFN --> N_SF
    PRICE --> N_OE
    PRICE --> N_PF
    EC2D --> N_OE
    SSMD --> N_OE
    IAM_S --> N_PF
    CC --> N_RP
    SEC_S --> N_RF

    style CREDS fill:#e8f5e9,stroke:#4CAF50
    style CORE_MCP fill:#e3f2fd,stroke:#2196F3
    style OPT_MCP fill:#fff3e0,stroke:#FF9800
    style DIRECT fill:#fce4ec,stroke:#E91E63
    style NODES fill:#f5f5f5,stroke:#9E9E9E
```

---

## 9. Assignee MCP Server — Exposed to External AI Agents

```mermaid
flowchart TD
    subgraph AGENTS["External AI Agents"]
        CC["Claude Code"]
        CUR["Cursor"]
        WIND["Windsurf"]
    end

    subgraph MCP_SERVER["@assignee/mcp-server<br/>npx @assignee/mcp-server<br/>stdio transport"]
        PLAN["plan_resource<br/>─────<br/>Input: description, region?, env?<br/>Invokes: LangGraph PLAN mode<br/>Returns: desired-state JSON<br/>+ estimated cost<br/>+ checkpoint path"]
        APPLY["apply_plan<br/>─────<br/>Input: checkpointPath, confirmed<br/>Safety: rejects unconfirmed<br/>Invokes: LangGraph APPLY mode<br/>Returns: resource ARN or error"]
        LIST["list_managed_resources<br/>─────<br/>Input: region?, resourceType?<br/>Queries: Resource Groups Tags<br/>Filter: managed-by=assignee-ai<br/>Returns: JSON array"]
        ESTIMATE["estimate_cost<br/>─────<br/>Input: description, resourceType?,<br/>desiredState?, region?<br/>Uses: local PricingStrategyRegistry<br/>Fast: no remote calls<br/>Returns: monthly cost estimate"]
    end

    CC --> MCP_SERVER
    CUR --> MCP_SERVER
    WIND --> MCP_SERVER

    subgraph INTERNAL["Internal: Reuses CLI Graph"]
        GRAPH["LangGraph Agent<br/>(same 11 nodes)"]
        MCPS["Core MCP Servers<br/>(cfn, pricing, docs, knowledge)"]
        AWS["AWS CloudControl<br/>+ SDK fallbacks"]
    end

    PLAN -->|"ExecutionMode.PLAN"| GRAPH
    APPLY -->|"ExecutionMode.APPLY"| GRAPH
    LIST --> AWS
    ESTIMATE -->|"local registry"| INTERNAL

    GRAPH --> MCPS
    GRAPH --> AWS

    subgraph CHECKPOINT["Checkpoint Flow"]
        CP1["plan_resource<br/>saves checkpoint JSON<br/>to MCP_CHECKPOINT_DIR"]
        CP2["apply_plan<br/>loads checkpoint<br/>resumes at HUMAN_APPROVAL"]
    end

    PLAN --> CP1
    CP1 -->|"path returned<br/>to agent"| CP2
    CP2 --> APPLY

    style AGENTS fill:#e8eaf6,stroke:#3F51B5
    style MCP_SERVER fill:#e8f5e9,stroke:#4CAF50
    style INTERNAL fill:#fff3e0,stroke:#FF9800
    style CHECKPOINT fill:#fce4ec,stroke:#E91E63
```

---

## Data Source Legend

| Symbol                  | Meaning                                       |
| ----------------------- | --------------------------------------------- |
| 📦 HARDCODED            | Defined statically in plugin source code      |
| 🔄 DYNAMIC              | Fetched at runtime from AWS API or MCP server |
| 💰 DYNAMIC: Pricing MCP | Live price from aws-pricing-mcp-server        |
| 🧮 COMPUTED             | Calculated from constants at build time       |
| 📋 enum                 | Fixed dropdown options                        |
| ✅ boolean              | Yes/No toggle                                 |
| 🔤 string               | Free text input                               |

## Timeout & Fallback Summary

| Source                        | Timeout | Fallback                      |
| ----------------------------- | ------- | ----------------------------- |
| EC2 Describe\* (discovery)    | 6s      | Manual string entry           |
| SSM AMI lookup                | 6s      | Manual string entry           |
| Pricing MCP (option_elicitor) | 6s      | Static cost hints in labels   |
| Pricing MCP (preflight_guard) | 3s      | Local pricing registry        |
| IAM simulation                | 3s      | Assume allowed                |
| Security posture              | 5s      | Skip findings                 |
| Billing MCP (destroy)         | 3s      | Provision log memory or "N/A" |
