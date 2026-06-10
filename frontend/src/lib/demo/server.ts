// In-browser "server" for the calico-ui demo: serves namespaces, flows, and the
// service graph (built from the seeded flows) over the mocked fetch.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDB } from "./db";

const realFetch = window.fetch.bind(window);
const db = () => getDB() as any;

function buildGraph(mode: string, focusNs?: string, opts?: { crossNamespaceOnly?: boolean; actions?: string[] }) {
  let flows: any[] = db().flows;
  if (opts?.actions?.length) flows = flows.filter((f) => opts.actions!.includes(f.action));
  if (mode !== "namespace-overview" && focusNs) flows = flows.filter((f) => f.source.namespace === focusNs || f.destination.namespace === focusNs);
  if (opts?.crossNamespaceOnly) flows = flows.filter((f) => f.source.namespace !== f.destination.namespace);

  const byNs = mode === "namespace-overview";
  const nodeId = (e: any) => (byNs ? e.namespace : `${e.namespace}/${e.name}`);
  const nodes = new Map<string, any>();
  const ensure = (e: any) => {
    const idv = nodeId(e);
    if (!nodes.has(idv)) nodes.set(idv, { id: idv, name: byNs ? e.namespace : e.name, displayName: byNs ? e.namespace : e.name, subtitle: byNs ? undefined : e.namespace, namespace: e.namespace, kind: e.namespace === "net" ? "net" : byNs ? "namespace" : e.kind, external: e.namespace === "net", bytesIn: 0, bytesOut: 0, connections: 0, allowed: 0, denied: 0, passed: 0 });
    return nodes.get(idv);
  };
  const edges = new Map<string, any>();
  for (const f of flows) {
    const s = ensure(f.source), d = ensure(f.destination);
    s.bytesOut += f.bytesOut; s.connections += f.connections.started; d.bytesIn += f.bytesIn;
    for (const n of [s, d]) { if (f.action === "Allow") n.allowed++; else if (f.action === "Deny") n.denied++; else n.passed++; }
    const eid = `${nodeId(f.source)}->${nodeId(f.destination)}:${f.destination.port || 0}:${f.action}`;
    if (!edges.has(eid)) edges.set(eid, { id: eid, sourceId: nodeId(f.source), targetId: nodeId(f.destination), protocol: f.protocol, port: f.destination.port || 0, action: f.action, crossNamespace: f.source.namespace !== f.destination.namespace, bytesIn: 0, bytesOut: 0, connections: 0 });
    const e = edges.get(eid); e.bytesIn += f.bytesIn; e.bytesOut += f.bytesOut; e.connections += f.connections.started;
  }
  const nodeArr = [...nodes.values()], edgeArr = [...edges.values()];
  return { nodes: nodeArr, edges: edgeArr, meta: { mode, focusNamespace: focusNs, crossNamespaceOnly: !!opts?.crossNamespaceOnly, aggregated: byNs, truncated: false, totalNodes: nodeArr.length, totalEdges: edgeArr.length } };
}

function route(path: string, params: URLSearchParams, method: string): any {
  const actions = params.get("actions")?.split(",").filter(Boolean);
  const crossNamespaceOnly = params.get("crossNamespaceOnly") === "true";
  if (path === "/auth/status") return { enabled: false, authenticated: true, username: "demo", allowedNamespaces: db().namespaces };
  if (path === "/auth/login") return { enabled: false, authenticated: true, username: "demo" };
  if (path === "/auth/logout") return {};
  if (path === "/runtime/status") return { ready: true, mode: "demo", message: "In-browser demo — flows are simulated", inCluster: false, connectionSource: "demo" };
  if (path === "/namespaces") return db().namespaces.filter((n: string) => n !== "net");
  if (path === "/flows") {
    const ns = params.get("namespace"); const page = Number(params.get("page")) || 1; const pageSize = Number(params.get("pageSize")) || 100;
    let flows = db().flows;
    if (ns && ns !== "all" && ns !== "__all__") flows = flows.filter((f: any) => f.source.namespace === ns || f.destination.namespace === ns);
    if (actions?.length) flows = flows.filter((f: any) => actions.includes(f.action));
    const total = flows.length;
    return { flows: flows.slice((page - 1) * pageSize, page * pageSize), totalResults: total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }
  if (path === "/graph/namespaces") return buildGraph("namespace-overview", undefined, { crossNamespaceOnly, actions });
  if (path === "/graph/service") return buildGraph("service-route", params.get("namespace") || undefined, { crossNamespaceOnly, actions });
  if (path === "/graph" ) return buildGraph("namespace-service", params.get("namespace") || undefined, { crossNamespaceOnly, actions });
  const m = path.match(/^\/graph\/namespace\/(.+)$/);
  if (m) return buildGraph("namespace-service", decodeURIComponent(m[1]), { crossNamespaceOnly, actions });
  return method === "GET" ? [] : { ok: true };
}

export async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method || (typeof input !== "string" && !(input instanceof URL) ? (input as Request).method : "GET") || "GET").toUpperCase();
  const u = new URL(raw, location.origin);
  const i = u.pathname.indexOf("/api/v1");
  if (i < 0) return realFetch(input, init);
  const path = u.pathname.slice(i + "/api/v1".length) || "/";
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
  let out: any; try { out = route(path, u.searchParams, method); } catch (e) { return json({ error: String(e) }, 500); }
  return json(out, 200);
}
function json(d: any, status: number) { return new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } }); }
