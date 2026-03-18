import { create } from 'zustand';
import { ActionType, Flow, FlowFilter, ServiceGraph } from '../types/flow';
import * as api from '../api/client';

export type ViewMode = 'split' | 'map' | 'table';
export const ALL_NAMESPACES = '__all__';
export const TIME_WINDOW_OPTIONS = [
  { seconds: 15, label: '15s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
  { seconds: 300, label: '5m' },
  { seconds: 600, label: '10m' },
  { seconds: 900, label: '15m' },
  { seconds: 1800, label: '30m' },
  { seconds: 3600, label: '1h' },
] as const;

const FLOW_PAGE_SIZE = 500;
const DEFAULT_TIME_WINDOW_SECONDS = 900;
const DEFAULT_ROUTE_DEPTH = 3;
const REFRESH_DEBOUNCE_MS = 600;
const RECONNECT_DELAY_MS = 3000;

let refreshTimer: number | null = null;
let reconnectTimer: number | null = null;
let flowRequestToken = 0;
let graphRequestToken = 0;

interface FlowState {
  flows: Flow[];
  graph: ServiceGraph | null;
  namespaces: string[];
  selectedNamespace: string;
  viewMode: ViewMode;
  isConnected: boolean;
  isLoading: boolean;
  searchQuery: string;
  actionFilter: ActionType[];
  protocolFilter: string[];
  crossNamespaceOnly: boolean;
  selectedNodeId: string | null;
  routeDepth: number;
  timeWindowSeconds: number;
  flowError: string | null;
  graphError: string | null;
  ws: WebSocket | null;
}

interface FlowActions {
  clearData: () => void;
  setNamespace: (ns: string) => void;
  goToOverview: () => void;
  setViewMode: (mode: ViewMode) => void;
  setSearchQuery: (q: string) => void;
  toggleAction: (action: ActionType) => void;
  toggleProtocol: (proto: string) => void;
  toggleCrossNamespaceOnly: () => void;
  setSelectedNode: (id: string | null) => void;
  clearSelectedNode: () => void;
  setRouteDepth: (depth: number) => void;
  setTimeWindow: (seconds: number) => void;
  drillIntoNamespace: (ns: string) => void;
  fetchNamespaces: () => Promise<void>;
  fetchFlows: () => Promise<void>;
  fetchGraph: () => Promise<void>;
  refreshData: () => Promise<void>;
  scheduleRefresh: () => void;
  connectStream: () => void;
  disconnectStream: () => void;
}

function clearRefreshTimer() {
  if (refreshTimer != null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer != null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function currentNamespace(state: FlowState) {
  return state.selectedNamespace === ALL_NAMESPACES ? '' : state.selectedNamespace;
}

function currentFlowFilter(state: FlowState): FlowFilter | undefined {
  const filter: FlowFilter = {};
  if (state.actionFilter.length > 0) {
    filter.actions = state.actionFilter;
  }
  if (state.protocolFilter.length > 0) {
    filter.protocols = state.protocolFilter;
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

function currentGraphOptions(state: FlowState) {
  return {
    actions: state.actionFilter,
    protocols: state.protocolFilter,
    crossNamespaceOnly: state.crossNamespaceOnly,
    seconds: state.timeWindowSeconds,
    depth: state.routeDepth,
  };
}

export const useFlowStore = create<FlowState & FlowActions>((set, get) => ({
  flows: [],
  graph: null,
  namespaces: [],
  selectedNamespace: ALL_NAMESPACES,
  viewMode: 'split',
  isConnected: false,
  isLoading: false,
  searchQuery: '',
  actionFilter: [],
  protocolFilter: [],
  crossNamespaceOnly: false,
  selectedNodeId: null,
  routeDepth: DEFAULT_ROUTE_DEPTH,
  timeWindowSeconds: DEFAULT_TIME_WINDOW_SECONDS,
  flowError: null,
  graphError: null,
  ws: null,

  clearData: () => set({
    flows: [],
    graph: null,
    flowError: null,
    graphError: null,
    searchQuery: '',
    isConnected: false,
    isLoading: false,
  }),

  setNamespace: (ns) => {
    const next = ns || ALL_NAMESPACES;
    const state = get();
    if (state.selectedNamespace === next && state.selectedNodeId == null) {
      return;
    }

    set({
      selectedNamespace: next,
      selectedNodeId: null,
      graph: null,
      flows: [],
      searchQuery: '',
      flowError: null,
      graphError: null,
    });

    clearRefreshTimer();
    get().disconnectStream();
    get().refreshData();
    get().connectStream();
  },

  goToOverview: () => get().setNamespace(ALL_NAMESPACES),

  setViewMode: (mode) => set({ viewMode: mode }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  toggleAction: (action) => {
    const current = get().actionFilter;
    const next = current.includes(action)
      ? current.filter((value) => value !== action)
      : [...current, action];
    set({ actionFilter: next });
    clearRefreshTimer();
    get().disconnectStream();
    get().refreshData();
    get().connectStream();
  },

  toggleProtocol: (proto) => {
    const current = get().protocolFilter;
    const next = current.includes(proto)
      ? current.filter((value) => value !== proto)
      : [...current, proto];
    set({ protocolFilter: next });
    clearRefreshTimer();
    get().disconnectStream();
    get().refreshData();
    get().connectStream();
  },

  toggleCrossNamespaceOnly: () => {
    set((state) => ({ crossNamespaceOnly: !state.crossNamespaceOnly }));
    clearRefreshTimer();
    get().refreshData();
  },

  setSelectedNode: (id) => {
    const normalized = id || null;
    if (get().selectedNodeId === normalized) {
      return;
    }

    set({ selectedNodeId: normalized, graph: null, flows: [], flowError: null, graphError: null });
    clearRefreshTimer();
    get().disconnectStream();
    get().refreshData();
    get().connectStream();
  },

  clearSelectedNode: () => {
    if (get().selectedNodeId == null) {
      return;
    }
    set({ selectedNodeId: null, graph: null, flows: [], flowError: null, graphError: null });
    clearRefreshTimer();
    get().disconnectStream();
    get().refreshData();
    get().connectStream();
  },

  setRouteDepth: (depth) => {
    const next = Math.max(1, Math.min(4, depth));
    if (get().routeDepth === next) {
      return;
    }
    set({ routeDepth: next });
    clearRefreshTimer();
    get().refreshData();
  },

  setTimeWindow: (seconds) => {
    const allowed = TIME_WINDOW_OPTIONS.map((option) => option.seconds);
    const next = allowed.includes(seconds as (typeof TIME_WINDOW_OPTIONS)[number]['seconds'])
      ? seconds
      : DEFAULT_TIME_WINDOW_SECONDS;
    if (get().timeWindowSeconds === next) {
      return;
    }
    set({ timeWindowSeconds: next });
    clearRefreshTimer();
    get().disconnectStream();
    get().refreshData();
    get().connectStream();
  },

  drillIntoNamespace: (ns) => {
    if (!ns || ns === '-') {
      return;
    }
    get().setNamespace(ns);
  },

  fetchNamespaces: async () => {
    try {
      const namespaces = await api.fetchNamespaces();
      set({ namespaces: namespaces.sort() });
    } catch {
      // retry on reconnect
    }
  },

  fetchFlows: async () => {
    const state = get();
    const token = ++flowRequestToken;
    set({ isLoading: true, flowError: null });

    try {
      const response = await api.fetchFlows(
        currentNamespace(state),
        1,
        FLOW_PAGE_SIZE,
        currentFlowFilter(state),
        {
          nodeId: state.selectedNodeId ?? undefined,
          seconds: state.timeWindowSeconds,
          crossNamespaceOnly: state.crossNamespaceOnly,
        },
      );

      if (token !== flowRequestToken) {
        return;
      }

      set({ flows: response.flows, isLoading: false, flowError: null });
    } catch (error) {
      if (token === flowRequestToken) {
        set({
          isLoading: false,
          flowError: error instanceof Error ? error.message : 'Failed to load flows',
        });
      }
    }
  },

  fetchGraph: async () => {
    const state = get();
    const token = ++graphRequestToken;
    const options = currentGraphOptions(state);

    try {
      let graph: ServiceGraph;
      if (state.selectedNamespace === ALL_NAMESPACES) {
        graph = await api.fetchNamespaceOverviewGraph(options);
      } else if (state.selectedNodeId) {
        graph = await api.fetchServiceRouteGraph(state.selectedNodeId, state.selectedNamespace, options);
      } else {
        graph = await api.fetchNamespaceGraph(state.selectedNamespace, options);
      }

      if (token !== graphRequestToken) {
        return;
      }

      set({ graph, graphError: null });
    } catch (error) {
      if (token === graphRequestToken) {
        set({
          graph: null,
          graphError: error instanceof Error ? error.message : 'Failed to load graph',
        });
      }
    }
  },

  refreshData: async () => {
    await Promise.allSettled([get().fetchFlows(), get().fetchGraph()]);
  },

  scheduleRefresh: () => {
    clearRefreshTimer();
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      get().refreshData();
    }, REFRESH_DEBOUNCE_MS);
  },

  connectStream: () => {
    const state = get();
    clearReconnectTimer();
    get().disconnectStream();

    const ws = api.connectFlowStream(
      currentNamespace(state),
      {
        onFlow: () => {
          get().scheduleRefresh();
        },
        onOpen: () => set({ isConnected: true }),
        onClose: () => {
          set({ isConnected: false });
          if (get().ws !== ws) {
            return;
          }
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            if (get().ws === ws) {
              get().connectStream();
            }
          }, RECONNECT_DELAY_MS);
        },
        onError: () => {},
      },
      {
        ...currentGraphOptions(state),
        nodeId: state.selectedNodeId ?? undefined,
      },
    );

    set({ ws });
  },

  disconnectStream: () => {
    clearReconnectTimer();
    const ws = get().ws;
    if (!ws) {
      return;
    }
    set({ ws: null, isConnected: false });
    ws.close();
  },
}));
