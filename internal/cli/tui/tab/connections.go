package tab

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/config"
)

// connItem is a list.Item representing one connection.
type connItem struct {
	name   string
	conn   config.Connection
	active bool
}

func (c connItem) FilterValue() string { return c.name }
func (c connItem) Title() string {
	if c.active {
		return "* " + c.name
	}
	return "  " + c.name
}
func (c connItem) Description() string {
	return fmt.Sprintf("%s:%d / %s", c.conn.Host, c.conn.Port, c.conn.Database)
}

// confirmOverlay tracks the delete-confirmation state.
type confirmOverlay struct {
	targetName string
	confirmed  bool
	form       *huh.Form
}

// ConnectionsTab shows the list of configured connections, a detail panel for
// the selected one, and inline huh forms for add/edit/delete.
type ConnectionsTab struct {
	cfg     *config.Config
	cfgPath string
	list    list.Model

	// formOverlay is non-nil when add or edit form is open.
	formOverlay *huh.Form
	editingName string // empty = adding; non-empty = editing this connection name

	// deleteOverlay is non-nil when showing delete confirmation.
	deleteOverlay *confirmOverlay

	// form field bindings (reused across add/edit).
	fname, fhost, fport, fdatabase, fusername, fpassword string
	ftimeout                                              string

	width, height int
}

// NewConnectionsTab creates a ConnectionsTab populated from cfg.
func NewConnectionsTab(cfg *config.Config, cfgPath string) ConnectionsTab {
	ct := ConnectionsTab{
		cfg:     cfg,
		cfgPath: cfgPath,
	}
	ct.list = ct.buildList(80, 20)
	return ct
}

func (c ConnectionsTab) Title() string     { return "Connections" }
func (c ConnectionsTab) ShortHelp() string { return "a=add  e=edit  d=delete  Enter=switch" }

func (c ConnectionsTab) Init() tea.Cmd { return nil }

func (c ConnectionsTab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	// If a form overlay is open, route all input there first.
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
		listW := c.listWidth()
		c.list.SetWidth(listW)
		c.list.SetHeight(c.height - 4)
		return c, nil

	case tea.KeyMsg:
		switch {
		case msg.Type == tea.KeyEnter:
			return c.handleEnter()
		case msg.Type == tea.KeyRunes:
			switch string(msg.Runes) {
			case "a":
				return c.openAddForm()
			case "e":
				return c.openEditForm()
			case "d":
				return c.openDeleteOverlay()
			}
		case msg.Type == tea.KeyEsc:
			// Nothing to dismiss at top level.
			return c, nil
		}

	case tui.ConfigReloadedMsg:
		c.cfg = msg.Cfg
		c.list = c.buildList(c.width, c.height-4)
		return c, nil
	}

	// Delegate to list.
	var cmd tea.Cmd
	c.list, cmd = c.list.Update(msg)
	return c, cmd
}

func (c ConnectionsTab) View() string {
	if c.formOverlay != nil {
		return c.formOverlay.View()
	}
	if c.deleteOverlay != nil {
		return c.deleteOverlay.form.View()
	}

	if len(c.cfg.Connections) == 0 {
		return "No connections configured. Press a to add one.\n"
	}

	left := c.list.View()

	// Detail panel for the selected item.
	selected := c.list.SelectedItem()
	if selected == nil {
		return left
	}
	item, ok := selected.(connItem)
	if !ok {
		return left
	}

	detail := c.renderDetail(item)

	listW := c.listWidth()
	detailW := c.width - listW - 2
	if detailW < 10 {
		return left
	}

	return lipgloss.JoinHorizontal(lipgloss.Top, left, "  ", lipgloss.NewStyle().Width(detailW).Render(detail))
}

// ── internal helpers ─────────────────────────────────────────────────────────

func (c *ConnectionsTab) listWidth() int {
	if c.width == 0 {
		return 40
	}
	return c.width / 2
}

func (c *ConnectionsTab) buildList(width, height int) list.Model {
	items := c.toListItems()
	delegate := list.NewDefaultDelegate()
	delegate.ShowDescription = true
	l := list.New(items, delegate, width/2, height)
	l.Title = "Connections"
	l.SetShowStatusBar(false)
	l.SetFilteringEnabled(false)
	l.SetShowHelp(false)
	l.DisableQuitKeybindings()
	return l
}

func (c *ConnectionsTab) toListItems() []list.Item {
	names := make([]string, 0, len(c.cfg.Connections))
	for n := range c.cfg.Connections {
		names = append(names, n)
	}
	sort.Strings(names)

	items := make([]list.Item, len(names))
	for i, n := range names {
		items[i] = connItem{
			name:   n,
			conn:   c.cfg.Connections[n],
			active: n == c.cfg.ActiveConnection,
		}
	}
	return items
}

func (c *ConnectionsTab) renderDetail(item connItem) string {
	conn := item.conn
	var b strings.Builder
	b.WriteString(fmt.Sprintf("Name:     %s\n", item.name))
	b.WriteString(fmt.Sprintf("Host:     %s:%d\n", conn.Host, conn.Port))
	b.WriteString(fmt.Sprintf("Database: %s\n", conn.Database))
	b.WriteString(fmt.Sprintf("Username: %s\n", conn.Username))
	b.WriteString("Password: ****\n")
	timeout := conn.Timeout
	if timeout == 0 {
		timeout = 30
	}
	b.WriteString(fmt.Sprintf("Timeout:  %ds\n", timeout))
	return b.String()
}

// handleEnter switches the active connection to the selected item.
func (c ConnectionsTab) handleEnter() (tea.Model, tea.Cmd) {
	selected := c.list.SelectedItem()
	if selected == nil {
		return c, nil
	}
	item, ok := selected.(connItem)
	if !ok {
		return c, nil
	}
	if item.name == c.cfg.ActiveConnection {
		return c, nil
	}

	c.cfg.ActiveConnection = item.name
	_ = config.Save(c.cfgPath, c.cfg)

	// Rebuild list with updated active marker.
	c.list = c.buildList(c.width, c.height-4)

	newCfg := c.cfg
	return c, func() tea.Msg { return tui.ConfigReloadedMsg{Cfg: newCfg} }
}

// openAddForm opens a blank huh form to add a new connection.
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

// openEditForm opens a huh form pre-filled with the selected connection.
func (c ConnectionsTab) openEditForm() (tea.Model, tea.Cmd) {
	selected := c.list.SelectedItem()
	if selected == nil {
		return c, nil
	}
	item, ok := selected.(connItem)
	if !ok {
		return c, nil
	}

	c.editingName = item.name
	c.fname = item.name
	c.fhost = item.conn.Host
	c.fport = strconv.Itoa(item.conn.Port)
	c.fdatabase = item.conn.Database
	c.fusername = item.conn.Username
	c.fpassword = "****"
	timeout := item.conn.Timeout
	if timeout == 0 {
		timeout = 30
	}
	c.ftimeout = strconv.Itoa(timeout)
	c.formOverlay = c.buildForm(true)
	cmd := c.formOverlay.Init()
	return c, cmd
}

// openDeleteOverlay shows the delete confirmation form.
func (c ConnectionsTab) openDeleteOverlay() (tea.Model, tea.Cmd) {
	selected := c.list.SelectedItem()
	if selected == nil {
		return c, nil
	}
	item, ok := selected.(connItem)
	if !ok {
		return c, nil
	}

	confirmed := false
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(fmt.Sprintf("Delete connection %q?", item.name)).
				Description("This cannot be undone.").
				Value(&confirmed),
		),
	)

	c.deleteOverlay = &confirmOverlay{
		targetName: item.name,
		confirmed:  confirmed,
		form:       form,
	}
	cmd := form.Init()
	return c, cmd
}

// buildForm creates the huh form for add or edit.
func (c *ConnectionsTab) buildForm(isEdit bool) *huh.Form {
	nameField := huh.NewInput().
		Title("Connection name").
		Placeholder("mydb").
		Value(&c.fname)

	if !isEdit {
		nameField = nameField.Validate(func(s string) error {
			if strings.TrimSpace(s) == "" {
				return fmt.Errorf("connection name is required")
			}
			if _, exists := c.cfg.Connections[strings.TrimSpace(s)]; exists {
				return fmt.Errorf("connection %q already exists", s)
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
				Value(&c.fhost),
			huh.NewInput().
				Title("Port").
				Placeholder("3306").
				Validate(func(s string) error {
					p, err := strconv.Atoi(strings.TrimSpace(s))
					if err != nil || p < 1 || p > 65535 {
						return fmt.Errorf("port must be 1–65535")
					}
					return nil
				}).
				Value(&c.fport),
			huh.NewInput().
				Title("Database").
				Placeholder("myapp").
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("database is required")
					}
					return nil
				}).
				Value(&c.fdatabase),
			huh.NewInput().
				Title("Username").
				Placeholder("heydb_reader").
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("username is required")
					}
					return nil
				}).
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

// updateForm routes messages to the active huh form overlay.
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

// commitForm persists the form data and broadcasts ConfigReloadedMsg.
func (c ConnectionsTab) commitForm() (tea.Model, tea.Cmd) {
	port, _ := strconv.Atoi(strings.TrimSpace(c.fport))
	timeout, _ := strconv.Atoi(strings.TrimSpace(c.ftimeout))
	if port == 0 {
		port = 3306
	}
	if timeout == 0 {
		timeout = 30
	}

	password := c.fpassword
	if c.editingName != "" && password == "****" {
		// User did not change the password; keep the existing one.
		if existing, ok := c.cfg.Connections[c.editingName]; ok {
			password = existing.Password
		}
	}

	conn := config.Connection{
		Driver:   "mysql",
		Host:     strings.TrimSpace(c.fhost),
		Port:     port,
		Database: strings.TrimSpace(c.fdatabase),
		Username: strings.TrimSpace(c.fusername),
		Password: password,
		Timeout:  timeout,
	}

	name := strings.TrimSpace(c.fname)
	if c.editingName != "" && c.editingName != name {
		// Renamed — remove old key.
		delete(c.cfg.Connections, c.editingName)
		if c.cfg.ActiveConnection == c.editingName {
			c.cfg.ActiveConnection = name
		}
	}
	c.cfg.Connections[name] = conn
	if len(c.cfg.Connections) == 1 {
		c.cfg.ActiveConnection = name
	}

	_ = config.Save(c.cfgPath, c.cfg)

	c.formOverlay = nil
	c.editingName = ""
	c.list = c.buildList(c.width, c.height-4)

	newCfg := c.cfg
	return c, func() tea.Msg { return tui.ConfigReloadedMsg{Cfg: newCfg} }
}

// updateDelete routes messages to the delete-confirmation form.
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

// commitDelete removes the connection if the user confirmed.
func (c ConnectionsTab) commitDelete() (tea.Model, tea.Cmd) {
	targetName := c.deleteOverlay.targetName
	c.deleteOverlay = nil

	delete(c.cfg.Connections, targetName)
	if c.cfg.ActiveConnection == targetName {
		c.cfg.ActiveConnection = ""
	}

	_ = config.Save(c.cfgPath, c.cfg)
	c.list = c.buildList(c.width, c.height-4)

	newCfg := c.cfg
	return c, func() tea.Msg { return tui.ConfigReloadedMsg{Cfg: newCfg} }
}
