package goldmane

import (
	"calico-ui/internal/models"
	pb "calico-ui/proto"
)

var actionNames = map[pb.Action]string{
	pb.Action_Allow: "Allow",
	pb.Action_Deny:  "Deny",
	pb.Action_Pass:  "Pass",
}

var endpointKinds = map[pb.EndpointType]string{
	pb.EndpointType_WorkloadEndpoint: "wep",
	pb.EndpointType_HostEndpoint:     "hep",
	pb.EndpointType_NetworkSet:       "ns",
	pb.EndpointType_Network:          "net",
}

var reporterNames = map[pb.Reporter]string{
	pb.Reporter_Src: "src",
	pb.Reporter_Dst: "dst",
}

var policyKindNames = map[pb.PolicyKind]string{
	pb.PolicyKind_CalicoNetworkPolicy:           "CalicoNetworkPolicy",
	pb.PolicyKind_GlobalNetworkPolicy:           "GlobalNetworkPolicy",
	pb.PolicyKind_StagedNetworkPolicy:           "StagedNetworkPolicy",
	pb.PolicyKind_StagedGlobalNetworkPolicy:     "StagedGlobalNetworkPolicy",
	pb.PolicyKind_StagedKubernetesNetworkPolicy: "StagedKubernetesNetworkPolicy",
	pb.PolicyKind_NetworkPolicy:                 "NetworkPolicy",
	pb.PolicyKind_ClusterNetworkPolicy:          "ClusterNetworkPolicy",
	pb.PolicyKind_Profile:                       "Profile",
	pb.PolicyKind_EndOfTier:                     "EndOfTier",
}

// ConvertFlowResult converts a proto FlowResult to our JSON-friendly model.
func ConvertFlowResult(fr *pb.FlowResult) models.Flow {
	f := fr.GetFlow()
	k := f.GetKey()

	src := models.Endpoint{
		Name:      normalizePlaceholder(k.GetSourceName()),
		Namespace: normalizePlaceholder(k.GetSourceNamespace()),
		Kind:      endpointKinds[k.GetSourceType()],
		Labels:    f.GetSourceLabels(),
	}

	dst := models.Endpoint{
		Name:             normalizePlaceholder(k.GetDestName()),
		Namespace:        normalizePlaceholder(k.GetDestNamespace()),
		Kind:             endpointKinds[k.GetDestType()],
		Labels:           f.GetDestLabels(),
		Port:             k.GetDestPort(),
		ServiceName:      normalizePlaceholder(k.GetDestServiceName()),
		ServiceNamespace: normalizePlaceholder(k.GetDestServiceNamespace()),
	}

	policies := convertPolicyTrace(k.GetPolicies())

	flow := models.Flow{
		ID:          fr.GetId(),
		StartTime:   f.GetStartTime(),
		EndTime:     f.GetEndTime(),
		Source:      src,
		Destination: dst,
		Protocol:    k.GetProto(),
		Action:      actionNames[k.GetAction()],
		Reporter:    reporterNames[k.GetReporter()],
		BytesIn:     f.GetBytesIn(),
		BytesOut:    f.GetBytesOut(),
		PacketsIn:   f.GetPacketsIn(),
		PacketsOut:  f.GetPacketsOut(),
		Connections: models.ConnectionStats{
			Started:   f.GetNumConnectionsStarted(),
			Completed: f.GetNumConnectionsCompleted(),
			Live:      f.GetNumConnectionsLive(),
		},
		Policies: policies,
	}

	flow.Key = models.FlowFingerprint(flow)
	return flow
}

func normalizePlaceholder(value string) string {
	switch value {
	case "", "-", "<unknown>":
		return ""
	default:
		return value
	}
}

func convertPolicyTrace(pt *pb.PolicyTrace) models.PolicyInfo {
	pi := models.PolicyInfo{}
	if pt == nil {
		return pi
	}
	for _, h := range pt.GetEnforcedPolicies() {
		pi.Enforced = append(pi.Enforced, convertPolicyHit(h))
	}
	for _, h := range pt.GetPendingPolicies() {
		pi.Pending = append(pi.Pending, convertPolicyHit(h))
	}
	if pi.Enforced == nil {
		pi.Enforced = []models.PolicyHitInfo{}
	}
	if pi.Pending == nil {
		pi.Pending = []models.PolicyHitInfo{}
	}
	return pi
}

func convertPolicyHit(h *pb.PolicyHit) models.PolicyHitInfo {
	return models.PolicyHitInfo{
		Kind:      policyKindNames[h.GetKind()],
		Namespace: h.GetNamespace(),
		Name:      h.GetName(),
		Tier:      h.GetTier(),
		Action:    actionNames[h.GetAction()],
	}
}

// BuildFilter creates a proto Filter from query parameters.
// srcNS and dstNS filter independently — set one or both as needed.
func BuildFilter(srcNS, dstNS string, actions, protocols, srcNames, dstNames []string, destPorts []int64, reporter string) *pb.Filter {
	f := &pb.Filter{}

	if srcNS != "" {
		f.SourceNamespaces = []*pb.StringMatch{{Value: srcNS, Type: pb.MatchType_Exact}}
	}
	if dstNS != "" {
		f.DestNamespaces = []*pb.StringMatch{{Value: dstNS, Type: pb.MatchType_Exact}}
	}

	for _, a := range actions {
		switch a {
		case "Allow":
			f.Actions = append(f.Actions, pb.Action_Allow)
		case "Deny":
			f.Actions = append(f.Actions, pb.Action_Deny)
		case "Pass":
			f.Actions = append(f.Actions, pb.Action_Pass)
		}
	}

	for _, p := range protocols {
		f.Protocols = append(f.Protocols, &pb.StringMatch{Value: p, Type: pb.MatchType_Exact})
	}
	for _, n := range srcNames {
		f.SourceNames = append(f.SourceNames, &pb.StringMatch{Value: n, Type: pb.MatchType_Fuzzy})
	}
	for _, n := range dstNames {
		f.DestNames = append(f.DestNames, &pb.StringMatch{Value: n, Type: pb.MatchType_Fuzzy})
	}
	for _, port := range destPorts {
		f.DestPorts = append(f.DestPorts, &pb.PortMatch{Port: port})
	}

	switch reporter {
	case "src":
		f.Reporter = pb.Reporter_Src
	case "dst":
		f.Reporter = pb.Reporter_Dst
	}

	return f
}
