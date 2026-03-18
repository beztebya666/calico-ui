import { Flow, FlowsResponse, ServiceGraph, FlowFilter } from '../types/flow';

// Resolve API base relative to where the app is served (supports sub-path like /calico-ui/)
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
const API = `${BASE}/api/v1`;

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  username?: string;
  allowedNamespaces?: string[];
}

export interface RuntimeStatus {
  ready: boolean;
  mode: string;
  message: string;
  goldmaneAddress?: string;
  serverName?: string;
  kubeconfigPath?: string;
  inCluster: boolean;
  requiresRestart?: boolean;
  instructions?: string[];
  connectionSource?: string;
}

function notifyAuthRequired() {
  window.dispatchEvent(new Event('calico-ui:auth-required'));
}

async function apiFetch(input: string, init?: RequestInit) {
  const response = await fetch(input, {
    credentials: 'same-origin',
    ...init,
  });

  if (response.status === 401) {
    notifyAuthRequired();
  }

  return response;
}

function buildFilterParams(filter?: FlowFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (!filter) return p;
  if (filter.actions?.length) p.set('actions', filter.actions.join(','));
  if (filter.protocols?.length) p.set('protocols', filter.protocols.join(','));
  if (filter.sourceNamespaces?.length) p.set('sourceNamespaces', filter.sourceNamespaces.join(','));
  if (filter.sourceNames?.length) p.set('sourceNames', filter.sourceNames.join(','));
  if (filter.destNamespaces?.length) p.set('destNamespaces', filter.destNamespaces.join(','));
  if (filter.destNames?.length) p.set('destNames', filter.destNames.join(','));
  if (filter.destPorts?.length) p.set('destPorts', filter.destPorts.join(','));
  if (filter.reporter) p.set('reporter', filter.reporter);
  return p;
}

async function ensureOK(res: Response, context: string) {
  if (res.ok) {
    return;
  }

  let detail = '';
  try {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await res.json();
      detail = body?.error || JSON.stringify(body);
    } else {
      detail = (await res.text()).trim();
    }
  } catch {
    detail = '';
  }

  if (res.status === 401) {
    throw new Error('Authentication required');
  }

  throw new Error(detail ? `${context}: ${res.status} ${detail}` : `${context}: ${res.status}`);
}

export interface GraphQueryOptions {
  actions?: string[];
  protocols?: string[];
  crossNamespaceOnly?: boolean;
  seconds?: number;
  depth?: number;
}

export interface FlowQueryOptions {
  nodeId?: string;
  seconds?: number;
  crossNamespaceOnly?: boolean;
}

function buildGraphParams(options?: GraphQueryOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (!options) return params;
  if (options.actions?.length) params.set('actions', options.actions.join(','));
  if (options.protocols?.length) params.set('protocols', options.protocols.join(','));
  if (options.crossNamespaceOnly) params.set('crossNamespaceOnly', 'true');
  if (options.seconds) params.set('seconds', String(options.seconds));
  if (options.depth) params.set('depth', String(options.depth));
  return params;
}

export async function fetchNamespaces(): Promise<string[]> {
  const res = await apiFetch(`${API}/namespaces`);
  await ensureOK(res, 'Failed to fetch namespaces');
  return res.json();
}

export async function fetchFlows(
  namespace: string,
  page = 1,
  pageSize = 100,
  filter?: FlowFilter,
  options?: FlowQueryOptions,
): Promise<FlowsResponse> {
  const p = buildFilterParams(filter);
  p.set('namespace', namespace);
  p.set('page', String(page));
  p.set('pageSize', String(pageSize));
  if (options?.nodeId) p.set('nodeId', options.nodeId);
  if (options?.seconds) p.set('seconds', String(options.seconds));
  if (options?.crossNamespaceOnly) p.set('crossNamespaceOnly', 'true');
  const res = await apiFetch(`${API}/flows?${p}`);
  await ensureOK(res, 'Failed to fetch flows');
  return res.json();
}

export async function fetchGraph(namespace: string, seconds = 300): Promise<ServiceGraph> {
  const p = new URLSearchParams({ namespace, seconds: String(seconds) });
  const res = await apiFetch(`${API}/graph?${p}`);
  await ensureOK(res, 'Failed to fetch graph');
  return res.json();
}

export async function fetchNamespaceOverviewGraph(options?: GraphQueryOptions): Promise<ServiceGraph> {
  const params = buildGraphParams(options);
  const res = await apiFetch(`${API}/graph/namespaces?${params}`);
  await ensureOK(res, 'Failed to fetch namespace overview graph');
  return res.json();
}

export async function fetchNamespaceGraph(namespace: string, options?: GraphQueryOptions): Promise<ServiceGraph> {
  const params = buildGraphParams(options);
  const res = await apiFetch(`${API}/graph/namespace/${encodeURIComponent(namespace)}?${params}`);
  await ensureOK(res, 'Failed to fetch namespace graph');
  return res.json();
}

export async function fetchServiceRouteGraph(
  nodeId: string,
  namespace: string,
  options?: GraphQueryOptions,
): Promise<ServiceGraph> {
  const params = buildGraphParams(options);
  params.set('nodeId', nodeId);
  if (namespace) params.set('namespace', namespace);
  const res = await apiFetch(`${API}/graph/service?${params}`);
  await ensureOK(res, 'Failed to fetch service route graph');
  return res.json();
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await apiFetch(`${API}/auth/status`);
  await ensureOK(res, 'Failed to fetch auth status');
  return res.json();
}

export async function fetchRuntimeStatus(): Promise<RuntimeStatus> {
  const res = await apiFetch(`${API}/runtime/status`);
  await ensureOK(res, 'Failed to fetch runtime status');
  return res.json();
}

export async function login(username: string, password: string): Promise<AuthStatus> {
  const res = await apiFetch(`${API}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  });
  await ensureOK(res, 'Failed to authenticate');
  return res.json();
}

export async function logout(): Promise<void> {
  const res = await apiFetch(`${API}/auth/logout`, {
    method: 'POST',
  });
  await ensureOK(res, 'Failed to sign out');
}

export interface FlowStreamCallbacks {
  onFlow: (flow: Flow) => void;
  onOpen: () => void;
  onClose: () => void;
  onError: (err: Event) => void;
}

export function connectFlowStream(
  namespace: string,
  callbacks: FlowStreamCallbacks,
  options?: GraphQueryOptions & { nodeId?: string },
): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = buildGraphParams(options);
  params.set('namespace', namespace);
  if (options?.nodeId) params.set('nodeId', options.nodeId);
  const ws = new WebSocket(`${proto}://${location.host}${BASE}/api/v1/ws/flows?${params}`);

  ws.onopen = () => callbacks.onOpen();
  ws.onclose = () => callbacks.onClose();
  ws.onerror = (e) => callbacks.onError(e);

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'flow') {
        callbacks.onFlow(msg.data);
      }
    } catch {
      // ignore malformed messages
    }
  };

  return ws;
}
