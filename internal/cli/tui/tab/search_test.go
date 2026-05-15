package tab_test

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/cli/tui/tab"
)

func TestSearchTab_Title(t *testing.T) {
	st := tab.NewSearchTab()
	if st.Title() != "Search" {
		t.Errorf("expected Title() == 'Search', got %q", st.Title())
	}
}

func TestSearchTab_EmptyState_NoQuery(t *testing.T) {
	st := tab.NewSearchTab()

	// Set a store so we're past the "no connection" state.
	store := threeTableStore()
	updated, _ := st.Update(tui.StoreOpenedMsg{Store: store})
	st = updated.(tab.SearchTab)

	view := st.View()
	if !strings.Contains(view, "Enter") && !strings.Contains(view, "search") {
		t.Errorf("expected 'search' prompt in view, got:\n%s", view)
	}
}

func TestSearchTab_EnterTriggersSearch(t *testing.T) {
	st := tab.NewSearchTab()

	// Provide a store.
	store := threeTableStore()
	updated, _ := st.Update(tui.StoreOpenedMsg{Store: store})
	st = updated.(tab.SearchTab)

	// Set window size.
	updated, _ = st.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	st = updated.(tab.SearchTab)

	// Type "user" into the search field and press Enter.
	for _, ch := range []rune("user") {
		updated, _ = st.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{ch}})
		st = updated.(tab.SearchTab)
	}
	updated, _ = st.Update(tea.KeyMsg{Type: tea.KeyEnter})
	st = updated.(tab.SearchTab)

	view := st.View()
	if !strings.Contains(view, "users") {
		t.Errorf("expected search results to contain 'users', got:\n%s", view)
	}
}

func TestSearchTab_NoResults_EmptyState(t *testing.T) {
	st := tab.NewSearchTab()

	store := threeTableStore()
	updated, _ := st.Update(tui.StoreOpenedMsg{Store: store})
	st = updated.(tab.SearchTab)

	updated, _ = st.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	st = updated.(tab.SearchTab)

	// Type something that won't match.
	for _, ch := range []rune("xyznonexistent") {
		updated, _ = st.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{ch}})
		st = updated.(tab.SearchTab)
	}
	updated, _ = st.Update(tea.KeyMsg{Type: tea.KeyEnter})
	st = updated.(tab.SearchTab)

	view := st.View()
	if !strings.Contains(view, "No") && !strings.Contains(view, "no") {
		t.Errorf("expected no-results message in view, got:\n%s", view)
	}
}

func TestSearchTab_EnterOnResult_EmitsSwitchTabMsg(t *testing.T) {
	st := tab.NewSearchTab()

	store := threeTableStore()
	updated, _ := st.Update(tui.StoreOpenedMsg{Store: store})
	st = updated.(tab.SearchTab)

	updated, _ = st.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	st = updated.(tab.SearchTab)

	// Search for "users".
	for _, ch := range []rune("users") {
		updated, _ = st.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{ch}})
		st = updated.(tab.SearchTab)
	}
	updated, _ = st.Update(tea.KeyMsg{Type: tea.KeyEnter})
	st = updated.(tab.SearchTab)

	// Press Enter on the first result to navigate to Schema tab.
	_, cmd := st.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if cmd == nil {
		t.Fatal("expected a cmd from Enter on result, got nil")
	}
	msg := cmd()
	switchMsg, ok := msg.(tui.SwitchTabMsg)
	if !ok {
		t.Errorf("expected tui.SwitchTabMsg, got %T", msg)
	}
	if switchMsg.Index != 1 {
		t.Errorf("expected SwitchTabMsg.Index == 1 (Schema tab), got %d", switchMsg.Index)
	}
}
