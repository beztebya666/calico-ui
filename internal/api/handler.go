package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"calico-ui/internal/bootstrap"
	"calico-ui/internal/goldmane"
	"calico-ui/internal/graph"
	"calico-ui/internal/models"
	pb "calico-ui/proto"
)

type Handler struct {
	client  *goldmane.Client
	runtime bootstrap.Status
	cache   *FlowCache
	logger  *slog.Logger
	auth    *AuthManager
	wsSlot  chan struct{}
}

const graphAggregationInterval int64 = 15

type queryOptions struct {
	namespace          string
	nodeID             string
	page               int64
	pageSize           int64
	seconds            int64
	depth              int
	crossNamespaceOnly bool
	actions            []string
	protocols          []string
	srcNames           []string
	dstNames           []string
	destPorts          []int64
	reporter           string
}

func NewHandler(client *goldmane.Client, runtimeStatus bootstrap.Status, logger *slog.Logger) *Handler {
	cacheRetention := readCacheRetention()
	handler := &Handler{
		client:  client,
		runtime: runtimeStatus,
		cache:   NewFlowCache(cacheRetention),
		logger:  logger,
		auth:    newAuthManager(logger),
		wsSlot:  make(chan struct{}, readMaxWSConnections()),
	}
	handler.startCacheStream()
	return handler
}

func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/health", h.handleHealth)
	mux.HandleFunc("GET /api/v1/ready", h.handleReady)
	mux.HandleFunc("GET /api/v1/runtime/status", h.handleRuntimeStatus)
	mux.HandleFunc("GET /api/v1/auth/status", h.handleAuthStatus)
	mux.HandleFunc("POST /api/v1/auth/login", h.handleAuthLogin)

	protected := h.auth.Require
	mux.Handle("POST /api/v1/auth/logout", protected(http.HandlerFunc(h.handleAuthLogout)))
	mux.Handle("GET /api/v1/namespaces", protected(http.HandlerFunc(h.handleNamespaces)))
	mux.Handle("GET /api/v1/flows", protected(http.HandlerFunc(h.handleFlows)))
	mux.Handle("GET /api/v1/graph", protected(http.HandlerFunc(h.handleGraphCompat)))
	mux.Handle("GET /api/v1/graph/namespaces", protected(http.HandlerFunc(h.handleNamespaceOverviewGraph)))
	mux.Handle("GET /api/v1/graph/namespace/{namespace}", protected(http.HandlerFunc(h.handleNamespaceGraph)))
	mux.Handle("GET /api/v1/graph/service", protected(http.HandlerFunc(h.handleServiceRouteGraph)))
	mux.Handle("GET /api/v1/ws/flows", protected(http.HandlerFunc(h.handleWSFlows)))
}

func (h *Handler) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) handleReady(w http.ResponseWriter, r *http.Request) {
	if h.client == nil {
		writeError(w, http.StatusServiceUnavailable, h.runtime.Message)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	if err := h.client.Ping(ctx); err == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
		return
	}

	if h.cache.HasRecentData(2 * time.Minute) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "degraded"})
		return
	}

	writeError(w, http.StatusServiceUnavailable, "goldmane is unavailable")
}

func (h *Handler) handleRuntimeStatus(w http.ResponseWriter, r *http.Request) {
	status := h.runtime
	if h.client != nil {
		status.Ready = true
	}
	writeJSON(w, http.StatusOK, status)
}

func (h *Handler) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	h.auth.HandleStatus(w, r)
}

func (h *Handler) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	h.auth.HandleLogin(w, r)
}

func (h *Handler) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	h.auth.HandleLogout(w, r)
}

func (h *Handler) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	if !h.ensureRuntimeReady(w) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	namespaces, err := h.client.GetNamespaces(ctx)
	if err != nil {
		h.logger.Error("get namespaces", "err", err)
		namespaces = h.cache.Namespaces()
		if len(namespaces) == 0 {
			writeInternalError(w, "failed to load namespaces")
			return
		}
	}

	namespaces = h.filterNamespaces(namespaces)
	writeJSON(w, http.StatusOK, namespaces)
}

func (h *Handler) handleFlows(w http.ResponseWriter, r *http.Request) {
	if !h.ensureRuntimeReady(w) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	opts := parseQueryOptions(r)
	if !h.authorizeQueryScope(w, opts) {
		return
	}
	flows, err := h.listScopeFlows(ctx, opts, 15)
	if err != nil {
		h.logger.Error("list flows", "err", err, "namespace", opts.namespace, "nodeId", opts.nodeID)
		writeInternalError(w, "failed to load flows")
		return
	}
	if opts.crossNamespaceOnly {
		flows = filterCrossNamespaceFlows(flows)
	}

	paged, totalPages := paginateFlows(flows, opts.page, opts.pageSize)
	resp := models.FlowsResponse{
		Flows:        paged,
		TotalResults: int64(len(flows)),
		TotalPages:   totalPages,
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) handleGraphCompat(w http.ResponseWriter, r *http.Request) {
	opts := parseQueryOptions(r)
	if opts.namespace == "" {
		h.handleNamespaceOverviewGraph(w, r)
		return
	}
	h.handleNamespaceGraph(w, r)
}

func (h *Handler) handleNamespaceOverviewGraph(w http.ResponseWriter, r *http.Request) {
	if !h.ensureRuntimeReady(w) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	opts := parseQueryOptions(r)
	if !h.authorizeQueryScope(w, opts) {
		return
	}
	flows, err := h.listClusterFlows(ctx, opts, graphAggregationInterval)
	if err != nil {
		h.logger.Error("build namespace overview graph", "err", err)
		writeInternalError(w, "failed to build namespace overview graph")
		return
	}

	if opts.crossNamespaceOnly {
		flows = filterCrossNamespaceFlows(flows)
	}

	resp := graph.BuildNamespaceOverview(flows, opts.crossNamespaceOnly)
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) handleNamespaceGraph(w http.ResponseWriter, r *http.Request) {
	if !h.ensureRuntimeReady(w) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	opts := parseQueryOptions(r)
	if pathNamespace := r.PathValue("namespace"); pathNamespace != "" {
		opts.namespace = pathNamespace
	}
	if opts.namespace == "" {
		writeError(w, http.StatusBadRequest, "namespace is required")
		return
	}
	if !h.authorizeQueryScope(w, opts) {
		return
	}

	flows, err := h.listNamespaceFlows(ctx, opts, graphAggregationInterval)
	if err != nil {
		h.logger.Error("build namespace graph", "err", err, "namespace", opts.namespace)
		writeInternalError(w, "failed to build namespace graph")
		return
	}

	if opts.crossNamespaceOnly {
		flows = filterCrossNamespaceFlows(flows)
	}

	resp := graph.BuildServiceGraph(flows, opts.namespace)
	resp.Meta.CrossNamespaceOnly = opts.crossNamespaceOnly
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) handleServiceRouteGraph(w http.ResponseWriter, r *http.Request) {
	if !h.ensureRuntimeReady(w) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	opts := parseQueryOptions(r)
	if opts.nodeID == "" {
		writeError(w, http.StatusBadRequest, "nodeId is required")
		return
	}
	if !h.authorizeQueryScope(w, opts) {
		return
	}

	flows, err := h.collectRouteFlows(ctx, opts, graphAggregationInterval)
	if err != nil {
		h.logger.Error("build service route graph", "err", err, "nodeId", opts.nodeID)
		writeInternalError(w, "failed to build service route graph")
		return
	}

	if opts.crossNamespaceOnly {
		flows = filterCrossNamespaceFlows(flows)
	}

	focusNamespace := opts.namespace
	if focusNamespace == "" {
		if ref, err := graph.ParseNodeID(opts.nodeID); err == nil {
			focusNamespace = ref.Namespace
		}
	}

	resp := graph.BuildServiceRoute(flows, focusNamespace, opts.nodeID, opts.depth)
	resp.Meta.CrossNamespaceOnly = opts.crossNamespaceOnly
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) listScopeFlows(ctx context.Context, opts queryOptions, aggregationInterval int64) ([]models.Flow, error) {
	switch {
	case opts.nodeID != "":
		return h.collectRouteFlows(ctx, opts, aggregationInterval)
	case opts.namespace != "":
		return h.listNamespaceFlows(ctx, opts, aggregationInterval)
	default:
		return h.listClusterFlows(ctx, opts, aggregationInterval)
	}
}

func (h *Handler) listClusterFlows(ctx context.Context, opts queryOptions, aggregationInterval int64) ([]models.Flow, error) {
	filter := goldmane.BuildFilter("", "", opts.actions, opts.protocols, opts.srcNames, opts.dstNames, opts.destPorts, opts.reporter)
	flows, err := h.fetchFlows(ctx, -opts.seconds, computeFetchLimit(opts.page, opts.pageSize), filter, aggregationInterval)
	if err != nil {
		flows = h.cacheClusterFlows(opts)
		if len(flows) == 0 {
			return nil, err
		}
		h.logger.Warn("serving cluster flows from cache after upstream failure", "err", err, "results", len(flows))
		return sortFlows(flows), nil
	}
	if len(flows) == 0 {
		flows = h.cacheClusterFlows(opts)
		if len(flows) > 0 {
			h.logger.Info("flow list served from cache", "scope", "cluster", "results", len(flows))
		}
	}
	return sortFlows(flows), nil
}

func (h *Handler) listNamespaceFlows(ctx context.Context, opts queryOptions, aggregationInterval int64) ([]models.Flow, error) {
	srcFilter := goldmane.BuildFilter(opts.namespace, "", opts.actions, opts.protocols, opts.srcNames, opts.dstNames, opts.destPorts, opts.reporter)
	dstFilter := goldmane.BuildFilter("", opts.namespace, opts.actions, opts.protocols, opts.srcNames, opts.dstNames, opts.destPorts, opts.reporter)

	limit := computeFetchLimit(opts.page, opts.pageSize)
	srcFlows, err := h.fetchFlows(ctx, -opts.seconds, limit, srcFilter, aggregationInterval)
	if err != nil {
		flows := h.cacheNamespaceFlows(opts)
		if len(flows) == 0 {
			return nil, err
		}
		h.logger.Warn("serving namespace flows from cache after source query failure", "err", err, "namespace", opts.namespace, "results", len(flows))
		return sortFlows(flows), nil
	}
	dstFlows, err := h.fetchFlows(ctx, -opts.seconds, limit, dstFilter, aggregationInterval)
	if err != nil {
		flows := h.cacheNamespaceFlows(opts)
		if len(flows) == 0 {
			return nil, err
		}
		h.logger.Warn("serving namespace flows from cache after destination query failure", "err", err, "namespace", opts.namespace, "results", len(flows))
		return sortFlows(flows), nil
	}

	flows := sortFlows(mergeUniqueFlows(srcFlows, dstFlows))
	if len(flows) == 0 {
		flows = h.cacheNamespaceFlows(opts)
		if len(flows) > 0 {
			h.logger.Info("flow list served from cache", "scope", "namespace", "namespace", opts.namespace, "results", len(flows))
		}
	}

	return flows, nil
}

func (h *Handler) collectRouteFlows(ctx context.Context, opts queryOptions, aggregationInterval int64) ([]models.Flow, error) {
	start, err := graph.ParseNodeID(opts.nodeID)
	if err != nil {
		return nil, err
	}

	depth := opts.depth
	if depth < 1 {
		depth = 1
	}

	frontier := []graph.NodeRef{start}
	seenNodes := map[string]bool{graph.NodeID(start.Kind, start.Namespace, start.Name): true}
	nodeDepths := map[string]int{graph.NodeID(start.Kind, start.Namespace, start.Name): 0}
	seenFlows := map[string]models.Flow{}

	for level := 0; level < depth; level++ {
		nextFrontier := make([]graph.NodeRef, 0)
		nextSeen := map[string]bool{}

		for _, node := range frontier {
			nodeFlows, err := h.listNodeFlows(ctx, node, opts, aggregationInterval)
			if err != nil {
				return nil, err
			}

			for _, flow := range nodeFlows {
				seenFlows[flowKey(flow)] = flow

				if level == depth-1 {
					continue
				}

				for _, ref := range flowNodeRefs(flow) {
					nodeID := graph.NodeID(ref.Kind, ref.Namespace, ref.Name)
					if seenNodes[nodeID] || nextSeen[nodeID] {
						continue
					}
					nextSeen[nodeID] = true
					nodeDepths[nodeID] = level + 1
					nextFrontier = append(nextFrontier, ref)
				}
			}
		}

		for nodeID := range nextSeen {
			seenNodes[nodeID] = true
		}
		frontier = nextFrontier
		if len(frontier) == 0 {
			break
		}
	}

	flows := make([]models.Flow, 0, len(seenFlows))
	for _, flow := range seenFlows {
		flow.RouteDepth = computeRouteDepth(flow, nodeDepths)
		flows = append(flows, flow)
	}
	return sortFlows(flows), nil
}

func (h *Handler) listNodeFlows(ctx context.Context, node graph.NodeRef, opts queryOptions, aggregationInterval int64) ([]models.Flow, error) {
	namespace := denormalizeNamespace(node.Namespace)
	limit := int64(500)

	srcFilter := goldmane.BuildFilter(namespace, "", opts.actions, opts.protocols, []string{node.Name}, nil, opts.destPorts, opts.reporter)
	dstFilter := goldmane.BuildFilter("", namespace, opts.actions, opts.protocols, nil, []string{node.Name}, opts.destPorts, opts.reporter)

	srcFlows, err := h.fetchFlows(ctx, -opts.seconds, limit, srcFilter, aggregationInterval)
	if err != nil {
		return nil, err
	}
	dstFlows, err := h.fetchFlows(ctx, -opts.seconds, limit, dstFilter, aggregationInterval)
	if err != nil {
		return nil, err
	}

	flows := mergeUniqueFlows(srcFlows, dstFlows)
	if len(flows) == 0 {
		flows = h.cacheNodeFlows(node, opts)
		if len(flows) > 0 {
			h.logger.Info("route flow served from cache", "node", graph.NodeID(node.Kind, node.Namespace, node.Name), "results", len(flows))
		}
	}

	return flows, nil
}

func (h *Handler) fetchFlows(ctx context.Context, startTimeGte, limit int64, filter *pb.Filter, aggregationInterval int64) ([]models.Flow, error) {
	if h.client == nil {
		return nil, fmt.Errorf("runtime is not connected to Goldmane")
	}
	filter = normalizeFilter(filter)

	type attempt struct {
		start  int64
		agg    int64
		reason string
	}

	attempts := []attempt{
		{start: startTimeGte, agg: aggregationInterval, reason: "requested"},
	}
	if startTimeGte != 0 {
		attempts = append(attempts, attempt{start: 0, agg: aggregationInterval, reason: "latest-history"})
	}
	if aggregationInterval != 0 {
		attempts = append(attempts, attempt{start: startTimeGte, agg: 0, reason: "raw"})
	}
	if startTimeGte != 0 && aggregationInterval != 0 {
		attempts = append(attempts, attempt{start: 0, agg: 0, reason: "latest-history-raw"})
	}

	tried := map[string]bool{}
	var last []models.Flow

	for _, candidate := range attempts {
		key := fmt.Sprintf("%d/%d", candidate.start, candidate.agg)
		if tried[key] {
			continue
		}
		tried[key] = true

		flows, err := h.executeFlowQuery(ctx, candidate.start, limit, filter, candidate.agg)
		if err != nil {
			return nil, err
		}
		if len(flows) > 0 {
			if candidate.reason != "requested" {
				h.logger.Info(
					"flow query fallback matched",
					"reason", candidate.reason,
					"startTimeGte", candidate.start,
					"aggregationInterval", candidate.agg,
					"limit", limit,
					"hasFilter", filter != nil,
					"results", len(flows),
				)
			}
			return flows, nil
		}
		last = flows
	}

	return last, nil
}

func (h *Handler) executeFlowQuery(ctx context.Context, startTimeGte, limit int64, filter *pb.Filter, aggregationInterval int64) ([]models.Flow, error) {
	req := &pb.FlowListRequest{
		StartTimeGte:        startTimeGte,
		Page:                1,
		PageSize:            limit,
		Filter:              filter,
		AggregationInterval: aggregationInterval,
		SortBy:              []*pb.SortOption{{SortBy: pb.SortBy_Time}},
	}

	res, err := h.client.ListFlows(ctx, req)
	if err != nil {
		return nil, err
	}

	flows := make([]models.Flow, 0, len(res.GetFlows()))
	for _, result := range res.GetFlows() {
		flows = append(flows, goldmane.ConvertFlowResult(result))
	}
	return flows, nil
}

func parseQueryOptions(r *http.Request) queryOptions {
	q := r.URL.Query()

	page, _ := strconv.ParseInt(q.Get("page"), 10, 64)
	if page < 1 {
		page = 1
	}

	pageSize, _ := strconv.ParseInt(q.Get("pageSize"), 10, 64)
	if pageSize < 1 {
		pageSize = 200
	}
	if pageSize > 500 {
		pageSize = 500
	}

	seconds, _ := strconv.ParseInt(q.Get("seconds"), 10, 64)
	if seconds == 0 {
		seconds = 900
	}
	if seconds < 15 {
		seconds = 15
	}

	depth, _ := strconv.Atoi(q.Get("depth"))
	if depth < 1 {
		depth = 2
	}
	if depth > 4 {
		depth = 4
	}

	return queryOptions{
		namespace:          q.Get("namespace"),
		nodeID:             q.Get("nodeId"),
		page:               page,
		pageSize:           pageSize,
		seconds:            seconds,
		depth:              depth,
		crossNamespaceOnly: q.Get("crossNamespaceOnly") == "true",
		actions:            splitCSV(q.Get("actions")),
		protocols:          splitCSV(q.Get("protocols")),
		srcNames:           splitCSV(q.Get("sourceNames")),
		dstNames:           splitCSV(q.Get("destNames")),
		destPorts:          splitCSVInt64(q.Get("destPorts")),
		reporter:           strings.TrimSpace(strings.ToLower(q.Get("reporter"))),
	}
}

func readCacheRetention() time.Duration {
	minutes, err := strconv.Atoi(strings.TrimSpace(os.Getenv("FLOW_CACHE_RETENTION_MINUTES")))
	if err != nil || minutes < 15 {
		minutes = 120
	}
	return time.Duration(minutes) * time.Minute
}

func mergeUniqueFlows(flowSets ...[]models.Flow) []models.Flow {
	seen := make(map[string]models.Flow)
	for _, flows := range flowSets {
		for _, flow := range flows {
			seen[flowKey(flow)] = flow
		}
	}

	out := make([]models.Flow, 0, len(seen))
	for _, flow := range seen {
		out = append(out, flow)
	}
	return out
}

func sortFlows(flows []models.Flow) []models.Flow {
	sort.Slice(flows, func(i, j int) bool {
		if flows[i].StartTime != flows[j].StartTime {
			return flows[i].StartTime > flows[j].StartTime
		}
		if flows[i].EndTime != flows[j].EndTime {
			return flows[i].EndTime > flows[j].EndTime
		}
		return flowKey(flows[i]) > flowKey(flows[j])
	})
	return flows
}

func paginateFlows(flows []models.Flow, page, pageSize int64) ([]models.Flow, int64) {
	total := int64(len(flows))
	if total == 0 {
		return []models.Flow{}, 0
	}

	start := (page - 1) * pageSize
	if start >= total {
		return []models.Flow{}, int64(math.Ceil(float64(total) / float64(pageSize)))
	}

	end := start + pageSize
	if end > total {
		end = total
	}

	totalPages := int64(math.Ceil(float64(total) / float64(pageSize)))
	return flows[start:end], totalPages
}

func computeFetchLimit(page, pageSize int64) int64 {
	limit := page * pageSize * 4
	if limit < 1000 {
		limit = 1000
	}
	if limit > 5000 {
		limit = 5000
	}
	return limit
}

func filterCrossNamespaceFlows(flows []models.Flow) []models.Flow {
	out := make([]models.Flow, 0, len(flows))
	for _, flow := range flows {
		if normalizeNamespace(flow.Source.Namespace) != normalizeNamespace(flow.Destination.Namespace) {
			out = append(out, flow)
		}
	}
	return out
}

func filterFlowsTouchingNode(flows []models.Flow, nodeID string) []models.Flow {
	out := make([]models.Flow, 0, len(flows))
	for _, flow := range flows {
		if flowNodeID(flow.Source) == nodeID || flowNodeID(flow.Destination) == nodeID {
			out = append(out, flow)
		}
	}
	return out
}

func computeRouteDepth(flow models.Flow, nodeDepths map[string]int) int {
	srcDepth, srcOK := nodeDepths[flowNodeID(flow.Source)]
	dstDepth, dstOK := nodeDepths[flowNodeID(flow.Destination)]

	switch {
	case srcOK && dstOK:
		if srcDepth > dstDepth {
			if srcDepth < 1 {
				return 1
			}
			return srcDepth
		}
		if dstDepth < 1 {
			return 1
		}
		return dstDepth
	case srcOK:
		if srcDepth < 1 {
			return 1
		}
		return srcDepth
	case dstOK:
		if dstDepth < 1 {
			return 1
		}
		return dstDepth
	default:
		return 0
	}
}

func flowNodeRefs(flow models.Flow) []graph.NodeRef {
	return []graph.NodeRef{
		{
			Kind:      normalizeKind(flow.Source.Kind),
			Namespace: normalizeNamespace(flow.Source.Namespace),
			Name:      flow.Source.Name,
		},
		{
			Kind:      normalizeKind(flow.Destination.Kind),
			Namespace: normalizeNamespace(flow.Destination.Namespace),
			Name:      flow.Destination.Name,
		},
	}
}

func flowNodeID(ep models.Endpoint) string {
	return graph.NodeID(normalizeKind(ep.Kind), normalizeNamespace(ep.Namespace), ep.Name)
}

func normalizeNamespace(namespace string) string {
	if namespace == "" {
		return "-"
	}
	return namespace
}

func denormalizeNamespace(namespace string) string {
	if namespace == "-" {
		return ""
	}
	return namespace
}

func normalizeKind(kind string) string {
	switch kind {
	case "", "wep":
		return "wep"
	case "net", graph.KindExternal:
		return graph.KindExternal
	default:
		return kind
	}
}

func normalizeFilter(filter *pb.Filter) *pb.Filter {
	if filter == nil {
		return nil
	}

	if len(filter.SourceNames) == 0 &&
		len(filter.SourceNamespaces) == 0 &&
		len(filter.DestNames) == 0 &&
		len(filter.DestNamespaces) == 0 &&
		len(filter.Protocols) == 0 &&
		len(filter.DestPorts) == 0 &&
		len(filter.Actions) == 0 &&
		len(filter.Policies) == 0 &&
		len(filter.PendingActions) == 0 &&
		filter.Reporter == pb.Reporter_ReporterUnspecified {
		return nil
	}

	return filter
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeInternalError(w http.ResponseWriter, message string) {
	writeError(w, http.StatusInternalServerError, message)
}

func flowKey(flow models.Flow) string {
	if flow.Key != "" {
		return flow.Key
	}
	return models.FlowFingerprint(flow)
}

func readMaxWSConnections() int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv("MAX_WS_CONNECTIONS")))
	if err != nil || value < 1 {
		return 64
	}
	return value
}

func (h *Handler) ensureRuntimeReady(w http.ResponseWriter) bool {
	if h.client != nil {
		return true
	}

	writeError(w, http.StatusServiceUnavailable, h.runtime.Message)
	return false
}

func (h *Handler) authorizeQueryScope(w http.ResponseWriter, opts queryOptions) bool {
	if h.auth.ClusterAccessAllowed() {
		if opts.namespace == "" && opts.nodeID == "" {
			return true
		}
	}

	if opts.namespace != "" && !h.auth.NamespaceAllowed(opts.namespace) {
		writeError(w, http.StatusForbidden, "namespace access denied")
		return false
	}

	if opts.namespace == "" && opts.nodeID == "" && !h.auth.ClusterAccessAllowed() {
		writeError(w, http.StatusForbidden, "cluster-wide access denied")
		return false
	}

	if opts.nodeID != "" {
		ref, err := graph.ParseNodeID(opts.nodeID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid nodeId")
			return false
		}
		if !h.auth.NamespaceAllowed(denormalizeNamespace(ref.Namespace)) {
			writeError(w, http.StatusForbidden, "namespace access denied")
			return false
		}
	}

	return true
}

func (h *Handler) filterNamespaces(namespaces []string) []string {
	if h.auth.ClusterAccessAllowed() {
		return namespaces
	}

	filtered := make([]string, 0, len(namespaces))
	for _, namespace := range namespaces {
		if h.auth.NamespaceAllowed(namespace) {
			filtered = append(filtered, namespace)
		}
	}
	return filtered
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func splitCSVInt64(s string) []int64 {
	if s == "" {
		return nil
	}

	parts := strings.Split(s, ",")
	out := make([]int64, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		value, err := strconv.ParseInt(part, 10, 64)
		if err != nil {
			continue
		}
		out = append(out, value)
	}

	if len(out) == 0 {
		return nil
	}

	return out
}
