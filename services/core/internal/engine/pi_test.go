package engine

import "testing"

// piProfile joins the public catalog with the Pi execution runtime, so its
// declaration must pass the same validation every catalog entry does.
func TestPiProfileDeclaration(t *testing.T) {
	catalog := NewCatalog(map[string]Profile{"pi": piProfile()})
	profile, ok := catalog.Lookup("pi")
	if !ok {
		t.Fatal("pi profile is not registered")
	}
	if !profile.Accepts("self_hosted") || !profile.Accepts("none") {
		t.Fatalf("pi placements must cover none and self_hosted: %v", profile.Placements)
	}
	if profile.Accepts("openai_hosted") {
		t.Fatal("pi placement openai_hosted requires a qualified Runtime image")
	}
}
