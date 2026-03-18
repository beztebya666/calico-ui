export type ActionType = 'Allow' | 'Deny' | 'Pass';
export type ReporterType = 'src' | 'dst';
export type EndpointKind = 'wep' | 'hep' | 'ns' | 'net' | 'external' | 'namespace' | string;

export interface Endpoint {
  name: string;
  namespace: string;
  kind: EndpointKind;
  labels: string[];
  port?: number;
  serviceName?: string;
  serviceNamespace?: string;
}

export interface ConnectionStats {
  started: number;
  completed: number;
  live: number;
}

export interface PolicyHitInfo {
  kind: string;
  namespace: string;
  name: string;
  tier: string;
  action: ActionType;
}

export interface PolicyInfo {
  enforced: PolicyHitInfo[];
  pending: PolicyHitInfo[];
}

export interface Flow {
  id: number;
  key: string;
  startTime: number;
  endTime: number;
  routeDepth?: number;
  source: Endpoint;
  destination: Endpoint;
  protocol: string;
  action: ActionType;
  reporter: ReporterType;
  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  packetsOut: number;
  connections: ConnectionStats;
  policies: PolicyInfo;
}

export interface ServiceNode {
  id: string;
  name: string;
  displayName?: string;
  subtitle?: string;
  namespace: string;
  kind: EndpointKind;
  external?: boolean;
  bytesIn: number;
  bytesOut: number;
  connections: number;
  allowed: number;
  denied: number;
  passed: number;
}

export interface ServiceEdge {
  id: string;
  sourceId: string;
  targetId: string;
  protocol: string;
  port: number;
  action: ActionType;
  crossNamespace: boolean;
  bytesIn: number;
  bytesOut: number;
  connections: number;
}

export interface GraphMeta {
  mode: 'namespace-overview' | 'namespace-service' | 'service-route' | string;
  focusNamespace?: string;
  focusNodeId?: string;
  focusNodeName?: string;
  depth?: number;
  crossNamespaceOnly?: boolean;
  aggregated?: boolean;
  truncated?: boolean;
  totalNodes: number;
  totalEdges: number;
}

export interface ServiceGraph {
  nodes: ServiceNode[];
  edges: ServiceEdge[];
  meta: GraphMeta;
}

export interface FlowFilter {
  sourceNamespaces?: string[];
  sourceNames?: string[];
  destNamespaces?: string[];
  destNames?: string[];
  protocols?: string[];
  destPorts?: number[];
  actions?: ActionType[];
  reporter?: ReporterType;
}

export interface FlowsResponse {
  flows: Flow[];
  totalResults: number;
  totalPages: number;
}
