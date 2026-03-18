package graph

import (
	"fmt"
	"sort"
	"strings"

	"calico-ui/internal/models"
)

const (
	KindNamespace = "namespace"
	KindExternal  = "external"
)

type NodeRef struct {
	Kind      string
	Namespace string
	Name      string
}

type graphNodeAcc struct {
	node models.ServiceNode
}

type graphEdgeAcc struct {
	edge models.ServiceEdge
}

func NodeID(kind, namespace, name string) string {
	return fmt.Sprintf("%s:%s/%s", normalizeKind(kind), normalizeNamespace(namespace), name)
}

func ParseNodeID(id string) (NodeRef, error) {
	parts := strings.SplitN(id, ":", 2)
	if len(parts) != 2 {
		return NodeRef{}, fmt.Errorf("invalid node id: %s", id)
	}

	nsAndName := strings.SplitN(parts[1], "/", 2)
	if len(nsAndName) != 2 {
		return NodeRef{}, fmt.Errorf("invalid node id: %s", id)
	}

	return NodeRef{
		Kind:      normalizeKind(parts[0]),
		Namespace: nsAndName[0],
		Name:      nsAndName[1],
	}, nil
}

func BuildServiceGraph(flows []models.Flow, focusNamespace string) models.GraphResponse {
	resp := buildEndpointGraph(flows)
	resp.Meta.Mode = "namespace-service"
	resp.Meta.FocusNamespace = focusNamespace
	resp.Meta.FocusNodeName = focusNamespace
	return resp
}

func BuildServiceRoute(flows []models.Flow, focusNamespace, focusNodeID string, depth int) models.GraphResponse {
	resp := buildEndpointGraph(flows)
	resp.Meta.Mode = "service-route"
	resp.Meta.FocusNamespace = focusNamespace
	resp.Meta.FocusNodeID = focusNodeID
	resp.Meta.FocusNodeName = findNodeDisplayName(resp.Nodes, focusNodeID)
	resp.Meta.Depth = depth
	return resp
}

func BuildNamespaceOverview(flows []models.Flow, crossNamespaceOnly bool) models.GraphResponse {
	nodes := map[string]*graphNodeAcc{}
	edges := map[string]*graphEdgeAcc{}

	ensureNode := func(ep models.Endpoint) string {
		ref := namespaceBucket(ep)
		id := NodeID(KindNamespace, ref.Namespace, ref.Name)
		if _, ok := nodes[id]; !ok {
			nodes[id] = &graphNodeAcc{
				node: models.ServiceNode{
					ID:          id,
					Name:        ref.Name,
					DisplayName: ref.Name,
					Subtitle:    ref.Subtitle,
					Namespace:   ref.Namespace,
					Kind:        KindNamespace,
					External:    ref.External,
				},
			}
		}
		return id
	}

	for _, f := range flows {
		srcID := ensureNode(f.Source)
		dstID := ensureNode(f.Destination)

		srcNode := nodes[srcID]
		srcNode.node.BytesIn += f.BytesIn
		srcNode.node.BytesOut += f.BytesOut
		srcNode.node.Connections += f.Connections.Started

		dstNode := nodes[dstID]
		dstNode.node.BytesIn += f.BytesIn
		dstNode.node.BytesOut += f.BytesOut
		dstNode.node.Connections += f.Connections.Started

		applyActionToNode(&srcNode.node, f.Action)
		applyActionToNode(&dstNode.node, f.Action)

		if srcID == dstID {
			continue
		}

		crossNamespace := nodes[srcID].node.Name != nodes[dstID].node.Name
		if crossNamespaceOnly && !crossNamespace {
			continue
		}

		edgeID := fmt.Sprintf("%s->%s:%s:%s:%d", srcID, dstID, f.Protocol, f.Action, f.Destination.Port)
		if _, ok := edges[edgeID]; !ok {
			edges[edgeID] = &graphEdgeAcc{
				edge: models.ServiceEdge{
					ID:             edgeID,
					SourceID:       srcID,
					TargetID:       dstID,
					Protocol:       f.Protocol,
					Port:           f.Destination.Port,
					Action:         f.Action,
					CrossNamespace: crossNamespace,
				},
			}
		}

		e := edges[edgeID]
		e.edge.BytesIn += f.BytesIn
		e.edge.BytesOut += f.BytesOut
		e.edge.Connections += f.Connections.Started
	}

	resp := models.GraphResponse{
		Nodes: collectNodes(nodes),
		Edges: collectEdges(edges),
		Meta: models.GraphMeta{
			Mode:               "namespace-overview",
			CrossNamespaceOnly: crossNamespaceOnly,
			Aggregated:         true,
		},
	}
	finalizeGraph(&resp)
	return resp
}

func buildEndpointGraph(flows []models.Flow) models.GraphResponse {
	nodes := map[string]*graphNodeAcc{}
	edges := map[string]*graphEdgeAcc{}

	ensureNode := func(ep models.Endpoint) string {
		ref := endpointNode(ep)
		id := NodeID(ref.Kind, ref.Namespace, ref.Name)
		if _, ok := nodes[id]; !ok {
			nodes[id] = &graphNodeAcc{
				node: models.ServiceNode{
					ID:          id,
					Name:        ref.Name,
					DisplayName: ref.DisplayName,
					Subtitle:    ref.Subtitle,
					Namespace:   ref.Namespace,
					Kind:        ref.Kind,
					External:    ref.External,
				},
			}
		}
		return id
	}

	for _, f := range flows {
		srcID := ensureNode(f.Source)
		dstID := ensureNode(f.Destination)

		srcNode := nodes[srcID]
		srcNode.node.BytesIn += f.BytesIn
		srcNode.node.BytesOut += f.BytesOut
		srcNode.node.Connections += f.Connections.Started

		dstNode := nodes[dstID]
		dstNode.node.BytesIn += f.BytesIn
		dstNode.node.BytesOut += f.BytesOut
		dstNode.node.Connections += f.Connections.Started

		applyActionToNode(&srcNode.node, f.Action)
		applyActionToNode(&dstNode.node, f.Action)

		edgeID := fmt.Sprintf("%s->%s:%s:%s:%d", srcID, dstID, f.Protocol, f.Action, f.Destination.Port)
		if _, ok := edges[edgeID]; !ok {
			edges[edgeID] = &graphEdgeAcc{
				edge: models.ServiceEdge{
					ID:             edgeID,
					SourceID:       srcID,
					TargetID:       dstID,
					Protocol:       f.Protocol,
					Port:           f.Destination.Port,
					Action:         f.Action,
					CrossNamespace: normalizeNamespace(f.Source.Namespace) != normalizeNamespace(f.Destination.Namespace),
				},
			}
		}

		e := edges[edgeID]
		e.edge.BytesIn += f.BytesIn
		e.edge.BytesOut += f.BytesOut
		e.edge.Connections += f.Connections.Started
	}

	resp := models.GraphResponse{
		Nodes: collectNodes(nodes),
		Edges: collectEdges(edges),
	}
	finalizeGraph(&resp)
	return resp
}

func applyActionToNode(node *models.ServiceNode, action string) {
	switch action {
	case "Allow":
		node.Allowed++
	case "Deny":
		node.Denied++
	case "Pass":
		node.Passed++
	}
}

func collectNodes(nodes map[string]*graphNodeAcc) []models.ServiceNode {
	out := make([]models.ServiceNode, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.node)
	}
	return out
}

func collectEdges(edges map[string]*graphEdgeAcc) []models.ServiceEdge {
	out := make([]models.ServiceEdge, 0, len(edges))
	for _, e := range edges {
		if e.edge.SourceID == e.edge.TargetID {
			continue
		}
		out = append(out, e.edge)
	}
	return out
}

func finalizeGraph(resp *models.GraphResponse) {
	sort.Slice(resp.Nodes, func(i, j int) bool {
		if resp.Nodes[i].Connections != resp.Nodes[j].Connections {
			return resp.Nodes[i].Connections > resp.Nodes[j].Connections
		}
		leftBytes := resp.Nodes[i].BytesIn + resp.Nodes[i].BytesOut
		rightBytes := resp.Nodes[j].BytesIn + resp.Nodes[j].BytesOut
		if leftBytes != rightBytes {
			return leftBytes > rightBytes
		}
		return resp.Nodes[i].DisplayName < resp.Nodes[j].DisplayName
	})

	sort.Slice(resp.Edges, func(i, j int) bool {
		if resp.Edges[i].Connections != resp.Edges[j].Connections {
			return resp.Edges[i].Connections > resp.Edges[j].Connections
		}
		leftBytes := resp.Edges[i].BytesIn + resp.Edges[i].BytesOut
		rightBytes := resp.Edges[j].BytesIn + resp.Edges[j].BytesOut
		if leftBytes != rightBytes {
			return leftBytes > rightBytes
		}
		return resp.Edges[i].ID < resp.Edges[j].ID
	})

	resp.Meta.TotalNodes = len(resp.Nodes)
	resp.Meta.TotalEdges = len(resp.Edges)
}

func findNodeDisplayName(nodes []models.ServiceNode, nodeID string) string {
	for _, node := range nodes {
		if node.ID == nodeID {
			if cleanedValue(node.DisplayName) != "" {
				return node.DisplayName
			}
			if cleanedValue(node.Name) != "" {
				return node.Name
			}
			return "Unnamed endpoint"
		}
	}
	return ""
}

type endpointRef struct {
	Name        string
	DisplayName string
	Subtitle    string
	Namespace   string
	Kind        string
	External    bool
}

func endpointNode(ep models.Endpoint) endpointRef {
	kind := normalizeKind(ep.Kind)
	namespace := normalizeNamespace(ep.Namespace)
	rawName := cleanedValue(ep.Name)
	serviceName := cleanedValue(ep.ServiceName)
	serviceNamespace := cleanedValue(ep.ServiceNamespace)
	displayName := rawName
	subtitle := namespace

	if friendly, ok := externalDisplayName(rawName); ok && namespace == "-" {
		return endpointRef{
			Name:        fallbackEndpointName(rawName, "external"),
			DisplayName: friendly,
			Subtitle:    "external network",
			Namespace:   namespace,
			Kind:        KindExternal,
			External:    true,
		}
	}

	if serviceName != "" {
		displayName = serviceName
		switch {
		case serviceNamespace != "":
			subtitle = fmt.Sprintf("service in %s", serviceNamespace)
		case namespace != "-":
			subtitle = fmt.Sprintf("service in %s", namespace)
		default:
			subtitle = "service"
		}
	}

	switch kind {
	case "net":
		switch strings.ToLower(rawName) {
		case "pvt":
			displayName = "Private network"
		case "pub":
			displayName = "Public network"
		}
		if displayName == "" {
			displayName = "External endpoint"
		}
		return endpointRef{
			Name:        fallbackEndpointName(rawName, "external"),
			DisplayName: displayName,
			Subtitle:    "external network",
			Namespace:   namespace,
			Kind:        KindExternal,
			External:    true,
		}
	case "hep":
		if displayName == "" {
			displayName = "Host endpoint"
		}
		return endpointRef{
			Name:        fallbackEndpointName(rawName, "host"),
			DisplayName: displayName,
			Subtitle:    "host endpoint",
			Namespace:   namespace,
			Kind:        kind,
		}
	case "ns":
		if displayName == "" {
			displayName = "Network set"
		}
		return endpointRef{
			Name:        fallbackEndpointName(rawName, "network-set"),
			DisplayName: displayName,
			Subtitle:    "network set",
			Namespace:   namespace,
			Kind:        kind,
		}
	default:
		if displayName == "" {
			displayName = "Unnamed endpoint"
		}
		if subtitle == "-" {
			subtitle = "default"
		}
		return endpointRef{
			Name:        fallbackEndpointName(rawName, "endpoint"),
			DisplayName: displayName,
			Subtitle:    subtitle,
			Namespace:   namespace,
			Kind:        kind,
		}
	}
}

func externalDisplayName(rawName string) (string, bool) {
	switch strings.ToLower(rawName) {
	case "pvt":
		return "Private network", true
	case "pub":
		return "Public network", true
	default:
		return "", false
	}
}

func namespaceBucket(ep models.Endpoint) endpointRef {
	namespace := normalizeNamespace(ep.Namespace)
	if namespace != "-" {
		return endpointRef{
			Name:        namespace,
			DisplayName: namespace,
			Subtitle:    "namespace overview",
			Namespace:   namespace,
			Kind:        KindNamespace,
		}
	}

	switch normalizeKind(ep.Kind) {
	case "net":
		return endpointRef{
			Name:        "External Networks",
			DisplayName: "External Networks",
			Subtitle:    "aggregated external traffic",
			Namespace:   "-",
			Kind:        KindNamespace,
			External:    true,
		}
	case "hep":
		return endpointRef{
			Name:        "Host Endpoints",
			DisplayName: "Host Endpoints",
			Subtitle:    "aggregated host endpoint traffic",
			Namespace:   "-",
			Kind:        KindNamespace,
			External:    true,
		}
	default:
		return endpointRef{
			Name:        "Unspecified",
			DisplayName: "Unspecified",
			Subtitle:    "namespace not reported",
			Namespace:   "-",
			Kind:        KindNamespace,
			External:    true,
		}
	}
}

func normalizeKind(kind string) string {
	if kind == "" {
		return "wep"
	}
	return kind
}

func normalizeNamespace(namespace string) string {
	if namespace == "" {
		return "-"
	}
	return namespace
}

func cleanedValue(value string) string {
	switch strings.TrimSpace(value) {
	case "", "-", "<unknown>":
		return ""
	default:
		return strings.TrimSpace(value)
	}
}

func fallbackEndpointName(value, prefix string) string {
	if value != "" {
		return value
	}
	return fmt.Sprintf("%s:unknown", prefix)
}
