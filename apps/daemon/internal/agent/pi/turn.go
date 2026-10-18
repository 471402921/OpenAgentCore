package pi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/MiniMax-AI/OpenAgentCore/apps/daemon/internal/agent"
	"github.com/MiniMax-AI/OpenAgentCore/internal/agentdaemon/proto"
)

// errReceiptUnavailable fails closed until the native input receipt lands. A
// required receipt is never reported as Unsupported, and never faked.
var errReceiptUnavailable = errors.New("pi: native input receipt is not implemented")

// unsupported reports an extension this adapter does not serve.
func unsupported(operation string) error {
	return fmt.Errorf("%w: %s", agent.ErrUnsupportedOperation, operation)
}

type turn struct {
	runID string
	out   chan<- proto.Envelope
	rpc   *rpcProcess

	settled chan struct{}
	once    sync.Once
	settle  agent.TurnSettlement
	err     error

	mu      sync.Mutex
	content strings.Builder
	usage   proto.Usage
	seq     uint64
	index   int
	cancel  bool
}

var (
	_ agent.Turn                     = (*turn)(nil)
	_ agent.Session                  = (*turn)(nil)
	_ agent.DurableSteerer           = (*turn)(nil)
	_ agent.Steerer                  = (*turn)(nil)
	_ agent.FunctionResultSubmitter  = (*turn)(nil)
	_ agent.WorkspaceReader          = (*turn)(nil)
	_ agent.WorkspaceDirectoryLister = (*turn)(nil)
	_ agent.WorkspaceWriter          = (*turn)(nil)
)

func newTurn(runID string, out chan<- proto.Envelope, rpc *rpcProcess) *turn {
	return &turn{runID: runID, out: out, rpc: rpc, settled: make(chan struct{})}
}

type piUsage struct {
	Input       int32 `json:"input"`
	Output      int32 `json:"output"`
	CacheRead   int32 `json:"cacheRead"`
	CacheWrite  int32 `json:"cacheWrite"`
	TotalTokens int32 `json:"totalTokens"`
	Cost        struct {
		Total float64 `json:"total"`
	} `json:"cost"`
}

type assistantEvent struct {
	Type  string `json:"type"`
	Delta string `json:"delta"`
}

type messageRecord struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

func (t *turn) handle(event Event) {
	switch event.Type {
	case "message_update":
		var update struct {
			Usage                 *piUsage       `json:"usage"`
			AssistantMessageEvent assistantEvent `json:"assistantMessageEvent"`
		}
		if err := json.Unmarshal(event.Raw, &update); err != nil {
			return
		}
		switch update.AssistantMessageEvent.Type {
		case "text_delta":
			t.emit(proto.TypeDelta, proto.DeltaPayload{Delta: update.AssistantMessageEvent.Delta, Sequence: t.next()})
		case "thinking_delta":
			t.emit(proto.TypeThinking, proto.ThinkingPayload{Text: update.AssistantMessageEvent.Delta, Sequence: t.next()})
		}
		if update.Usage != nil {
			t.emit(proto.TypeUsage, proto.UsagePayload{Usage: convertUsage(update.Usage)})
		}
	case "message_end":
		var record struct {
			Message messageRecord `json:"message"`
		}
		if err := json.Unmarshal(event.Raw, &record); err != nil || record.Message.Role != "assistant" {
			return
		}
		text := messageText(record.Message.Content)
		t.mu.Lock()
		t.content.WriteString(text)
		t.index++
		id := t.runID + ":assistant:" + strconv.Itoa(t.index)
		t.mu.Unlock()
		t.emit(proto.TypeOutputMessage, proto.OutputMessagePayload{ID: id, Status: "completed", Text: &text})
	case "tool_execution_start", "tool_execution_end":
		var call struct {
			ToolCallID string         `json:"toolCallId"`
			ToolName   string         `json:"toolName"`
			Args       map[string]any `json:"args"`
			Result     map[string]any `json:"result"`
		}
		if err := json.Unmarshal(event.Raw, &call); err != nil {
			return
		}
		stage := "before"
		if event.Type == "tool_execution_end" {
			stage = "after"
		}
		t.emit(proto.TypeToolCall, proto.ToolCallPayload{ID: call.ToolCallID, Name: call.ToolName, Stage: stage, Args: call.Args, Result: call.Result})
	case "agent_settled":
		var settled struct {
			Aborted bool `json:"aborted"`
		}
		_ = json.Unmarshal(event.Raw, &settled)
		t.finish(agent.TurnSettlement{Reusable: true}, nil)
	}
}

func convertUsage(usage *piUsage) proto.Usage {
	return proto.Usage{
		InputTokens:  usage.Input,
		OutputTokens: usage.Output,
		CostUSD:      usage.Cost.Total,
		Raw: map[string]any{
			"cache_read":  usage.CacheRead,
			"cache_write": usage.CacheWrite,
			"total":       usage.TotalTokens,
		},
	}
}

// messageText joins an assistant message's text blocks. Pi's completed message
// is authoritative; streamed deltas are only a live display.
func messageText(content json.RawMessage) string {
	if len(content) == 0 {
		return ""
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &blocks); err == nil {
		var text strings.Builder
		for _, block := range blocks {
			if block.Type == "text" {
				text.WriteString(block.Text)
			}
		}
		return text.String()
	}
	var single string
	if err := json.Unmarshal(content, &single); err == nil {
		return single
	}
	return ""
}

func (t *turn) emit(typ string, payload any) {
	envelope, err := proto.NewEnvelope(typ, t.runID, payload)
	if err != nil {
		return
	}
	t.out <- envelope
}

func (t *turn) next() uint64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.seq++
	return t.seq
}

func (t *turn) fail(err error) {
	t.finish(agent.TurnSettlement{Reason: err.Error()}, err)
}

// finish publishes the terminal frames once and releases the output channel.
func (t *turn) finish(settlement agent.TurnSettlement, err error) {
	t.once.Do(func() {
		t.mu.Lock()
		content := t.content.String()
		usage := t.usage
		cancelled := t.cancel
		t.mu.Unlock()
		if err != nil {
			t.emit(proto.TypeError, proto.ErrorPayload{Error: err.Error(), Code: "runtime_error"})
		} else if cancelled {
			settlement.Reusable = true
		}
		t.emit(proto.TypeDone, proto.DonePayload{Content: content, Usage: usage})
		close(t.out)
		t.settle = settlement
		t.err = err
		close(t.settled)
	})
}

func (t *turn) AwaitSettlement(ctx context.Context) (agent.TurnSettlement, error) {
	select {
	case <-t.settled:
		return t.settle, t.err
	case <-ctx.Done():
		return agent.TurnSettlement{}, ctx.Err()
	}
}

func (t *turn) Cancel(ctx context.Context) error {
	t.mu.Lock()
	t.cancel = true
	t.mu.Unlock()
	deadline, cancel := context.WithTimeout(context.Background(), prepareTimeout)
	defer cancel()
	_, _ = t.rpc.call(deadline, "clear_queue", nil)
	_, err := t.rpc.call(deadline, "abort", nil)
	if err != nil && errors.Is(err, errRPCClosed) {
		return nil
	}
	return err
}

func (t *turn) CancellationOutcome() proto.DonePayload {
	t.mu.Lock()
	defer t.mu.Unlock()
	return proto.DonePayload{Content: t.content.String(), Usage: t.usage}
}

func (t *turn) SteerWithReceipt(context.Context, proto.PromptSteerPayload, func()) error {
	return errReceiptUnavailable
}

func (t *turn) Steer(context.Context, proto.PromptSteerPayload) error {
	return unsupported("steering")
}

func (t *turn) SubmitFunctionResult(context.Context, proto.FunctionResultPayload) error {
	return unsupported("function_result")
}

func (t *turn) ReadWorkspaceFile(context.Context, string, int) (agent.WorkspaceReadResult, error) {
	return agent.WorkspaceReadResult{}, unsupported("workspace_read")
}

func (t *turn) ListWorkspaceDirectory(context.Context, string, int) (agent.WorkspaceDirectoryResult, error) {
	return agent.WorkspaceDirectoryResult{}, unsupported("workspace_list")
}

func (t *turn) WriteWorkspaceFile(context.Context, string, []byte) (agent.WorkspaceWriteResult, error) {
	return agent.WorkspaceWriteResult{}, unsupported("workspace_write")
}
