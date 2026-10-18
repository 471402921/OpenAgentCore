package pi

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/MiniMax-AI/OpenAgentCore/internal/agentdaemon/proto"
)

// TestNativePiExecutorReuse makes real model calls and is opt-in. Provider
// options are read from a private file and never included in failures.
func TestNativePiExecutorReuse(t *testing.T) {
	options := os.Getenv("OAC_TEST_PI_REAL_OPTIONS")
	if options == "" {
		t.Skip("private provider options required")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Minute)
	defer cancel()
	raw, err := os.ReadFile(options)
	if err != nil {
		t.Fatal("private provider options unavailable")
	}
	var agentOptions map[string]any
	if json.Unmarshal(raw, &agentOptions) != nil {
		t.Fatal("invalid private provider options")
	}
	factory := NewExecutorFactory(t.TempDir(), t.TempDir())
	owner, err := factory(ctx, proto.PromptRequestPayload{
		AgentKind:        "pi",
		AgentOptions:     agentOptions,
		LocalEnvironment: &proto.LocalEnvironment{WorkspaceRoot: t.TempDir()},
	})
	if err != nil {
		t.Fatal("native Executor preparation failed")
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if owner.Close(cleanup) != nil {
			t.Error("native owner cleanup failed")
		}
	}()
	run := func(id string) string {
		t.Helper()
		out := make(chan proto.Envelope, 128)
		turn, err := owner.StartTurn(ctx, id, proto.TextInput("Reply with exactly: ready"), out)
		if err != nil {
			t.Fatalf("StartTurn(%s): %v", id, err)
		}
		var content string
		for envelope := range out {
			if envelope.Type != proto.TypeDone {
				continue
			}
			var done proto.DonePayload
			if err := json.Unmarshal(envelope.Payload, &done); err != nil {
				t.Fatalf("done payload: %v", err)
			}
			content = done.Content
		}
		if state, err := turn.AwaitSettlement(ctx); err != nil || !state.Reusable {
			t.Fatalf("settlement(%s): %+v %v", id, state, err)
		}
		if strings.TrimSpace(content) == "" {
			t.Fatalf("Turn %s produced no text", id)
		}
		return content
	}
	run("live-one")
	run("live-two")
}
