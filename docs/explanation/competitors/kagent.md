# kagent

> _Snapshot date: April 2026. The competitive landscape moves fast — claims about specific pricing, feature surfaces, or roadmap items are accurate as of the date noted and may have shifted since. Verify against the linked official sources before acting on them._

## Positioning

kagent is an Apache-2.0 open-source framework from kagent-dev for **running AI agents inside Kubernetes clusters** to automate cluster operations, troubleshooting, and day-2 ops. Its tagline is "Bringing Agentic AI to cloud native." Built on the Agent2Agent (A2A) protocol, Agent Development Kit (ADK), and Model Context Protocol (MCP). Agents are defined as declarative Kubernetes custom resources (YAML `Agent` CRDs) with a system prompt, tool list, and LLM config. Ships with built-in tools for Kubernetes, Istio, Helm, Argo, Prometheus, Grafana, and Cilium. Related repo `kagent-dev/kmcp` is a CLI + controller for building/deploying MCP servers on K8s.

## Scope

- **Operations/observability, not provisioning.** kagent's built-in toolset is kubectl/helm/istioctl/prometheus-query — it diagnoses, troubleshoots, and can scale or redeploy workloads, but does not plan+apply a fresh AWS resource from natural language.
- Assumes a running Kubernetes cluster; target user is a platform/DevOps engineer who already lives in K8s.
- Multi-LLM (OpenAI, Azure OpenAI, Anthropic, Google Vertex, Ollama, AI-gateway-proxied models). OpenTelemetry tracing built in.

## Where they win

- Kubernetes-native execution model, declarative CRDs, GitOps-compatible.
- Broad provider coverage of K8s ecosystem tools (service mesh, GitOps, monitoring).
- Apache-2.0, cloud-native community momentum.

## Where Assignee.ai differentiates

- **Scope**: Assignee provisions raw AWS cloud primitives via CloudControl API (37+ types, 9 compound patterns, 185 BP rules). kagent operates on K8s objects, not AWS IAM/S3/RDS/VPC.
- **Onboarding**: Assignee is a CLI — no cluster required. kagent requires a running K8s cluster and Helm install before first value.
- **Safety loop**: Assignee's HITL + preflight + State Guard + BP auto-fix is pre-provision; kagent's loop is reactive on running workloads.
- **User**: Assignee targets app developers and solo operators on AWS; kagent targets existing K8s platform teams.

## Source URLs

- https://github.com/kagent-dev/kagent
- https://kagent.dev/
- https://github.com/kagent-dev/kmcp
- https://www.infracloud.io/blogs/ai-agents-for-kubernetes/

## Related

- `competitors/pulumi-ai.md` — different axis (IaC with agent), not K8s-native
- `competitors/sst.md` — app-framework axis
