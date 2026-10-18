package pi

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeExtensions(t *testing.T, root string, entries []string) {
	t.Helper()
	var body strings.Builder
	body.WriteString(`{"extensions":[`)
	for i, entry := range entries {
		if i > 0 {
			body.WriteString(",")
		}
		body.WriteString(`"` + entry + `"`)
	}
	body.WriteString(`]}`)
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte(body.String()), 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
}

func TestLoadExtensionsReadsTheImageManifest(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "demo", "build"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	entry := filepath.Join(root, "demo", "build", "extension.js")
	if err := os.WriteFile(entry, []byte("export {};\n"), 0o600); err != nil {
		t.Fatalf("write entry: %v", err)
	}
	writeExtensions(t, root, []string{"demo/build/extension.js"})

	selection, err := loadExtensions(root)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(selection.Entries) != 1 || selection.Entries[0] != entry {
		t.Fatalf("entries = %v, want [%s]", selection.Entries, entry)
	}
}

func TestLoadExtensionsWithoutManifestShipsNone(t *testing.T) {
	selection, err := loadExtensions(t.TempDir())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(selection.Entries) != 0 {
		t.Fatalf("entries = %v, want none", selection.Entries)
	}
}

func TestLoadExtensionsRejectsUntrustedEntries(t *testing.T) {
	outside := t.TempDir()
	external := filepath.Join(outside, "extension.js")
	if err := os.WriteFile(external, []byte("export {};\n"), 0o600); err != nil {
		t.Fatalf("write external: %v", err)
	}
	cases := []struct {
		name  string
		setup func(t *testing.T, root string) []string
	}{
		{
			name: "absolute",
			setup: func(t *testing.T, root string) []string {
				return []string{external}
			},
		},
		{
			name: "traversal",
			setup: func(t *testing.T, root string) []string {
				return []string{"../" + filepath.Base(outside) + "/extension.js"}
			},
		},
		{
			name: "missing",
			setup: func(t *testing.T, root string) []string {
				return []string{"gone/extension.js"}
			},
		},
		{
			name: "directory",
			setup: func(t *testing.T, root string) []string {
				if err := os.MkdirAll(filepath.Join(root, "dir"), 0o755); err != nil {
					t.Fatalf("mkdir: %v", err)
				}
				return []string{"dir"}
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			writeExtensions(t, root, testCase.setup(t, root))
			if _, err := loadExtensions(root); err == nil {
				t.Fatal("load succeeded, want an error")
			}
		})
	}
}

func TestLoadExtensionsRejectsASymlinkThatLeavesTheRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	external := filepath.Join(outside, "extension.js")
	if err := os.WriteFile(external, []byte("export {};\n"), 0o600); err != nil {
		t.Fatalf("write external: %v", err)
	}
	if err := os.Symlink(external, filepath.Join(root, "link.js")); err != nil {
		t.Skipf("symlink: %v", err)
	}
	writeExtensions(t, root, []string{"link.js"})
	if _, err := loadExtensions(root); err == nil {
		t.Fatal("load succeeded, want an error")
	}
}

// TestLoadExtensionsCarriesTheImageEnvironment proves the manifest's settings
// reach Pi, in a stable order, and that the adapter keeps its own variables.
func TestLoadExtensionsCarriesTheImageEnvironment(t *testing.T) {
	root := t.TempDir()
	entry := filepath.Join(root, "extension.js")
	if err := os.WriteFile(entry, []byte("export {};\n"), 0o600); err != nil {
		t.Fatalf("write entry: %v", err)
	}
	manifest := `{"extensions":["extension.js"],"env":{"UV_TOOL_DIR":"/opt/oac/uv-tools","CONTEXT_MODE_DATA_DIR":"/home/node/state/context-mode"},"tools":["serena_*","ctx_*"]}`
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte(manifest), 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	selection, err := loadExtensions(root)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	want := []string{"CONTEXT_MODE_DATA_DIR=/home/node/state/context-mode", "UV_TOOL_DIR=/opt/oac/uv-tools"}
	if strings.Join(selection.Env, "|") != strings.Join(want, "|") {
		t.Fatalf("env = %v, want %v", selection.Env, want)
	}
	if strings.Join(selection.Tools, ",") != "serena_*,ctx_*" {
		t.Fatalf("tools = %v, want the image's allowlist", selection.Tools)
	}
}

// TestLoadExtensionsRefusesReservedVariables keeps an image from redirecting
// Pi's own state or baking a credential into the Session environment.
func TestLoadExtensionsRefusesReservedVariables(t *testing.T) {
	for _, name := range []string{"HOME", "PATH", "PI_CODING_AGENT_DIR", "OAC_PI_MODEL_KEY", "SOME_API_KEY", "GITHUB_TOKEN"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			manifest := `{"extensions":[],"env":{"` + name + `":"/tmp/value"}}`
			if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte(manifest), 0o600); err != nil {
				t.Fatalf("write manifest: %v", err)
			}
			if _, err := loadExtensions(root); err == nil {
				t.Fatalf("%s accepted, want an error", name)
			}
		})
	}
}

// TestLoadExtensionsRejectsAnUnusableToolEntry keeps a malformed allowlist out
// of Pi's start-up arguments.
func TestLoadExtensionsRejectsAnUnusableToolEntry(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte(`{"extensions":[],"tools":["bad tool,with space"]}`), 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if _, err := loadExtensions(root); err == nil {
		t.Fatal("load succeeded, want an error")
	}
}
