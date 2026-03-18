package api

import (
	"context"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	"calico-ui/internal/goldmane"
	"calico-ui/internal/graph"
	"calico-ui/internal/models"
	pb "calico-ui/proto"
)

type cachedFlow struct {
	flow      models.Flow
	updatedAt time.Time
}

type FlowCache struct {
	mu        sync.RWMutex
	flows     map[string]cachedFlow
	retention time.Duration
	stream    cacheStreamState
}

type cacheStreamState struct {
	connected bool
	lastFlow  time.Time
}

func NewFlowCache(retention time.Duration) *FlowCache {
	return &FlowCache{
		flows:     make(map[string]cachedFlow),
		retention: retention,
	}
}

func (c *FlowCache) Upsert(flow models.Flow) {
	c.mu.Lock()
	now := time.Now()
	c.flows[flowKey(flow)] = cachedFlow{flow: flow, updatedAt: now}
	c.stream.lastFlow = now
	c.mu.Unlock()
}

func (c *FlowCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.flows)
}

func (c *FlowCache) Prune(now time.Time) {
	cutoff := now.Add(-c.retention)

	c.mu.Lock()
	for id, item := range c.flows {
		if item.updatedAt.Before(cutoff) {
			delete(c.flows, id)
		}
	}
	c.mu.Unlock()
}

func (c *FlowCache) SetStreamConnected(connected bool) {
	c.mu.Lock()
	c.stream.connected = connected
	c.mu.Unlock()
}

func (c *FlowCache) HasRecentData(maxAge time.Duration) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.stream.lastFlow.IsZero() {
		return false
	}
	return time.Since(c.stream.lastFlow) <= maxAge
}

func (c *FlowCache) Namespaces() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()

	seen := map[string]struct{}{}
	namespaces := make([]string, 0)
	for _, item := range c.flows {
		for _, namespace := range []string{item.flow.Source.Namespace, item.flow.Destination.Namespace} {
			namespace = strings.TrimSpace(namespace)
			if namespace == "" || namespace == "-" {
				continue
			}
			if _, ok := seen[namespace]; ok {
				continue
			}
			seen[namespace] = struct{}{}
			namespaces = append(namespaces, namespace)
		}
	}
	sort.Strings(namespaces)
	return namespaces
}

func (c *FlowCache) Query(seconds int64, predicate func(models.Flow) bool) []models.Flow {
	cutoff := time.Now().Add(-time.Duration(seconds) * time.Second)
	if seconds <= 0 {
		cutoff = time.Time{}
	}

	c.mu.RLock()
	out := make([]models.Flow, 0, len(c.flows))
	for _, item := range c.flows {
		if !cutoff.IsZero() && item.updatedAt.Before(cutoff) {
			continue
		}
		if predicate != nil && !predicate(item.flow) {
			continue
		}
		out = append(out, item.flow)
	}
	c.mu.RUnlock()

	return out
}

func (h *Handler) startCacheStream() {
	if h.client == nil {
		h.logger.Warn("cache stream disabled because Goldmane connection is not configured")
		return
	}

	go h.startCachePruner()

	go func() {
		for {
			ctx, cancel := context.WithCancel(context.Background())
			stream, err := h.client.StreamFlows(ctx, &pb.FlowStreamRequest{
				StartTimeGte:        0,
				AggregationInterval: 15,
			})
			if err != nil {
				h.logger.Error("cache stream connect", "err", err)
				h.cache.SetStreamConnected(false)
				cancel()
				time.Sleep(3 * time.Second)
				continue
			}

			h.logger.Info("cache stream connected")
			h.cache.SetStreamConnected(true)
			firstLogged := false

			for {
				result, recvErr := stream.Recv()
				if recvErr != nil {
					if recvErr != io.EOF {
						h.logger.Error("cache stream recv", "err", recvErr)
					}
					break
				}

				flow := goldmane.ConvertFlowResult(result)
				h.cache.Upsert(flow)

				if !firstLogged {
					firstLogged = true
					h.logger.Info(
						"cache stream received flow",
						"id", flow.ID,
						"source", flow.Source.Name,
						"sourceNamespace", flow.Source.Namespace,
						"destination", flow.Destination.Name,
						"destNamespace", flow.Destination.Namespace,
						"cacheSize", h.cache.Size(),
					)
				}
			}

			h.cache.SetStreamConnected(false)
			cancel()
			time.Sleep(3 * time.Second)
		}
	}()
}

func (h *Handler) startCachePruner() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for now := range ticker.C {
		h.cache.Prune(now)
	}
}

func (h *Handler) cacheClusterFlows(opts queryOptions) []models.Flow {
	return sortFlows(h.cache.Query(opts.seconds, func(flow models.Flow) bool {
		return matchesQueryOptions(flow, opts)
	}))
}

func (h *Handler) cacheNamespaceFlows(opts queryOptions) []models.Flow {
	namespace := normalizeNamespace(opts.namespace)
	return sortFlows(h.cache.Query(opts.seconds, func(flow models.Flow) bool {
		if !matchesQueryOptions(flow, opts) {
			return false
		}
		return normalizeNamespace(flow.Source.Namespace) == namespace ||
			normalizeNamespace(flow.Destination.Namespace) == namespace
	}))
}

func (h *Handler) cacheNodeFlows(node graph.NodeRef, opts queryOptions) []models.Flow {
	nodeID := graph.NodeID(node.Kind, node.Namespace, node.Name)
	return sortFlows(h.cache.Query(opts.seconds, func(flow models.Flow) bool {
		if !matchesQueryOptions(flow, opts) {
			return false
		}
		return flowNodeID(flow.Source) == nodeID || flowNodeID(flow.Destination) == nodeID
	}))
}

func matchesQueryOptions(flow models.Flow, opts queryOptions) bool {
	if len(opts.actions) > 0 && !containsExact(opts.actions, flow.Action) {
		return false
	}
	if len(opts.protocols) > 0 && !containsExact(opts.protocols, flow.Protocol) {
		return false
	}
	if len(opts.srcNames) > 0 && !containsFuzzy(opts.srcNames, flow.Source.Name) {
		return false
	}
	if len(opts.dstNames) > 0 && !containsFuzzy(opts.dstNames, flow.Destination.Name) {
		return false
	}
	if len(opts.destPorts) > 0 && !containsPort(opts.destPorts, flow.Destination.Port) {
		return false
	}
	if opts.reporter != "" && !strings.EqualFold(opts.reporter, flow.Reporter) {
		return false
	}
	return true
}

func containsExact(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(value, target) {
			return true
		}
	}
	return false
}

func containsFuzzy(values []string, target string) bool {
	target = strings.ToLower(target)
	for _, value := range values {
		if strings.Contains(target, strings.ToLower(value)) {
			return true
		}
	}
	return false
}

func containsPort(values []int64, target int64) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
