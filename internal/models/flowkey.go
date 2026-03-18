package models

import (
	"strconv"
	"strings"
)

// FlowFingerprint returns a stable deduplication key for a flow observation.
// Goldmane IDs are not assumed to be globally unique, so we include the
// observable tuple that makes a flow row distinct in the UI and cache.
func FlowFingerprint(flow Flow) string {
	var b strings.Builder

	appendPart := func(value string) {
		b.WriteString(value)
		b.WriteByte('|')
	}

	appendInt := func(value int64) {
		b.WriteString(strconv.FormatInt(value, 10))
		b.WriteByte('|')
	}

	appendPart(strconv.FormatInt(flow.ID, 10))
	appendPart(flow.Reporter)
	appendPart(flow.Action)
	appendPart(flow.Protocol)
	appendInt(flow.StartTime)
	appendInt(flow.EndTime)
	appendPart(flow.Source.Kind)
	appendPart(flow.Source.Namespace)
	appendPart(flow.Source.Name)
	appendPart(flow.Source.ServiceName)
	appendPart(flow.Source.ServiceNamespace)
	appendPart(flow.Destination.Kind)
	appendPart(flow.Destination.Namespace)
	appendPart(flow.Destination.Name)
	appendPart(flow.Destination.ServiceName)
	appendPart(flow.Destination.ServiceNamespace)
	appendInt(flow.Destination.Port)

	return b.String()
}
