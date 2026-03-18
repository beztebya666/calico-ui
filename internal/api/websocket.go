package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"calico-ui/internal/goldmane"
	"calico-ui/internal/models"
	pb "calico-ui/proto"

	"github.com/gorilla/websocket"
)

func (h *Handler) handleWSFlows(w http.ResponseWriter, r *http.Request) {
	if !h.ensureRuntimeReady(w) {
		return
	}

	opts := parseQueryOptions(r)

	select {
	case h.wsSlot <- struct{}{}:
		defer func() { <-h.wsSlot }()
	default:
		writeError(w, http.StatusTooManyRequests, "too many websocket connections")
		return
	}

	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 4096,
		CheckOrigin:     h.auth.CheckOrigin,
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("websocket upgrade", "err", err)
		return
	}
	defer conn.Close()

	h.logger.Info("websocket connected", "namespace", opts.namespace, "nodeId", opts.nodeID, "remote", r.RemoteAddr)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	streams, err := h.openFlowStreams(ctx, opts)
	if err != nil {
		h.logger.Error("open websocket streams", "err", err, "namespace", opts.namespace)
		msg, _ := json.Marshal(models.WSMessage{Type: "error", Data: "live stream unavailable"})
		conn.WriteMessage(websocket.TextMessage, msg)
		return
	}

	flowCh := make(chan models.Flow, 64)
	for _, stream := range streams {
		go func(s pb.Flows_StreamClient) {
			for {
				result, err := s.Recv()
				if err != nil {
					if err == io.EOF || ctx.Err() != nil {
						return
					}
					h.logger.Error("stream recv", "err", err)
					cancel()
					return
				}

				select {
				case flowCh <- goldmane.ConvertFlowResult(result):
				case <-ctx.Done():
					return
				}
			}
		}(stream)
	}

	seen := map[string]time.Time{}
	cleanupTicker := time.NewTicker(30 * time.Second)
	defer cleanupTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case flow := <-flowCh:
			now := time.Now()
			key := flowKey(flow)
			if lastSeen, ok := seen[key]; ok && now.Sub(lastSeen) < 30*time.Second {
				continue
			}
			seen[key] = now

			msg, _ := json.Marshal(models.WSMessage{Type: "flow", Data: flow})
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-cleanupTicker.C:
			cutoff := time.Now().Add(-2 * time.Minute)
			for id, ts := range seen {
				if ts.Before(cutoff) {
					delete(seen, id)
				}
			}
		}
	}
}

func (h *Handler) openFlowStreams(ctx context.Context, opts queryOptions) ([]pb.Flows_StreamClient, error) {
	streamFor := func(filter *pb.Filter) (pb.Flows_StreamClient, error) {
		return h.client.StreamFlows(ctx, &pb.FlowStreamRequest{
			StartTimeGte:        0,
			Filter:              filter,
			AggregationInterval: 15,
		})
	}

	if opts.namespace == "" {
		stream, err := streamFor(goldmane.BuildFilter("", "", opts.actions, opts.protocols, opts.srcNames, opts.dstNames, opts.destPorts, opts.reporter))
		if err != nil {
			return nil, err
		}
		return []pb.Flows_StreamClient{stream}, nil
	}

	srcStream, err := streamFor(goldmane.BuildFilter(opts.namespace, "", opts.actions, opts.protocols, opts.srcNames, opts.dstNames, opts.destPorts, opts.reporter))
	if err != nil {
		return nil, err
	}
	dstStream, err := streamFor(goldmane.BuildFilter("", opts.namespace, opts.actions, opts.protocols, opts.srcNames, opts.dstNames, opts.destPorts, opts.reporter))
	if err != nil {
		return nil, err
	}
	return []pb.Flows_StreamClient{srcStream, dstStream}, nil
}
