import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import * as d3 from 'd3';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Maximize2,
  Minus,
  Network,
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { ALL_NAMESPACES, useFlowStore } from '../../stores/flowStore';
import { ActionType, ServiceEdge, ServiceGraph, ServiceNode } from '../../types/flow';
import { cleanLabel, formatNodeSubtitle, formatNodeTitle } from '../../utils/labels';

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  data: ServiceNode;
  radius: number;
  clusterX?: number;
  clusterY?: number;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  data: ServiceEdge;
}

const ACTION_COLORS: Record<ActionType, string> = {
  Allow: '#3fb68b',
  Deny: '#f85149',
  Pass: '#d29922',
};

const KIND_COLORS: Record<string, string> = {
  namespace: '#8b9dff',
  wep: '#58a6ff',
  hep: '#bc8cff',
  ns: '#f0883e',
  net: '#8b949e',
  external: '#8b949e',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function truncateLabel(label: string, max = 32) {
  if (label.length <= max) return label;
  if (max <= 3) return label.slice(0, max);
  return `${label.slice(0, max - 3)}...`;
}

function getNodeRadius(node: ServiceNode) {
  const base = node.kind === 'namespace' ? 24 : 18;
  const traffic = Math.log2((node.bytesIn + node.bytesOut) / 2048 + 1);
  const weight = Math.log2(node.connections + 1);
  return Math.max(base, Math.min(52, base + traffic * 2 + weight * 2));
}

function describeMode(mode?: string) {
  switch (mode) {
    case 'namespace-overview':
      return {
        title: 'Namespace Overview',
        detail: 'Aggregated namespace to namespace traffic. Click a namespace to drill into services.',
      };
    case 'service-route':
      return {
        title: 'Route View',
        detail: 'Expanded neighborhood around the selected service. The focus node is highlighted without collapsing the rest of the route.',
      };
    case 'namespace-service':
      return {
        title: 'Namespace Services',
        detail: 'Service level traffic for the selected namespace. Click a node to expand the route around it.',
      };
    default:
      return {
        title: 'Service Map',
        detail: 'No graph metadata available.',
      };
  }
}

function createGraphSignature(graph: ServiceGraph | null) {
  if (!graph) {
    return '';
  }

  const nodeIds = graph.nodes.map((node) => node.id).sort();
  const edgeIds = graph.edges.map((edge) => edge.id).sort();
  return `${graph.meta.mode}|${graph.meta.focusNodeId || ''}|${nodeIds.join(',')}|${edgeIds.join(',')}`;
}

function buildConnectedComponents(nodes: SimNode[], edges: ServiceEdge[]) {
  const adjacency = new Map<string, Set<string>>();
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of edges) {
    if (!adjacency.has(edge.sourceId) || !adjacency.has(edge.targetId)) {
      continue;
    }
    adjacency.get(edge.sourceId)!.add(edge.targetId);
    adjacency.get(edge.targetId)!.add(edge.sourceId);
  }

  const visited = new Set<string>();
  const components: SimNode[][] = [];

  for (const node of nodes) {
    if (visited.has(node.id)) {
      continue;
    }

    const queue = [node.id];
    const component: SimNode[] = [];
    visited.add(node.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentNode = nodeMap.get(current);
      if (currentNode) {
        component.push(currentNode);
      }

      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) {
          continue;
        }
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

function seedNodePositions(
  nodes: SimNode[],
  edges: ServiceEdge[],
  dims: { w: number; h: number },
  focusNodeId: string | null,
  spacingMult: number,
) {
  const components = buildConnectedComponents(nodes, edges);
  const cols = Math.max(1, Math.ceil(Math.sqrt(components.length)));
  const componentGap = Math.min(Math.max(240, Math.min(dims.w, dims.h) * 0.28), 420) * Math.max(0.75, spacingMult);

  components.forEach((component, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const gridWidth = (Math.min(cols, components.length) - 1) * componentGap;
    const gridHeight = (Math.ceil(components.length / cols) - 1) * componentGap;
    const centerX = dims.w / 2 + col * componentGap - gridWidth / 2;
    const centerY = dims.h / 2 + row * componentGap - gridHeight / 2;

    const ordered = [...component].sort((left, right) => {
      if (left.id === focusNodeId) {
        return -1;
      }
      if (right.id === focusNodeId) {
        return 1;
      }
      return left.id.localeCompare(right.id);
    });

    if (ordered.length === 1) {
      ordered[0].x = centerX;
      ordered[0].y = centerY;
      ordered[0].clusterX = centerX;
      ordered[0].clusterY = centerY;
      return;
    }

    const orbitRadius = Math.max(48, Math.min(100 + ordered.length * 10, 180)) * Math.max(0.7, spacingMult);
    const ringMembers = ordered[0].id === focusNodeId ? ordered.slice(1) : ordered;

    if (ordered[0].id === focusNodeId) {
      ordered[0].x = centerX;
      ordered[0].y = centerY;
      ordered[0].clusterX = centerX;
      ordered[0].clusterY = centerY;
    }

    ringMembers.forEach((node, memberIndex) => {
      const angle = (-Math.PI / 2) + (memberIndex / Math.max(1, ringMembers.length)) * Math.PI * 2;
      node.x = centerX + Math.cos(angle) * orbitRadius;
      node.y = centerY + Math.sin(angle) * orbitRadius;
      node.clusterX = centerX;
      node.clusterY = centerY;
    });
  });
}

/**
 * Find the point on a quadratic bezier curve at parameter t.
 */
function bezierPoint(t: number, p0x: number, p0y: number, cpx: number, cpy: number, p1x: number, p1y: number) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0x + 2 * mt * t * cpx + t * t * p1x,
    y: mt * mt * p0y + 2 * mt * t * cpy + t * t * p1y,
  };
}

/**
 * Find the bezier parameter t where the curve exits a circle of given radius
 * centered at the node. Walks from the node end toward the other end.
 */
function findEdgeT(
  nodeX: number, nodeY: number, radius: number,
  p0x: number, p0y: number, cpx: number, cpy: number, p1x: number, p1y: number,
  nodeIsP1: boolean,
): number {
  const steps = 50;
  for (let i = 0; i <= steps; i++) {
    const rawT = i / steps;
    const t = nodeIsP1 ? 1 - rawT : rawT;
    const pt = bezierPoint(t, p0x, p0y, cpx, cpy, p1x, p1y);
    const dx = pt.x - nodeX;
    const dy = pt.y - nodeY;
    if (dx * dx + dy * dy >= radius * radius) {
      return t;
    }
  }
  return nodeIsP1 ? 0 : 1;
}

export const ServiceMap: React.FC = () => {
  const {
    graph,
    selectedNamespace,
    selectedNodeId,
    crossNamespaceOnly,
    routeDepth,
    graphError,
    setSelectedNode,
    clearSelectedNode,
    drillIntoNamespace,
    goToOverview,
    toggleCrossNamespaceOnly,
    setRouteDepth,
  } = useFlowStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const transformRef = useRef(d3.zoomIdentity);
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const rafRef = useRef(0);
  const dragNodeRef = useRef<SimNode | null>(null);
  const prevDimsRef = useRef<{ w: number; h: number } | null>(null);
  const layoutStateRef = useRef<{ graphKey: string; spacing: number } | null>(null);

  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hovered, setHovered] = useState<{ node: SimNode; x: number; y: number } | null>(null);
  const [nodeSearch, setNodeSearch] = useState('');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [edgeScale, setEdgeScale] = useState(1.0);
  const [spacingMult, setSpacingMult] = useState(1.0);
  const [nodeScale, setNodeScale] = useState(1.0);

  const graphMode = graph?.meta.mode ?? (selectedNamespace === ALL_NAMESPACES ? 'namespace-overview' : 'namespace-service');
  const modeCopy = describeMode(graphMode);
  const focusNodeId = graph?.meta.focusNodeId || selectedNodeId;
  const focusNodeName = graph?.meta.focusNodeName || null;
  const isRouteMode = graphMode === 'service-route';
  const isOverviewMode = graphMode === 'namespace-overview';
  const isNamespaceMode = graphMode === 'namespace-service';

  const searchResults = useMemo(() => {
    if (!graph || !nodeSearch.trim()) {
      return [];
    }

    const query = nodeSearch.trim().toLowerCase();
    return graph.nodes
      .filter((node) => {
        const haystacks = [
          formatNodeTitle(node),
          node.name,
          node.namespace,
          formatNodeSubtitle(node),
        ];
        return haystacks.some((value) => value.toLowerCase().includes(query));
      })
      .slice(0, 8);
  }, [graph, nodeSearch]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDims({ w: width, h: height });
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dims.w) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = dims.w * dpr;
    canvas.height = dims.h * dpr;
    canvas.style.width = `${dims.w}px`;
    canvas.style.height = `${dims.h}px`;
  }, [dims]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const transform = transformRef.current;
    const now = performance.now();

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const nodes = nodesRef.current;
    const links = linksRef.current;

    // Highlight only the hovered node and its incident paths.
    const hovId = hovered?.node.id ?? null;
    const connectedIds = new Set<string>();
    if (hovId) {
      connectedIds.add(hovId);
      for (const link of links) {
        const src = (link.source as SimNode).id;
        const tgt = (link.target as SimNode).id;
        if (src === hovId || tgt === hovId) {
          connectedIds.add(src);
          connectedIds.add(tgt);
        }
      }
    }

    for (const link of links) {
      const source = link.source as SimNode;
      const target = link.target as SimNode;
      if (source.x == null || source.y == null || target.x == null || target.y == null) {
        continue;
      }

      const isConnected = !hovId || source.id === hovId || target.id === hovId;

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const offset = dist * 0.12;
      const mx = (source.x + target.x) / 2 + (-dy / dist) * offset;
      const my = (source.y + target.y) / 2 + (dx / dist) * offset;
      const baseWidth = Math.max(1.2, Math.min(5, Math.log2(link.data.connections + 1) * 1.1));
      const lineWidth = Math.max(0.8, Math.min(12, baseWidth * edgeScale));
      const color = ACTION_COLORS[link.data.action] || '#8b949e';

      const sourceRadius = source.radius * nodeScale;
      const targetRadius = target.radius * nodeScale;
      const tSrc = findEdgeT(source.x, source.y, sourceRadius + 2, source.x, source.y, mx, my, target.x, target.y, false);
      const tTgt = findEdgeT(target.x, target.y, targetRadius + 2, source.x, source.y, mx, my, target.x, target.y, true);

      const srcPt = bezierPoint(tSrc, source.x, source.y, mx, my, target.x, target.y);
      const tgtPt = bezierPoint(tTgt, source.x, source.y, mx, my, target.x, target.y);
      const dtx = 2 * (1 - tTgt) * (mx - source.x) + 2 * tTgt * (target.x - mx);
      const dty = 2 * (1 - tTgt) * (my - source.y) + 2 * tTgt * (target.y - my);
      const tangentLength = Math.sqrt(dtx * dtx + dty * dty) || 1;
      const ux = dtx / tangentLength;
      const uy = dty / tangentLength;
      const arrowLen = Math.max(10, lineWidth * 2.4);
      const arrowWidth = Math.max(4, lineWidth * 1.1);
      const arrowBase = {
        x: tgtPt.x - ux * arrowLen,
        y: tgtPt.y - uy * arrowLen,
      };

      ctx.globalAlpha = isConnected
        ? (isRouteMode ? 0.85 : link.data.crossNamespace ? 0.88 : 0.7)
        : 0.08;

      ctx.beginPath();
      ctx.moveTo(srcPt.x, srcPt.y);
      ctx.quadraticCurveTo(mx, my, arrowBase.x, arrowBase.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(tgtPt.x, tgtPt.y);
      ctx.lineTo(arrowBase.x - uy * arrowWidth, arrowBase.y + ux * arrowWidth);
      ctx.lineTo(arrowBase.x + uy * arrowWidth, arrowBase.y - ux * arrowWidth);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      // Animated flow particle
      if (link.data.connections > 0 && isConnected) {
        const speed = 0.00035;
        const position = ((now * speed) % 1 + 1) % 1;
        const pt = bezierPoint(position, srcPt.x, srcPt.y, mx, my, tgtPt.x, tgtPt.y);
        const particleR = Math.max(2, Math.min(4, lineWidth * 0.5));
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, particleR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
    }

    for (const node of nodes) {
      if (node.x == null || node.y == null) {
        continue;
      }

      const radius = node.radius * nodeScale;
      const color = KIND_COLORS[node.data.kind] || '#58a6ff';
      const isFocused = focusNodeId === node.id;
      const isNodeHovered = hovId === node.id;
      const isHighlighted = !hovId || connectedIds.has(node.id);

      if (isFocused || isNodeHovered) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 10, 0, Math.PI * 2);
        ctx.fillStyle = isFocused ? 'rgba(63, 182, 139, 0.16)' : 'rgba(88, 166, 255, 0.14)';
        ctx.fill();
      }

      ctx.globalAlpha = isHighlighted ? 1 : 0.15;

      const gradient = ctx.createRadialGradient(
        node.x - radius * 0.3,
        node.y - radius * 0.3,
        0,
        node.x,
        node.y,
        radius,
      );
      gradient.addColorStop(0, `${color}dd`);
      gradient.addColorStop(1, `${color}88`);

      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();

      ctx.strokeStyle = isFocused ? '#3fb68b' : '#30363d';
      ctx.lineWidth = isFocused ? 3 : 1.5;
      ctx.stroke();

      if (node.data.denied > 0) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#f8514977';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const title = truncateLabel(
        formatNodeTitle(node.data),
        node.data.kind === 'namespace' ? 26 : 28,
      );
      const subtitle = truncateLabel(formatNodeSubtitle(node.data), 30);

      ctx.textAlign = 'center';
      ctx.fillStyle = isHighlighted ? '#e6edf3' : '#e6edf340';
      ctx.font = "600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textBaseline = 'top';
      ctx.fillText(title, node.x, node.y + radius + 8);

      ctx.fillStyle = isHighlighted ? (node.data.external ? '#9aa4b1' : '#8b949e') : '#8b949e30';
      ctx.font = "400 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.fillText(subtitle, node.x, node.y + radius + 22);

      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }, [focusNodeId, hovered?.node.id, isRouteMode, edgeScale, nodeScale]);

  useEffect(() => {
    let running = true;

    const tick = () => {
      if (!running) return;
      render();
      rafRef.current = window.requestAnimationFrame(tick);
    };

    tick();

    return () => {
      running = false;
      window.cancelAnimationFrame(rafRef.current);
    };
  }, [render]);

  const fitToContent = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !zoomRef.current || !dims.w || !dims.h) return;

    const nodes = nodesRef.current;
    if (nodes.length === 0) return;

    setTimeout(() => {
      const validNodes = nodes.filter((n) => n.x != null && n.y != null);
      if (validNodes.length === 0) return;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const node of validNodes) {
        const r = node.radius + 40;
        minX = Math.min(minX, node.x! - r);
        maxX = Math.max(maxX, node.x! + r);
        minY = Math.min(minY, node.y! - r);
        maxY = Math.max(maxY, node.y! + r);
      }

      const graphW = maxX - minX;
      const graphH = maxY - minY;
      if (graphW <= 0 || graphH <= 0) return;

      const padding = 60;
      const scaleX = (dims.w - padding * 2) / graphW;
      const scaleY = (dims.h - padding * 2) / graphH;
      const scale = Math.min(scaleX, scaleY, 1.5);
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      const transform = d3.zoomIdentity
        .translate(dims.w / 2, dims.h / 2)
        .scale(scale)
        .translate(-centerX, -centerY);

      d3.select(canvas)
        .transition()
        .duration(600)
        .call(zoomRef.current!.transform, transform);
    }, 800);
  }, [dims]);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      nodesRef.current = [];
      linksRef.current = [];
      simRef.current?.stop();
      simRef.current = null;
      prevDimsRef.current = dims;
      layoutStateRef.current = null;
      setHovered(null);
      return;
    }

    if (!dims.w) return;

    const graphKey = createGraphSignature(graph);
    const previousDims = prevDimsRef.current;
    const shiftX = previousDims ? (dims.w - previousDims.w) / 2 : 0;
    const shiftY = previousDims ? (dims.h - previousDims.h) / 2 : 0;
    const lastLayout = layoutStateRef.current;
    const canReusePositions =
      !!lastLayout &&
      lastLayout.graphKey === graphKey &&
      Math.abs(lastLayout.spacing - spacingMult) < 0.0001;

    const oldPositions = new Map<string, { x: number; y: number }>();
    for (const node of nodesRef.current) {
      if (node.x != null && node.y != null) {
        oldPositions.set(node.id, { x: node.x, y: node.y });
      }
    }

    const simNodes: SimNode[] = graph.nodes.map((node) => {
      const previous = oldPositions.get(node.id);
      const nextX = canReusePositions && previous ? previous.x + shiftX : dims.w / 2;
      const nextY = canReusePositions && previous ? previous.y + shiftY : dims.h / 2;
      return {
        id: node.id,
        data: node,
        radius: getNodeRadius(node),
        x: nextX,
        y: nextY,
        clusterX: nextX,
        clusterY: nextY,
      };
    });

    const nodeMap = new Map(simNodes.map((node) => [node.id, node]));
    const simLinks: SimLink[] = graph.edges
      .filter((edge) => nodeMap.has(edge.sourceId) && nodeMap.has(edge.targetId))
      .map((edge) => ({
        source: nodeMap.get(edge.sourceId)!,
        target: nodeMap.get(edge.targetId)!,
        data: edge,
      }));

    if (!canReusePositions) {
      seedNodePositions(simNodes, graph.edges, dims, focusNodeId, spacingMult);
    }

    nodesRef.current = simNodes;
    linksRef.current = simLinks;

    simRef.current?.stop();

    // Scale spacing based on node count and user spacing multiplier
    const nodeCount = simNodes.length;
    const autoScale = nodeCount > 30 ? 1.8 : nodeCount > 20 ? 1.5 : nodeCount > 10 ? 1.25 : 1.0;
    const spacingScale = autoScale * spacingMult;
    const linkDistance = (isOverviewMode ? 260 : isRouteMode ? 220 : 200) * spacingScale;
    const charge = (isOverviewMode ? -1200 : isRouteMode ? -1000 : -800) * spacingScale;

    const simulation = d3.forceSimulation(simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks).id((node) => node.id).distance(linkDistance).strength(0.3))
      .force('charge', d3.forceManyBody<SimNode>().strength(charge).distanceMax(1200 * spacingScale))
      .force('center', d3.forceCenter(dims.w / 2, dims.h / 2).strength(0.05))
      .force('x', d3.forceX<SimNode>((node) => node.clusterX ?? dims.w / 2).strength(isRouteMode ? 0.07 : 0.05))
      .force('y', d3.forceY<SimNode>((node) => node.clusterY ?? dims.h / 2).strength(isRouteMode ? 0.07 : 0.05))
      .force('collision', d3.forceCollide<SimNode>().radius((node) => node.radius + 50 * spacingScale).strength(0.9))
      .alphaDecay(0.018)
      .velocityDecay(0.32);

    if (focusNodeId) {
      const focusNode = simNodes.find((node) => node.id === focusNodeId);
      if (focusNode) {
        focusNode.fx = focusNode.x ?? dims.w / 2;
        focusNode.fy = focusNode.y ?? dims.h / 2;
      }
    }

    simRef.current = simulation;
    prevDimsRef.current = dims;
    layoutStateRef.current = { graphKey, spacing: spacingMult };

    fitToContent();
  }, [graph, dims, focusNodeId, isOverviewMode, isRouteMode, fitToContent, spacingMult]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dims.w) return;

    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.08, 8])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
      });

    zoomRef.current = zoom;
    const selection = d3.select(canvas);
    selection.call(zoom);

    const hitNode = (mouseX: number, mouseY: number) => {
      const transform = transformRef.current;
      const x = (mouseX - transform.x) / transform.k;
      const y = (mouseY - transform.y) / transform.k;

      for (let index = nodesRef.current.length - 1; index >= 0; index -= 1) {
        const node = nodesRef.current[index];
        if (node.x == null || node.y == null) continue;
        const ndx = x - node.x;
        const ndy = y - node.y;
        if (ndx * ndx + ndy * ndy < (node.radius + 4) * (node.radius + 4)) {
          return node;
        }
      }

      return null;
    };

    const handleMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const node = hitNode(event.clientX - rect.left, event.clientY - rect.top);

      if (node) {
        canvas.style.cursor = 'pointer';
        setHovered({
          node,
          x: event.clientX - rect.left + 16,
          y: event.clientY - rect.top - 10,
        });
      } else {
        canvas.style.cursor = dragNodeRef.current ? 'grabbing' : 'default';
        setHovered(null);
      }

      if (!dragNodeRef.current) {
        return;
      }

      const transform = transformRef.current;
      dragNodeRef.current.fx = (event.clientX - rect.left - transform.x) / transform.k;
      dragNodeRef.current.fy = (event.clientY - rect.top - transform.y) / transform.k;
      simRef.current?.alpha(0.16).restart();
    };

    const handleMouseDown = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const node = hitNode(event.clientX - rect.left, event.clientY - rect.top);
      if (!node) {
        return;
      }

      dragNodeRef.current = node;
      node.fx = node.x;
      node.fy = node.y;
      selection.on('.zoom', null);
    };

    const handleMouseUp = () => {
      if (!dragNodeRef.current) {
        return;
      }

      dragNodeRef.current.fx = null;
      dragNodeRef.current.fy = null;
      dragNodeRef.current = null;
      selection.call(zoom);
    };

    const handleClick = (event: MouseEvent) => {
      if (dragNodeRef.current) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const node = hitNode(event.clientX - rect.left, event.clientY - rect.top);
      if (!node) {
        return;
      }

      if (isOverviewMode) {
        if (node.data.kind === 'namespace' && node.data.namespace !== '-' && node.data.name !== 'Unspecified') {
          drillIntoNamespace(node.data.name);
        }
        return;
      }

      if (isRouteMode && focusNodeId === node.id) {
        clearSelectedNode();
        return;
      }

      setSelectedNode(node.id);
    };

    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('click', handleClick);

    return () => {
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('click', handleClick);
    };
  }, [
    dims,
    clearSelectedNode,
    drillIntoNamespace,
    focusNodeId,
    isOverviewMode,
    isRouteMode,
    setSelectedNode,
  ]);

  const zoomTo = useCallback((scale: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !zoomRef.current) {
      return;
    }
    d3.select(canvas).transition().duration(250).call(zoomRef.current.scaleTo, scale);
  }, []);

  const resetZoom = useCallback(() => {
    fitToContent();
  }, [fitToContent]);

  const selectSearchResult = useCallback((node: ServiceNode) => {
    setNodeSearch('');
    if (isOverviewMode) {
      if (node.kind === 'namespace' && node.namespace !== '-' && node.name !== 'Unspecified') {
        drillIntoNamespace(node.name);
      }
      return;
    }
    setSelectedNode(node.id);
  }, [drillIntoNamespace, isOverviewMode, setSelectedNode]);

  const isEmpty = !graph || graph.nodes.length === 0;

  return (
    <div className="service-map" ref={containerRef}>
      <canvas ref={canvasRef} className="service-map__canvas" />

      {panelCollapsed ? (
        <button
          className="service-map__panel-toggle fade-in"
          onClick={() => setPanelCollapsed(false)}
        >
          <ChevronRight size={16} />
          Show context
        </button>
      ) : (
        <div className="service-map__mode-side fade-in">
          <div className="service-map__mode-card">
            <div className="service-map__mode-head">
              <div>
                <div className="service-map__mode-title">{modeCopy.title}</div>
                <div className="service-map__mode-text">{modeCopy.detail}</div>
              </div>
              <div className="service-map__mode-stats">
                <span>{graph?.meta.totalNodes ?? 0} nodes</span>
                <span>{graph?.meta.totalEdges ?? 0} edges</span>
              </div>
            </div>

            <div className="service-map__mode-actions">
              {selectedNamespace !== ALL_NAMESPACES && (
                <button className="service-map__chip" onClick={goToOverview}>
                  <ArrowLeft size={14} /> All Namespaces
                </button>
              )}

              {isRouteMode && (
                <button className="service-map__chip" onClick={clearSelectedNode}>
                  <ArrowLeft size={14} /> Namespace View
                </button>
              )}

              {isNamespaceMode && (
                <span className="service-map__chip service-map__chip--static">
                  <GitBranch size={14} /> Click a node for route mode
                </span>
              )}

              <button
                className={`service-map__chip ${crossNamespaceOnly ? 'service-map__chip--active' : ''}`}
                onClick={toggleCrossNamespaceOnly}
              >
                <ArrowRight size={14} /> {crossNamespaceOnly ? 'Cross-NS only' : 'All Traffic'}
              </button>

              {isRouteMode && (
                <div className="service-map__depth-control">
                  <button className="service-map__chip" onClick={() => setRouteDepth(routeDepth - 1)}>
                    <Minus size={14} />
                  </button>
                  <span>Depth {routeDepth}</span>
                  <button className="service-map__chip" onClick={() => setRouteDepth(routeDepth + 1)}>
                    <ZoomIn size={14} />
                  </button>
                </div>
              )}
            </div>

            {focusNodeName && (
              <div className="service-map__focus-note">
                Focus: <strong>{focusNodeName}</strong>
              </div>
            )}
          </div>

          <button
            className="service-map__mode-collapse"
            onClick={() => setPanelCollapsed(true)}
            title="Hide context"
          >
            <ChevronLeft size={16} />
          </button>
        </div>
      )}

      <div className="service-map__finder fade-in">
        <Search size={14} />
        <input
          placeholder={isOverviewMode ? 'Find a namespace...' : 'Find a service or endpoint...'}
          value={nodeSearch}
          onChange={(event) => setNodeSearch(event.target.value)}
        />
        {searchResults.length > 0 && (
          <div className="service-map__finder-results">
            {searchResults.map((node) => (
              <button
                key={node.id}
                className="service-map__finder-result"
                onClick={() => selectSearchResult(node)}
              >
                <span className="title">{formatNodeTitle(node)}</span>
                <span className="subtitle">{formatNodeSubtitle(node)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {graphError && (
        <div className="service-map__empty">
          <Network size={48} />
          <h3>Graph load failed</h3>
          <p>{graphError}</p>
        </div>
      )}

      {!graphError && isEmpty && (
        <div className="service-map__empty">
          <Network size={48} />
          <h3>{isOverviewMode ? 'No namespaces found' : 'No services found'}</h3>
          <p>
            {isOverviewMode
              ? 'No flow data is available yet for the namespace overview.'
              : 'No flow data is available for the selected scope yet.'}
          </p>
        </div>
      )}

      {hovered && (
        <div
          className="service-map__tooltip fade-in"
          style={{ left: hovered.x, top: hovered.y }}
        >
          <div className="service-map__tooltip-name">{formatNodeTitle(hovered.node.data)}</div>
          <div className="service-map__tooltip-ns">{formatNodeSubtitle(hovered.node.data)}</div>
          {cleanLabel(hovered.node.data.name) &&
            cleanLabel(hovered.node.data.displayName) &&
            cleanLabel(hovered.node.data.displayName) !== cleanLabel(hovered.node.data.name) && (
            <div className="service-map__tooltip-raw">Endpoint: {hovered.node.data.name}</div>
          )}
          <div className="service-map__tooltip-stats">
            <span>Bytes In <span className="value">{formatBytes(hovered.node.data.bytesIn)}</span></span>
            <span>Bytes Out <span className="value">{formatBytes(hovered.node.data.bytesOut)}</span></span>
            <span>Connections <span className="value">{hovered.node.data.connections.toLocaleString()}</span></span>
            <span>Allowed <span className="value">{hovered.node.data.allowed}</span></span>
            <span>Denied <span className="value">{hovered.node.data.denied}</span></span>
            <span>Pass <span className="value">{hovered.node.data.passed}</span></span>
          </div>
        </div>
      )}

      <div className="service-map__legend">
        <div className="service-map__legend-item">
          <div className="service-map__legend-dot" style={{ background: '#3fb68b' }} /> Allow
        </div>
        <div className="service-map__legend-item">
          <div className="service-map__legend-dot" style={{ background: '#f85149' }} /> Deny
        </div>
        <div className="service-map__legend-item">
          <div className="service-map__legend-dot" style={{ background: '#d29922' }} /> Pass
        </div>
      </div>

      <div className="service-map__controls">
        <button className="service-map__ctrl-btn" onClick={() => zoomTo(transformRef.current.k * 1.4)}>
          <ZoomIn size={16} />
        </button>
        <button className="service-map__ctrl-btn" onClick={() => zoomTo(transformRef.current.k / 1.4)}>
          <ZoomOut size={16} />
        </button>
        <button className="service-map__ctrl-btn" onClick={resetZoom} title="Fit to content">
          <Maximize2 size={16} />
        </button>
      </div>

      <div className="service-map__sliders">
        <label className="service-map__slider">
          <span>Thickness</span>
          <input
            type="range"
            min="0.3"
            max="3"
            step="0.1"
            value={edgeScale}
            onChange={(e) => setEdgeScale(parseFloat(e.target.value))}
          />
        </label>
        <label className="service-map__slider">
          <span>Spacing</span>
          <input
            type="range"
            min="0.4"
            max="3"
            step="0.1"
            value={spacingMult}
            onChange={(e) => setSpacingMult(parseFloat(e.target.value))}
          />
        </label>
        <label className="service-map__slider">
          <span>Node size</span>
          <input
            type="range"
            min="0.4"
            max="2.5"
            step="0.1"
            value={nodeScale}
            onChange={(e) => setNodeScale(parseFloat(e.target.value))}
          />
        </label>
      </div>
    </div>
  );
};
