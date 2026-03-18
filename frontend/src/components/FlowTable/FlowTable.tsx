import React, { useEffect, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from 'lucide-react';
import { ALL_NAMESPACES, TIME_WINDOW_OPTIONS, useFlowStore } from '../../stores/flowStore';
import { ActionType, Endpoint, Flow, ServiceGraph } from '../../types/flow';
import { formatEndpointSubtitle, formatEndpointTitle } from '../../utils/labels';
import {
  formatActionExplanation,
  formatPolicyHit,
  formatPolicySummary,
  formatPolicyTraceDetail,
  formatReporterHint,
  formatReporterLabel,
} from '../../utils/flowDiagnostics';

type SortKey = 'time' | 'source' | 'destination' | 'reporter' | 'protocol' | 'port' | 'action' | 'policy' | 'bytes';
type SortDirection = 'asc' | 'desc';

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('en-GB', { hour12: false });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} G`;
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function compareNumbers(left: number, right: number) {
  return left - right;
}

function normalizeNamespace(namespace?: string) {
  return namespace || '-';
}

function normalizeKind(kind?: string) {
  if (!kind || kind === 'wep') {
    return 'wep';
  }
  if (kind === 'net') {
    return 'external';
  }
  return kind;
}

function endpointNodeId(endpoint: Endpoint) {
  return `${normalizeKind(endpoint.kind)}:${normalizeNamespace(endpoint.namespace)}/${endpoint.name}`;
}

function buildRouteNodeDepths(graph: ServiceGraph | null) {
  const depths = new Map<string, number>();
  if (!graph || graph.meta.mode !== 'service-route' || !graph.meta.focusNodeId) {
    return depths;
  }

  const adjacency = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.sourceId)) {
      adjacency.set(edge.sourceId, new Set());
    }
    if (!adjacency.has(edge.targetId)) {
      adjacency.set(edge.targetId, new Set());
    }
    adjacency.get(edge.sourceId)!.add(edge.targetId);
    adjacency.get(edge.targetId)!.add(edge.sourceId);
  }

  const start = graph.meta.focusNodeId;
  if (!adjacency.has(start)) {
    return depths;
  }

  const queue: string[] = [start];
  depths.set(start, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depths.get(current) ?? 0;

    for (const neighbor of adjacency.get(current) ?? []) {
      if (depths.has(neighbor)) {
        continue;
      }
      depths.set(neighbor, currentDepth + 1);
      queue.push(neighbor);
    }
  }

  return depths;
}

function sortFlowList(flows: Flow[], key: SortKey, direction: SortDirection) {
  const factor = direction === 'asc' ? 1 : -1;
  const sorted = [...flows];

  sorted.sort((left, right) => {
    let result = 0;

    switch (key) {
      case 'time':
        result = compareNumbers(left.startTime, right.startTime);
        break;
      case 'source':
        result = compareStrings(formatEndpointTitle(left.source), formatEndpointTitle(right.source));
        break;
      case 'destination':
        result = compareStrings(formatEndpointTitle(left.destination), formatEndpointTitle(right.destination));
        break;
      case 'reporter':
        result = compareStrings(formatReporterLabel(left.reporter), formatReporterLabel(right.reporter));
        break;
      case 'protocol':
        result = compareStrings(left.protocol, right.protocol);
        break;
      case 'port':
        result = compareNumbers(left.destination.port || 0, right.destination.port || 0);
        break;
      case 'action':
        result = compareStrings(left.action, right.action);
        break;
      case 'policy':
        result = compareStrings(formatPolicySummary(left), formatPolicySummary(right));
        break;
      case 'bytes':
        result = compareNumbers(left.bytesIn + left.bytesOut, right.bytesIn + right.bytesOut);
        break;
      default:
        result = 0;
    }

    if (result === 0) {
      result = compareNumbers(left.startTime, right.startTime);
    }

    return result * factor;
  });

  return sorted;
}

function resolveRouteDepth(flow: Flow, graph: ServiceGraph | null, nodeDepths: Map<string, number>) {
  const sourceDepth = nodeDepths.get(endpointNodeId(flow.source));
  const destinationDepth = nodeDepths.get(endpointNodeId(flow.destination));

  if (sourceDepth != null || destinationDepth != null) {
    return Math.max(1, sourceDepth ?? 0, destinationDepth ?? 0);
  }

  if (flow.routeDepth && flow.routeDepth > 0) {
    return flow.routeDepth;
  }

  return graph?.meta.mode === 'service-route' ? 1 : 0;
}

const SortHeader: React.FC<{
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onToggle: (key: SortKey) => void;
  alignRight?: boolean;
}> = ({ label, sortKey, activeKey, direction, onToggle, alignRight = false }) => {
  const active = sortKey === activeKey;
  const icon = !active ? <ArrowUpDown size={10} /> : direction === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />;

  return (
    <button
      className={`flow-table__header-cell flow-table__header-cell--sortable ${active ? 'flow-table__header-cell--active' : ''} ${alignRight ? 'flow-table__header-cell--align-right' : ''}`}
      onClick={() => onToggle(sortKey)}
    >
      {label} {icon}
    </button>
  );
};

const FlowRow: React.FC<{ flow: Flow; onSelect: (flow: Flow) => void }> = React.memo(({ flow, onSelect }) => {
  const className = `flow-table__row flow-table__row--${flow.action.toLowerCase()}`;
  const policySummary = formatPolicySummary(flow);
  const reporterLabel = formatReporterLabel(flow.reporter);

  return (
    <button className={className} onClick={() => onSelect(flow)} title={formatPolicyTraceDetail(flow)}>
      <div className="flow-table__cell flow-table__cell--time">{formatTime(flow.startTime)}</div>
      <div className="flow-table__cell flow-table__cell--endpoint">
        <span className="name">{formatEndpointTitle(flow.source)}</span>
        <span className="ns">{formatEndpointSubtitle(flow.source)}</span>
      </div>
      <div className="flow-table__cell flow-table__cell--endpoint">
        <span className="name">{formatEndpointTitle(flow.destination)}</span>
        <span className="ns">{formatEndpointSubtitle(flow.destination)}</span>
      </div>
      <div className="flow-table__cell flow-table__cell--reporter">
        <span className={`flow-table__badge flow-table__badge--reporter flow-table__badge--reporter-${flow.reporter || 'unknown'}`}>
          {reporterLabel}
        </span>
      </div>
      <div className="flow-table__cell flow-table__cell--proto">{flow.protocol}</div>
      <div className="flow-table__cell flow-table__cell--port">{flow.destination.port || '-'}</div>
      <div className="flow-table__cell">
        <span className={`flow-table__badge flow-table__badge--${flow.action.toLowerCase()}`}>
          {flow.action}
        </span>
      </div>
      <div className="flow-table__cell flow-table__cell--policy">
        <span className="flow-table__policy-text">{policySummary}</span>
      </div>
      <div className="flow-table__cell flow-table__cell--bytes">
        {formatBytes(flow.bytesIn + flow.bytesOut)}
      </div>
    </button>
  );
});

function modeDescription(mode?: string, focusNodeName?: string) {
  switch (mode) {
    case 'namespace-overview':
      return 'Cluster-wide flows across namespaces.';
    case 'service-route':
      return focusNodeName
        ? `Expanded route around ${focusNodeName}.`
        : 'Expanded service route.';
    case 'namespace-service':
      return 'Service-level flows for the selected namespace.';
    default:
      return 'Flow stream.';
  }
}

const FlowInspector: React.FC<{ flow: Flow; onClose: () => void }> = ({ flow, onClose }) => (
  <div className="flow-inspector">
    <div className="flow-inspector__backdrop" onClick={onClose} />
    <div className="flow-inspector__panel fade-in">
      <div className="flow-inspector__header">
        <div>
          <div className="flow-inspector__eyebrow">Flow inspection</div>
          <div className="flow-inspector__title">{formatEndpointTitle(flow.source)} -&gt; {formatEndpointTitle(flow.destination)}</div>
          <div className="flow-inspector__subtitle">{formatDateTime(flow.startTime)}</div>
        </div>
        <button className="flow-inspector__close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="flow-inspector__content">
        <div className="flow-inspector__section">
          <h3>Decision</h3>
          <div className="flow-inspector__meta">
            <span className={`flow-table__badge flow-table__badge--${flow.action.toLowerCase()}`}>{flow.action}</span>
            <span className={`flow-table__badge flow-table__badge--reporter flow-table__badge--reporter-${flow.reporter || 'unknown'}`}>
              {formatReporterLabel(flow.reporter)}
            </span>
            {flow.routeDepth ? (
              <span className="flow-table__badge flow-table__badge--reporter">Depth {flow.routeDepth}</span>
            ) : null}
          </div>
          <p>{formatActionExplanation(flow.action, flow.reporter)}</p>
          <p>{formatReporterHint(flow.reporter)}</p>
        </div>

        <div className="flow-inspector__grid">
          <div className="flow-inspector__section">
            <h3>Source</h3>
            <dl className="flow-inspector__list">
              <div><dt>Title</dt><dd>{formatEndpointTitle(flow.source)}</dd></div>
              <div><dt>Endpoint</dt><dd>{flow.source.name || 'Not reported'}</dd></div>
              <div><dt>Namespace</dt><dd>{formatEndpointSubtitle(flow.source)}</dd></div>
              <div><dt>Kind</dt><dd>{flow.source.kind || 'Unknown'}</dd></div>
            </dl>
          </div>

          <div className="flow-inspector__section">
            <h3>Destination</h3>
            <dl className="flow-inspector__list">
              <div><dt>Title</dt><dd>{formatEndpointTitle(flow.destination)}</dd></div>
              <div><dt>Endpoint</dt><dd>{flow.destination.name || 'Not reported'}</dd></div>
              <div><dt>Namespace</dt><dd>{formatEndpointSubtitle(flow.destination)}</dd></div>
              <div><dt>Kind</dt><dd>{flow.destination.kind || 'Unknown'}</dd></div>
              <div><dt>Port</dt><dd>{flow.destination.port || 'Not reported'}</dd></div>
            </dl>
          </div>
        </div>

        <div className="flow-inspector__grid">
          <div className="flow-inspector__section">
            <h3>Traffic</h3>
            <dl className="flow-inspector__list">
              <div><dt>Protocol</dt><dd>{flow.protocol}</dd></div>
              <div><dt>Route Depth</dt><dd>{flow.routeDepth || 'Not grouped'}</dd></div>
              <div><dt>Bytes In</dt><dd>{formatBytes(flow.bytesIn)}</dd></div>
              <div><dt>Bytes Out</dt><dd>{formatBytes(flow.bytesOut)}</dd></div>
              <div><dt>Connections Started</dt><dd>{flow.connections.started}</dd></div>
              <div><dt>Connections Live</dt><dd>{flow.connections.live}</dd></div>
              <div><dt>Flow ID</dt><dd>{flow.id}</dd></div>
              <div><dt>Observation Key</dt><dd>{flow.key}</dd></div>
            </dl>
          </div>

          <div className="flow-inspector__section">
            <h3>Policy trace</h3>
            <p>{formatPolicyTraceDetail(flow)}</p>
            <div className="flow-inspector__policy-group">
              <div className="flow-inspector__policy-title">Enforced</div>
              {flow.policies.enforced.length > 0 ? (
                flow.policies.enforced.map((policy, index) => (
                  <div key={`${policy.kind}-${policy.namespace}-${policy.name}-${index}`} className="flow-inspector__policy-hit">
                    <strong>{formatPolicyHit(policy)}</strong>
                    <span>{policy.action} {policy.tier ? `| tier ${policy.tier}` : ''}</span>
                  </div>
                ))
              ) : (
                <div className="flow-inspector__policy-hit flow-inspector__policy-hit--empty">
                  No enforced policy hit reported for this flow.
                </div>
              )}
            </div>

            <div className="flow-inspector__policy-group">
              <div className="flow-inspector__policy-title">Pending</div>
              {flow.policies.pending.length > 0 ? (
                flow.policies.pending.map((policy, index) => (
                  <div key={`${policy.kind}-${policy.namespace}-${policy.name}-${index}`} className="flow-inspector__policy-hit">
                    <strong>{formatPolicyHit(policy)}</strong>
                    <span>{policy.action} {policy.tier ? `| tier ${policy.tier}` : ''}</span>
                  </div>
                ))
              ) : (
                <div className="flow-inspector__policy-hit flow-inspector__policy-hit--empty">
                  No pending policy hit reported for this flow.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
);

export const FlowTable: React.FC = () => {
  const {
    flows,
    graph,
    flowError,
    searchQuery,
    setSearchQuery,
    actionFilter,
    protocolFilter,
    crossNamespaceOnly,
    toggleAction,
    toggleProtocol,
    toggleCrossNamespaceOnly,
    selectedNamespace,
    timeWindowSeconds,
  } = useFlowStore();
  const [selectedFlow, setSelectedFlow] = useState<Flow | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const routeNodeDepths = useMemo(() => buildRouteNodeDepths(graph), [graph]);

  const protocols = useMemo(() => {
    const set = new Set<string>();
    flows.forEach((flow) => set.add(flow.protocol));
    return Array.from(set).sort();
  }, [flows]);

  const flowsWithDepth = useMemo(() => flows.map((flow) => {
    const resolvedDepth = resolveRouteDepth(flow, graph, routeNodeDepths);
    if (!resolvedDepth || flow.routeDepth === resolvedDepth) {
      return flow;
    }
    return { ...flow, routeDepth: resolvedDepth };
  }), [flows, graph, routeNodeDepths]);

  const filtered = useMemo(() => {
    let result = flowsWithDepth;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((flow) => {
        const haystacks = [
          flow.source.name,
          flow.source.serviceName || '',
          flow.source.namespace,
          flow.destination.name,
          flow.destination.serviceName || '',
          flow.destination.namespace,
          formatPolicySummary(flow),
          formatReporterLabel(flow.reporter),
          flow.routeDepth ? `depth ${flow.routeDepth}` : '',
        ];
        return haystacks.some((value) => value.toLowerCase().includes(query));
      });
    }
    return result;
  }, [flowsWithDepth, searchQuery]);

  const sorted = useMemo(() => sortFlowList(filtered, sortKey, sortDirection), [filtered, sortDirection, sortKey]);

  const groupedRouteFlows = useMemo(() => {
    if (graph?.meta.mode !== 'service-route') {
      return [];
    }

    const groups = new Map<number, Flow[]>();
    const requestedDepth = Math.max(1, graph.meta.depth || 1);
    const observedDepth = sorted.reduce((maxDepth, flow) => {
      const depth = resolveRouteDepth(flow, graph, routeNodeDepths);
      return Math.max(maxDepth, depth || 1);
    }, 1);
    const maxDepth = Math.max(requestedDepth, observedDepth);

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      groups.set(depth, []);
    }

    for (const flow of sorted) {
      const depth = resolveRouteDepth(flow, graph, routeNodeDepths);
      const d = Math.max(1, depth);
      if (!groups.has(d)) {
        groups.set(d, []);
      }
      groups.get(d)!.push(flow);
    }

    return Array.from(groups.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([depth, routeFlows]) => ({ depth, flows: routeFlows }));
  }, [graph, routeNodeDepths, sorted]);

  useEffect(() => {
    if (!selectedFlow) {
      return;
    }

    const next = flowsWithDepth.find((flow) => flow.key === selectedFlow.key) ?? null;
    setSelectedFlow(next);
  }, [flowsWithDepth, selectedFlow]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortKey(key);
    setSortDirection(key === 'time' ? 'desc' : 'asc');
  };

  const actions: ActionType[] = ['Allow', 'Deny', 'Pass'];
  const mode = graph?.meta.mode;
  const isRouteMode = mode === 'service-route';
  const windowLabel = TIME_WINDOW_OPTIONS.find((option) => option.seconds === timeWindowSeconds)?.label ?? `${Math.round(timeWindowSeconds / 60)}m`;
  const emptyMessage = selectedNamespace === ALL_NAMESPACES
    ? 'No flows available for the current cluster overview.'
    : 'No flows match the current scope.';

  return (
    <>
      <div className="flow-panel__toolbar">
        <div className="flow-panel__title">
          Flows
          <span className="flow-panel__count">{sorted.length.toLocaleString()}</span>
        </div>

        <div className="flow-panel__scope">
          {modeDescription(mode, graph?.meta.focusNodeName)} Window {windowLabel}.
          {isRouteMode ? ' Grouped by route depth.' : ''}
        </div>

        <div className="flow-panel__filters">
          {actions.map((action) => (
            <button
              key={action}
              className={`flow-panel__filter-btn ${actionFilter.includes(action) ? 'flow-panel__filter-btn--active' : ''}`}
              onClick={() => toggleAction(action)}
            >
              {action}
            </button>
          ))}
          {protocols.map((protocol) => (
            <button
              key={protocol}
              className={`flow-panel__filter-btn ${protocolFilter.includes(protocol) ? 'flow-panel__filter-btn--active' : ''}`}
              onClick={() => toggleProtocol(protocol)}
            >
              {protocol}
            </button>
          ))}
          <button
            className={`flow-panel__filter-btn ${crossNamespaceOnly ? 'flow-panel__filter-btn--active' : ''}`}
            onClick={toggleCrossNamespaceOnly}
          >
            Cross-NS
          </button>
        </div>

        <div className="flow-panel__search">
          <Search size={14} />
          <input
            placeholder="Search flows..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="flow-table__header">
        <SortHeader label="Time" sortKey="time" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
        <SortHeader label="Source" sortKey="source" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
        <SortHeader label="Destination" sortKey="destination" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
        <SortHeader label="Reporter" sortKey="reporter" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
        <SortHeader label="Proto" sortKey="protocol" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
        <SortHeader label="Port" sortKey="port" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
        <SortHeader label="Action" sortKey="action" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
        <SortHeader label="Policy Trace" sortKey="policy" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
        <SortHeader label="Bytes" sortKey="bytes" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} alignRight />
      </div>

      <div className="flow-table">
        {flowError ? (
          <div className="flow-table__empty">{flowError}</div>
        ) : sorted.length === 0 ? (
          <div className="flow-table__empty">{emptyMessage}</div>
        ) : isRouteMode ? (
          <div className="flow-table__scroll">
            {groupedRouteFlows.map((group) => (
              <div key={group.depth} className="flow-table__section">
                <div className="flow-table__section-header">
                  <span className="flow-table__section-title">
                    Depth {group.depth}
                    {group.depth === 1 ? ' - direct neighbors' : group.depth === 2 ? ' - 2 hops away' : ` - ${group.depth} hops away`}
                  </span>
                  <span className="flow-table__section-count">
                    {group.flows.length} {group.flows.length === 1 ? 'flow' : 'flows'}
                  </span>
                </div>
                {group.flows.length > 0 ? group.flows.map((flow) => (
                  <FlowRow key={flow.key} flow={flow} onSelect={setSelectedFlow} />
                )) : (
                  <div className="flow-table__section-empty">
                    No flows observed at this depth in the selected time window. Try increasing the window or depth.
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Virtuoso
            data={sorted}
            itemContent={(_, flow) => <FlowRow flow={flow} onSelect={setSelectedFlow} />}
            style={{ height: '100%' }}
            overscan={50}
          />
        )}
      </div>

      {selectedFlow && <FlowInspector flow={selectedFlow} onClose={() => setSelectedFlow(null)} />}
    </>
  );
};
