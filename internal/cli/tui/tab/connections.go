package tab

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
	"github.com/pvidaal07/heydb/internal/validation"
)

// ConnectionsTab shows the list of configured connections, a detail panel for
// the selected one, and inline huh forms for add/edit/delete.
type ConnectionsTab struct {
	connections []schema.Connection
	activeConn  string
	projectID   string
	store       ports.ConnectionStore

	names     []string
	cursor    int
	scrollOff int

	// formOverlay is non-nil when add or edit form is open.
	formOverlay *huh.Form
	editingName string

	// deleteOverlay is non-nil when showing delete confirmation.
	deleteOverlay *confirmOverlay

	// form field bindings.
	fname, fhost, fport, fdatabase, fusername, fpassword string
	ftimeout                                              string

	width, height int
}

type confirmOverlay struct {
	targetName string
	form       *huh.Form
}

// NewConnectionsTab creates a ConnectionsTab populated from a connections slice.
func NewConnectionsTab(conns []schema.Connection, activeConn, projectID string, store ports.ConnectionStore) ConnectionsTab {
	ct := ConnectionsTab{
		connections: conns,
		activeConn:  activeConn,
		projectID:   projectID,
		store:       store,
	}
	ct.refreshNames()
	return ct
}

func (c ConnectionsTab) Title() string     { return "Connections" }
func (c ConnectionsTab) ShortHelp() string { return "a: add  e: edit  d: delete  enter: switch" }

func (c ConnectionsTab) Init() tea.Cmd { return nil }

func (c ConnectionsTab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if c.formOverlay != nil {
		return c.updateForm(msg)
	}
	if c.deleteOverlay != nil {
		return c.updateDelete(msg)
	}

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		c.width = msg.Width
		c.height = msg.Height
		return c, nil

	case tea.KeyMsg:
		switch {
		case msg.Type == tea.KeyEnter:
			return c.handleEnter()
		case msg.Type == tea.KeyUp || (msg.Type == tea.KeyRunes && string(msg.Runes) == "k"):
			if c.cursor > 0 {
				c.cursor--
				if c.cursor < c.scrollOff {
					c.scrollOff = c.cursor
				}
			}
			return c, nil
		case msg.Type == tea.KeyDown || (msg.Type == tea.KeyRunes && string(msg.Runes) == "j"):
			if c.cursor < len(c.names)-1 {
				c.cursor++
				vis := c.maxVisibleItems()
				if c.cursor >= c.scrollOff+vis {
					c.scrollOff = c.cursor - vis + 1
				}
			}
			return c, nil
		case msg.Type == tea.KeyRunes:
			switch string(msg.Runes) {
			case "a":
				return c.openAddForm()
			case "e":
				return c.openEditForm()
			case "d":
				return c.openDeleteOverlay()
			}
		}

	case tui.ConnectionsChangedMsg:
		c.connections = msg.Connections
		c.activeConn = msg.ActiveConnName
		c.refreshNames()
		if c.cursor >= len(c.names) {
			c.cursor = max(0, len(c.names)-1)
		}
		return c, nil
	}

	return c, nil
}

func (c ConnectionsTab) View() string {
	if c.formOverlay != nil {
		return c.formOverlay.View()
	}
	if c.deleteOverlay != nil {
		return c.deleteOverlay.form.View()
	}

	if len(c.names) == 0 {
		return tui.EmptyStateStyle.Render("No connections configured. Press a to add one.")
	}

	left := c.renderList()
	detail := c.renderDetail()

	listW := c.listWidth()
	detailW := c.width - listW - 4
	if detailW < 20 {
		return left
	}

	leftStyled := lipgloss.NewStyle().Width(listW).Render(left)
	detailStyled := tui.DetailPanelStyle.Width(detailW).Render(detail)

	return lipgloss.JoinHorizontal(lipgloss.Top, leftStyled, "  ", detailStyled)
}

// ── rendering ────────────────────────────────────────────────────────────────

func (c *ConnectionsTab) renderList() string {
	var b strings.Builder
	b.WriteString(tui.HeadingStyle.Render("Connections"))
	b.WriteString("\n\n")

	vis := c.maxVisibleItems()
	start := c.scrollOff
	end := start + vis
	if end > len(c.names) {
		end = len(c.names)
	}

	for i := start; i < end; i++ {
		name := c.names[i]
		isActive := name == c.activeConn
		conn := c.findConn(name)
		desc := fmt.Sprintf("%s:%d/%s", conn.Host, conn.Port, conn.Database)

		label := name
		if isActive {
			label = name + " " + tui.SuccessStyle.Render("(active)")
		}

		if i == c.cursor {
			b.WriteString(tui.SelectedStyle.Render(tui.Cursor + label))
		} else {
			b.WriteString(tui.UnselectedStyle.Render("  " + label))
		}
		b.WriteString("\n")
		b.WriteString(tui.SubtextStyle.Render("    " + desc))
		b.WriteString("\n")
	}

	if len(c.names) > vis {
		b.WriteString(tui.SubtextStyle.Render(fmt.Sprintf("  %d–%d of %d connections", start+1, end, len(c.names))))
	}

	return b.String()
}

func (c *ConnectionsTab) renderDetail() string {
	if c.cursor >= len(c.names) {
		return ""
	}

	name := c.names[c.cursor]
	conn := c.findConn(name)

	var b strings.Builder
	b.WriteString(tui.TitleStyle.Render(name))
	b.WriteString("\n\n")
	b.WriteString(c.detailRow("Host", fmt.Sprintf("%s:%d", conn.Host, conn.Port)))
	b.WriteString(c.detailRow("Database", conn.Database))
	b.WriteString(c.detailRow("Username", conn.User))
	b.WriteString(c.detailRow("Password", "****"))

	if name == c.activeConn {
		b.WriteString("\n")
		b.WriteString(tui.SuccessStyle.Render("Active connection"))
	}

	return b.String()
}

func (c *ConnectionsTab) detailRow(label, value string) string {
	return tui.DetailLabelStyle.Render(fmt.Sprintf("%-10s", label)) + " " +
		tui.DetailValueStyle.Render(value) + "\n"
}

// ── internal helpers ─────────────────────────────────────────────────────────

func (c *ConnectionsTab) maxVisibleItems() int {
	n := (c.height - 3) / 2 // heading(1) + blank(1) + indicator(1), each item = 2 lines
	if n < 1 {
		n = 1
	}
	return n
}

func (c *ConnectionsTab) listWidth() int {
	if c.width == 0 {
		return 40
	}
	return c.width / 2
}

func (c *ConnectionsTab) refreshNames() {
	c.names = make([]string, 0, len(c.connections))
	for _, conn := range c.connections {
		c.names = append(c.names, conn.Name)
	}
	sort.Strings(c.names)
}

// findConn returns the connection with the given name, or a zero-value Connection.
func (c *ConnectionsTab) findConn(name string) schema.Connection {
	for _, conn := range c.connections {
		if conn.Name == name {
			return conn
		}
	}
	return schema.Connection{}
}

func (c ConnectionsTab) handleEnter() (tea.Model, tea.Cmd) {
	if c.cursor >= len(c.names) {
		return c, nil
	}
	name := c.names[c.cursor]
	if name == c.activeConn {
		return c, nil
	}

	ctx := context.Background()
	_ = c.store.SetActive(ctx, c.projectID, name)
	conns, _ := c.store.ListConnections(ctx, c.projectID)
	c.connections = conns
	c.activeConn = name
	c.refreshNames()

	snapshot := tui.ConnectionsChangedMsg{Connections: conns, ActiveConnName: name}
	return c, func() tea.Msg { return snapshot }
}

func (c ConnectionsTab) openAddForm() (tea.Model, tea.Cmd) {
	c.editingName = ""
	c.fname = ""
	c.fhost = "127.0.0.1"
	c.fport = "3306"
	c.fdatabase = ""
	c.fusername = ""
	c.fpassword = ""
	c.ftimeout = "30"
	c.formOverlay = c.buildForm(false)
	cmd := c.formOverlay.Init()
	return c, cmd
}

func (c ConnectionsTab) openEditForm() (tea.Model, tea.Cmd) {
	if c.cursor >= len(c.names) {
		return c, nil
	}
	name := c.names[c.cursor]
	conn := c.findConn(name)

	c.editingName = name
	c.fname = name
	c.fhost = conn.Host
	c.fport = strconv.Itoa(conn.Port)
	c.fdatabase = conn.Database
	c.fusername = conn.User
	c.fpassword = "****"
	c.ftimeout = "30"
	c.formOverlay = c.buildForm(true)
	cmd := c.formOverlay.Init()
	return c, cmd
}

func (c ConnectionsTab) openDeleteOverlay() (tea.Model, tea.Cmd) {
	if c.cursor >= len(c.names) {
		return c, nil
	}
	name := c.names[c.cursor]

	confirmed := false
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(fmt.Sprintf("Delete connection %q?", name)).
				Description("This cannot be undone.").
				Value(&confirmed),
		),
	)

	c.deleteOverlay = &confirmOverlay{
		targetName: name,
		form:       form,
	}
	cmd := form.Init()
	return c, cmd
}

func (c *ConnectionsTab) buildForm(isEdit bool) *huh.Form {
	nameField := huh.NewInput().
		Title("Connection name").
		Placeholder("mydb").
		Value(&c.fname)

	if !isEdit {
		nameField = nameField.Validate(func(s string) error {
			if err := validation.ValidateConnectionName(strings.TrimSpace(s)); err != nil {
				return err
			}
			for _, conn := range c.connections {
				if conn.Name == strings.TrimSpace(s) {
					return fmt.Errorf("connection %q already exists", s)
				}
			}
			return nil
		})
	}

	return huh.NewForm(
		huh.NewGroup(
			nameField,
			huh.NewInput().
				Title("Host").
				Placeholder("127.0.0.1").
				Validate(func(s string) error {
					return validation.ValidateHost(strings.TrimSpace(s))
				}).
				Value(&c.fhost),
			huh.NewInput().
				Title("Port").
				Placeholder("3306").
				Validate(func(s string) error {
					p, err := strconv.Atoi(strings.TrimSpace(s))
					if err != nil || p < 1 || p > 65535 {
						return fmt.Errorf("port must be 1-65535")
					}
					return nil
				}).
				Value(&c.fport),
			huh.NewInput().
				Title("Database").
				Placeholder("myapp").
				Validate(validation.ValidateMySQLIdentifier).
				Value(&c.fdatabase),
			huh.NewInput().
				Title("Username").
				Placeholder("heydb_reader").
				Validate(validation.ValidateMySQLIdentifier).
				Value(&c.fusername),
			huh.NewInput().
				Title("Password").
				EchoMode(huh.EchoModePassword).
				Value(&c.fpassword),
			huh.NewInput().
				Title("Timeout (seconds)").
				Placeholder("30").
				Validate(func(s string) error {
					t, err := strconv.Atoi(strings.TrimSpace(s))
					if err != nil || t < 1 {
						return fmt.Errorf("timeout must be a positive number")
					}
					return nil
				}).
				Value(&c.ftimeout),
		),
	)
}

func (c ConnectionsTab) updateForm(msg tea.Msg) (tea.Model, tea.Cmd) {
	if msg, ok := msg.(tea.KeyMsg); ok && msg.Type == tea.KeyEsc {
		c.formOverlay = nil
		c.editingName = ""
		return c, nil
	}

	form, cmd := c.formOverlay.Update(msg)
	if f, ok := form.(*huh.Form); ok {
		c.formOverlay = f
	}

	if c.formOverlay.State == huh.StateCompleted {
		return c.commitForm()
	}
	if c.formOverlay.State == huh.StateAborted {
		c.formOverlay = nil
		c.editingName = ""
		return c, nil
	}

	return c, cmd
}

func (c ConnectionsTab) commitForm() (tea.Model, tea.Cmd) {
	port, _ := strconv.Atoi(strings.TrimSpace(c.fport))
	if port == 0 {
		port = 3306
	}

	password := c.fpassword
	if c.editingName != "" && password == "****" {
		// Preserve existing password on edit.
		existing := c.findConn(c.editingName)
		password = existing.Password
	}

	name := strings.TrimSpace(c.fname)

	conn := schema.Connection{
		ProjectID: c.projectID,
		Name:      name,
		Host:      strings.TrimSpace(c.fhost),
		Port:      port,
		Database:  strings.TrimSpace(c.fdatabase),
		User:      strings.TrimSpace(c.fusername),
		Password:  password,
	}

	ctx := context.Background()

	// If renaming, delete the old entry first.
	if c.editingName != "" && c.editingName != name {
		_ = c.store.DeleteConnection(ctx, c.projectID, c.editingName)
		if c.activeConn == c.editingName {
			c.activeConn = name
		}
	}

	_ = c.store.SaveConnection(ctx, c.projectID, conn)

	// If this is the first connection, make it active.
	conns, _ := c.store.ListConnections(ctx, c.projectID)
	activeName := c.activeConn
	if len(conns) == 1 {
		_ = c.store.SetActive(ctx, c.projectID, name)
		activeName = name
		conns, _ = c.store.ListConnections(ctx, c.projectID)
	}

	c.connections = conns
	c.activeConn = activeName
	c.formOverlay = nil
	c.editingName = ""
	c.refreshNames()

	snapshot := tui.ConnectionsChangedMsg{Connections: conns, ActiveConnName: activeName}
	return c, func() tea.Msg { return snapshot }
}

func (c ConnectionsTab) updateDelete(msg tea.Msg) (tea.Model, tea.Cmd) {
	if msg, ok := msg.(tea.KeyMsg); ok && msg.Type == tea.KeyEsc {
		c.deleteOverlay = nil
		return c, nil
	}

	form, cmd := c.deleteOverlay.form.Update(msg)
	if f, ok := form.(*huh.Form); ok {
		c.deleteOverlay.form = f
	}

	if c.deleteOverlay.form.State == huh.StateCompleted {
		return c.commitDelete()
	}
	if c.deleteOverlay.form.State == huh.StateAborted {
		c.deleteOverlay = nil
		return c, nil
	}

	return c, cmd
}

func (c ConnectionsTab) commitDelete() (tea.Model, tea.Cmd) {
	targetName := c.deleteOverlay.targetName
	c.deleteOverlay = nil

	ctx := context.Background()
	_ = c.store.DeleteConnection(ctx, c.projectID, targetName)

	activeName := c.activeConn
	if activeName == targetName {
		activeName = ""
	}

	conns, _ := c.store.ListConnections(ctx, c.projectID)
	c.connections = conns
	c.activeConn = activeName
	c.refreshNames()
	if c.cursor >= len(c.names) {
		c.cursor = max(0, len(c.names)-1)
	}

	snapshot := tui.ConnectionsChangedMsg{Connections: conns, ActiveConnName: activeName}
	return c, func() tea.Msg { return snapshot }
}
