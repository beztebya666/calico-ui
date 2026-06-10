// Pristine demo dataset for calico-ui — realistic Calico network flows across a
// Kubernetes cluster (workloads, services, policies, allow/deny), from which the
// service-graph and flow views are derived.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Flow, ActionType } from "../../types/flow";

const now = Date.now();
const ep = (name: string, namespace: string, kind: string, port?: number, svc?: string): any => ({
  name, namespace, kind, labels: [`app=${name.split("-")[0]}`, `k8s-app=${name.split("-")[0]}`], port, serviceName: svc, serviceNamespace: svc ? namespace : undefined,
});

// [srcName, srcNs, dstName, dstNs, proto, port, action, kbIn, kbOut, svc]
const SPEC: [string, string, string, string, string, number, ActionType, number, number, string?][] = [
  ["ingress-nginx-controller", "ingress-nginx", "web-7d9f8c6b5", "frontend", "TCP", 8080, "Allow", 420, 1840, "web"],
  ["web-7d9f8c6b5", "frontend", "api-5c8b9d7f6", "backend", "TCP", 8080, "Allow", 880, 3120, "api"],
  ["api-5c8b9d7f6", "backend", "postgres-0", "database", "TCP", 5432, "Allow", 2400, 1200, "postgres"],
  ["api-5c8b9d7f6", "backend", "redis-0", "database", "TCP", 6379, "Allow", 640, 410, "redis"],
  ["web-7d9f8c6b5", "frontend", "coredns", "kube-system", "UDP", 53, "Allow", 12, 28, "kube-dns"],
  ["api-5c8b9d7f6", "backend", "coredns", "kube-system", "UDP", 53, "Allow", 18, 36, "kube-dns"],
  ["prometheus-0", "monitoring", "api-5c8b9d7f6", "backend", "TCP", 9090, "Allow", 90, 1400, "api"],
  ["prometheus-0", "monitoring", "web-7d9f8c6b5", "frontend", "TCP", 9090, "Allow", 90, 1200, "web"],
  ["grafana-66f8c", "monitoring", "prometheus-0", "monitoring", "TCP", 9090, "Allow", 220, 5400, "prometheus"],
  ["external", "net", "ingress-nginx-controller", "ingress-nginx", "TCP", 443, "Allow", 6200, 14800, ""],
  ["api-5c8b9d7f6", "backend", "external", "net", "TCP", 443, "Allow", 320, 180, ""],
  ["web-7d9f8c6b5", "frontend", "postgres-0", "database", "TCP", 5432, "Deny", 2, 0, "postgres"],
  ["external", "net", "postgres-0", "database", "TCP", 5432, "Deny", 4, 0, "postgres"],
  ["external", "net", "redis-0", "database", "TCP", 6379, "Deny", 1, 0, "redis"],
  ["batch-job-27839", "backend", "postgres-0", "database", "TCP", 5432, "Allow", 1800, 600, "postgres"],
  ["api-5c8b9d7f6", "backend", "argocd-server", "argocd", "TCP", 443, "Pass", 40, 120, "argocd-server"],
];

export function buildSeed() {
  let id = 1000;
  const flows: Flow[] = SPEC.map(([sn, sns, dn, dns, proto, port, action, kbIn, kbOut, svc]) => {
    id += 1;
    const jitter = 0.85 + Math.random() * 0.3;
    return {
      id, key: `${sns}/${sn}->${dns}/${dn}:${port}`, startTime: Math.floor((now - 300_000) / 1000), endTime: Math.floor(now / 1000),
      source: ep(sn, sns, sns === "net" ? "net" : "wep", undefined, undefined),
      destination: ep(dn, dns, dns === "net" ? "net" : "wep", port, svc || undefined),
      protocol: proto, action, reporter: "dst",
      bytesIn: Math.round(kbIn * 1024 * jitter), bytesOut: Math.round(kbOut * 1024 * jitter),
      packetsIn: Math.round(kbIn * jitter), packetsOut: Math.round(kbOut * jitter),
      connections: { started: Math.round(kbIn / 20 + 1), completed: Math.round(kbIn / 22 + 1), live: action === "Allow" ? Math.round(Math.random() * 4) : 0 },
      policies: {
        enforced: [action === "Deny"
          ? { kind: "NetworkPolicy", namespace: dns, name: "default-deny", tier: "default", action: "Deny" as ActionType }
          : action === "Pass"
            ? { kind: "GlobalNetworkPolicy", namespace: "", name: "tier-pass", tier: "security", action: "Pass" as ActionType }
            : { kind: "NetworkPolicy", namespace: dns, name: `allow-${svc || "ingress"}`, tier: "default", action: "Allow" as ActionType }],
        pending: [],
      },
    };
  });
  return {
    namespaces: ["frontend", "backend", "database", "monitoring", "kube-system", "ingress-nginx", "argocd", "net"],
    flows,
  };
}
