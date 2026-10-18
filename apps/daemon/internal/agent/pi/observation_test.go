package pi

import (
	"encoding/json"
	"testing"
)

func TestToolObservationReportsACommand(t *testing.T) {
	before := toolObservation("bash", map[string]any{"command": "ls -la"}, nil, false, "before", 0)
	if before.Kind != "command" || before.Status != "in_progress" || before.Command != "ls -la" {
		t.Fatalf("before = %+v", before)
	}
	after := toolObservation("bash",
		map[string]any{"command": "ls -la"},
		map[string]any{"content": []any{map[string]any{"type": "text", "text": "a\nb\n"}}},
		false, "after", 12)
	if after.Status != "completed" || after.DurationMS == nil || *after.DurationMS != 12 {
		t.Fatalf("after = %+v", after)
	}
	if string(after.Output) != `"a\nb\n"` {
		t.Fatalf("output = %s", after.Output)
	}
}

func TestToolObservationReportsAnExtensionFunction(t *testing.T) {
	before := toolObservation("serena_find_symbol", map[string]any{"name_path_pattern": "Greet"}, nil, false, "before", 0)
	if before.Kind != "function" || before.Status != "in_progress" {
		t.Fatalf("before = %+v", before)
	}
	var args map[string]string
	if err := json.Unmarshal(before.Arguments, &args); err != nil || args["name_path_pattern"] != "Greet" {
		t.Fatalf("arguments = %s (%v)", before.Arguments, err)
	}
	after := toolObservation("serena_find_symbol", nil,
		map[string]any{"content": []any{map[string]any{"type": "text", "text": `[{"name_path":"Greet"}]`}}},
		false, "after", 0)
	if after.Status != "completed" || after.Content == nil || len(*after.Content) != 1 {
		t.Fatalf("after = %+v", after)
	}
	if text := (*after.Content)[0].Text; text == nil || *text != `[{"name_path":"Greet"}]` {
		t.Fatalf("content = %+v", (*after.Content)[0])
	}
}

func TestToolObservationMarksAFailure(t *testing.T) {
	after := toolObservation("serena_find_symbol", nil,
		map[string]any{"content": []any{map[string]any{"type": "text", "text": "boom"}}},
		true, "after", 0)
	if after.Status != "failed" {
		t.Fatalf("status = %q", after.Status)
	}
}

func TestToolObservationReadsMCPIdentity(t *testing.T) {
	observation := toolObservation("mcp__serena__find_symbol", nil, nil, false, "before", 0)
	if observation.Kind != "mcp" || observation.Server != "serena" || observation.Name != "find_symbol" {
		t.Fatalf("observation = %+v", observation)
	}
}
