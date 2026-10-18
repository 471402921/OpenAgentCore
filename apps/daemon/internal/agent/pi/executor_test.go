package pi

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/MiniMax-AI/OpenAgentCore/internal/agentdaemon/proto"
)

// fakePi writes a launcher that runs the test binary as the Pi child, because
// the Executor intentionally passes only an allowlisted environment.
func fakePi(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake Pi launcher uses a POSIX shell")
	}
	path := filepath.Join(t.TempDir(), "pi")
	script := "#!/bin/sh\nGO_WANT_PI_RPC_HELPER=1 exec " + os.Args[0] + " -test.run=^TestExecutorHelper$\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatalf("fake pi: %v", err)
	}
	t.Setenv("OAC_RUNTIME_PI_BIN", path)
	return path
}

func TestExecutorRunsOneTextTurn(t *testing.T) {
	fakePi(t)
	workspace := t.TempDir()
	factory := NewExecutorFactory(t.TempDir(), t.TempDir())
	executor, err := factory(context.Background(), proto.PromptRequestPayload{
		AgentKind: "pi",
		AgentOptions: map[string]any{
			"model": "test-model",
			"model_provider": map[string]any{
				"protocol": "chat_completions",
				"base_url": "http://127.0.0.1:1/v1",
				"api_key":  "test-key",
			},
		},
		LocalEnvironment: &proto.LocalEnvironment{WorkspaceRoot: workspace},
	})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	defer executor.Close(context.Background())

	out := make(chan proto.Envelope, 32)
	turn, err := executor.StartTurn(context.Background(), "run-1", proto.TextInput("hello"), out)
	if err != nil {
		t.Fatalf("StartTurn: %v", err)
	}
	var content string
	var sawDelta, sawOutput, sawDone bool
	for envelope := range out {
		switch envelope.Type {
		case proto.TypeDelta:
			sawDelta = true
		case proto.TypeOutputMessage:
			sawOutput = true
		case proto.TypeDone:
			var payload proto.DonePayload
			if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
				t.Fatalf("done payload: %v", err)
			}
			content = payload.Content
			sawDone = true
		}
	}
	if !sawDelta || !sawOutput || !sawDone {
		t.Fatalf("missing frames: delta=%v output=%v done=%v", sawDelta, sawOutput, sawDone)
	}
	if content != "Hello" {
		t.Fatalf("done content = %q", content)
	}
	settlement, err := turn.AwaitSettlement(context.Background())
	if err != nil {
		t.Fatalf("settlement: %v", err)
	}
	if !settlement.Reusable {
		t.Fatalf("expected reusable settlement, got %+v", settlement)
	}
}

// TestExecutorHelper stands in for the Pi process. It answers the prepare probe
// synchronously and then plays one text Turn.
func TestExecutorHelper(t *testing.T) {
	if os.Getenv("GO_WANT_PI_RPC_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			continue
		}
		switch request.Type {
		case "prompt":
			respond(request.ID, request.Type, map[string]any{"disposition": "started"})
			writeEvent(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "text_delta", "contentIndex": 0, "delta": "Hello"}})
			writeEvent(map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": "Hello"}}}})
			writeEvent(map[string]any{"type": "agent_settled", "aborted": false})
		case "clear_queue", "abort":
			respond(request.ID, request.Type, map[string]any{})
		default:
			respond(request.ID, request.Type, map[string]any{})
		}
	}
	os.Exit(0)
}

func respond(id, command string, data map[string]any) {
	writeEvent(map[string]any{"id": id, "type": "response", "command": command, "success": true, "data": data})
}

func writeEvent(value map[string]any) {
	line, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = os.Stdout.Write(append(line, '\n'))
}
