package pi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// extensionVariableName keeps image-declared variables recognisable.
var extensionVariableName = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// toolEntry accepts the names and globs Pi's --tools flag understands.
var toolEntry = regexp.MustCompile(`^[A-Za-z0-9_.*:-]+$`)

// extensionRootEnv names the directory that holds the image's Pi extensions.
// The daemon image supplies the directory and the manifest; a Session cannot
// name an extension path, so what runs is decided when the image is built.
const extensionRootEnv = "OAC_PI_EXTENSION_ROOT"

// defaultExtensionRoot matches the layout the Pi harness image uses.
const defaultExtensionRoot = "/opt/oac/extensions"

// extensionManifest lists extension entry points relative to the root and the
// environment those extensions need. The image owns both, so a Session cannot
// redirect an extension at a path or an endpoint of its choosing.
type extensionManifest struct {
	Extensions []string          `json:"extensions"`
	Env        map[string]string `json:"env"`
	Tools      []string          `json:"tools"`
}

// extensionSelection is what preparation hands Pi: explicit entry points and
// the image-declared environment the extensions read.
type extensionSelection struct {
	Entries []string
	Env     []string
	Tools   []string
}

// loadExtensions returns the absolute entry points of the image's extensions.
// A missing manifest means the image ships none, which keeps a plain Pi image
// working. A manifest that exists but cannot be trusted fails preparation
// instead of silently running fewer extensions than the operator declared.
func loadExtensions(root string) (extensionSelection, error) {
	if root == "" {
		root = defaultExtensionRoot
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return extensionSelection{}, fmt.Errorf("extension root %q: %w", root, err)
	}
	if resolvedRoot, err := filepath.EvalSymlinks(absoluteRoot); err == nil {
		absoluteRoot = resolvedRoot
	}
	raw, err := os.ReadFile(filepath.Join(absoluteRoot, "manifest.json"))
	if os.IsNotExist(err) {
		return extensionSelection{}, nil
	}
	if err != nil {
		return extensionSelection{}, fmt.Errorf("read extension manifest: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var manifest extensionManifest
	if err := decoder.Decode(&manifest); err != nil {
		return extensionSelection{}, fmt.Errorf("parse extension manifest: %w", err)
	}
	resolved := make([]string, 0, len(manifest.Extensions))
	for _, entry := range manifest.Extensions {
		path, err := resolveExtension(absoluteRoot, entry)
		if err != nil {
			return extensionSelection{}, err
		}
		resolved = append(resolved, path)
	}
	environment, err := extensionEnvironment(manifest.Env)
	if err != nil {
		return extensionSelection{}, err
	}
	tools, err := extensionTools(manifest.Tools)
	if err != nil {
		return extensionSelection{}, err
	}
	return extensionSelection{Entries: resolved, Env: environment, Tools: tools}, nil
}

// extensionEnvironment accepts the image's extension settings and refuses the
// variables the adapter owns, so an image cannot redirect Pi's own state or
// smuggle a credential into a Session.
func extensionEnvironment(values map[string]string) ([]string, error) {
	reserved := map[string]bool{
		"HOME":                true,
		"PATH":                true,
		"PI_CODING_AGENT_DIR": true,
		modelKeyEnv:           true,
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	environment := make([]string, 0, len(keys))
	for _, key := range keys {
		value := values[key]
		if !extensionVariableName.MatchString(key) {
			return nil, fmt.Errorf("extension manifest: variable %q is not an uppercase name", key)
		}
		if reserved[key] || strings.Contains(key, "KEY") || strings.Contains(key, "SECRET") || strings.Contains(key, "TOKEN") {
			return nil, fmt.Errorf("extension manifest: variable %q is reserved", key)
		}
		if value == "" || strings.ContainsAny(value, "\x00\n") {
			return nil, fmt.Errorf("extension manifest: variable %q has an unusable value", key)
		}
		environment = append(environment, key+"="+value)
	}
	return environment, nil
}

// resolveExtension confines one manifest entry to the root. Entries are
// relative so a manifest cannot point outside the image's extension directory,
// and the final path must be a regular file because Pi loads it directly.
func resolveExtension(root, entry string) (string, error) {
	if entry == "" {
		return "", fmt.Errorf("extension manifest: empty entry")
	}
	if filepath.IsAbs(entry) {
		return "", fmt.Errorf("extension manifest: entry %q must be relative to the extension root", entry)
	}
	cleaned := filepath.Clean(entry)
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("extension manifest: entry %q leaves the extension root", entry)
	}
	path := filepath.Join(root, cleaned)
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("extension manifest: entry %q: %w", entry, err)
	}
	if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
		return "", fmt.Errorf("extension manifest: entry %q resolves outside the extension root", entry)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("extension manifest: entry %q: %w", entry, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("extension manifest: entry %q is not a regular file", entry)
	}
	return resolved, nil
}

// extensionTools extends Pi's tool allowlist with the tools the image's
// extensions register. Entries follow Pi's own allowlist syntax, so an image
// can grant a namespace (ctx_*) without naming every tool.
func extensionTools(entries []string) ([]string, error) {
	tools := make([]string, 0, len(entries))
	seen := map[string]bool{}
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" || !toolEntry.MatchString(trimmed) {
			return nil, fmt.Errorf("extension manifest: tool %q is not a valid allowlist entry", entry)
		}
		if seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		tools = append(tools, trimmed)
	}
	return tools, nil
}
