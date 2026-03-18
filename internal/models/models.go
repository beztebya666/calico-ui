package models

// Endpoint represents a source or destination in a flow.
type Endpoint struct {
	Name             string   `json:"name"`
	Namespace        string   `json:"namespace"`
	Kind             string   `json:"kind"`
	Labels           []string `json:"labels"`
	Port             int64    `json:"port,omitempty"`
	ServiceName      string   `json:"serviceName,omitempty"`
	ServiceNamespace string   `json:"serviceNamespace,omitempty"`
}

type ConnectionStats struct {
	Started   int64 `json:"started"`
	Completed int64 `json:"completed"`
	Live      int64 `json:"live"`
}

type PolicyHitInfo struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Tier      string `json:"tier"`
	Action    string `json:"action"`
}

type PolicyInfo struct {
	Enforced []PolicyHitInfo `json:"enforced"`
	Pending  []PolicyHitInfo `json:"pending"`
}

// Flow is the JSON-friendly representation of a Goldmane flow.
type Flow struct {
	ID          int64           `json:"id"`
	Key         string          `json:"key"`
	StartTime   int64           `json:"startTime"`
	EndTime     int64           `json:"endTime"`
	RouteDepth  int             `json:"routeDepth,omitempty"`
	Source      Endpoint        `json:"source"`
	Destination Endpoint        `json:"destination"`
	Protocol    string          `json:"protocol"`
	Action      string          `json:"action"`
	Reporter    string          `json:"reporter"`
	BytesIn     int64           `json:"bytesIn"`
	BytesOut    int64           `json:"bytesOut"`
	PacketsIn   int64           `json:"packetsIn"`
	PacketsOut  int64           `json:"packetsOut"`
	Connections ConnectionStats `json:"connections"`
	Policies    PolicyInfo      `json:"policies"`
}

type FlowsResponse struct {
	Flows        []Flow `json:"flows"`
	TotalResults int64  `json:"totalResults"`
	TotalPages   int64  `json:"totalPages"`
}

// ServiceNode represents a node in the service dependency graph.
type ServiceNode struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	Subtitle    string `json:"subtitle,omitempty"`
	Namespace   string `json:"namespace"`
	Kind        string `json:"kind"`
	External    bool   `json:"external,omitempty"`
	BytesIn     int64  `json:"bytesIn"`
	BytesOut    int64  `json:"bytesOut"`
	Connections int64  `json:"connections"`
	Allowed     int64  `json:"allowed"`
	Denied      int64  `json:"denied"`
	Passed      int64  `json:"passed"`
}

// ServiceEdge represents an edge (traffic flow) between two services.
type ServiceEdge struct {
	ID             string `json:"id"`
	SourceID       string `json:"sourceId"`
	TargetID       string `json:"targetId"`
	Protocol       string `json:"protocol"`
	Port           int64  `json:"port"`
	Action         string `json:"action"`
	CrossNamespace bool   `json:"crossNamespace"`
	BytesIn        int64  `json:"bytesIn"`
	BytesOut       int64  `json:"bytesOut"`
	Connections    int64  `json:"connections"`
}

type GraphMeta struct {
	Mode               string `json:"mode"`
	FocusNamespace     string `json:"focusNamespace,omitempty"`
	FocusNodeID        string `json:"focusNodeId,omitempty"`
	FocusNodeName      string `json:"focusNodeName,omitempty"`
	Depth              int    `json:"depth,omitempty"`
	CrossNamespaceOnly bool   `json:"crossNamespaceOnly,omitempty"`
	Aggregated         bool   `json:"aggregated,omitempty"`
	Truncated          bool   `json:"truncated,omitempty"`
	TotalNodes         int    `json:"totalNodes"`
	TotalEdges         int    `json:"totalEdges"`
}

type GraphResponse struct {
	Nodes []ServiceNode `json:"nodes"`
	Edges []ServiceEdge `json:"edges"`
	Meta  GraphMeta     `json:"meta"`
}

type WSMessage struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}
