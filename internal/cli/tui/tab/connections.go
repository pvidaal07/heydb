package tab

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/config"
)

// ConnectionsTab shows the list of configured connections, a detail panel for
// the selected one, and inline huh forms for add/edit/delete.
type ConnectionsTab struct {
	cfg     *config.Config
	cfgPath string

	// Custom list state (no bubbles/list — simpler, matches gentle-ai style).
	names    []string
	cursor   int
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

// NewConnectionsTab creates a ConnectionsTab populated from cfg.
func NewConnectionsTab(cfg *config.Config, cfgPath string) ConnectionsTab {
	ct := ConnectionsTab{
		cfg:     cfg,
		cfgPath: cfgPath,
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
			}
			return c, nil
		case msg.Type == tea.KeyDown || (msg.Type == tea.KeyRunes && string(msg.Runes) == "j"):
			if c.cursor < len(c.names)-1 {
				c.cursor++
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

	case tui.ConfigReloadedMsg:
		c.cfg = msg.Cfg
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

	for i, name := range c.names {
		isActive := name == c.cfg.ActiveConnection
		conn := c.cfg.Connections[name]
		desc := fmt.Sprintf("%s:%d/%s", conn.Host, conn.Port, conn.Database)

		if i == c.cursor {
			label := name
			if isActive {
				label = name + " " + tui.SuccessStyle.Render("(active)")
			}
			b.WriteString(tui.SelectedStyle.Render(tui.Cursor + label))
			b.WriteString("\n")
			b.WriteString(tui.SubtextStyle.Render("    " + desc))
		} else {
			label := name
			if isActive {
				label = name + " " + tui.SuccessStyle.Render("(active)")
			}
			b.WriteString(tui.UnselectedStyle.Render("  " + label))
			b.WriteString("\n")
			b.WriteString(tui.SubtextStyle.Render("    " + desc))
		}
		b.WriteString("\n")
	}

	return b.String()
}

func (c *ConnectionsTab) renderDetail() string {
	if c.cursor >= len(c.names) {
		return ""
	}

	name := c.names[c.cursor]
	conn := c.cfg.Connections[name]
	timeout := conn.Timeout
	if timeout == 0 {
		timeout = 30
	}

	var b strings.Builder
	b.WriteString(tui.TitleStyle.Render(name))
	b.WriteString("\n\n")
	b.WriteString(c.detailRow("Host", fmt.Sprintf("%s:%d", conn.Host, conn.Port)))
	b.WriteString(c.detailRow("Database", conn.Database))
	b.WriteString(c.detailRow("Username", conn.Username))
	b.WriteString(c.detailRow("Password", "****"))
	b.WriteString(c.detailRow("Timeout", fmt.Sprintf("%ds", timeout)))

	if name == c.cfg.ActiveConnection {
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

func (c *ConnectionsTab) listWidth() int {
	if c.width == 0 {
		return 40
	}
	return c.width / 2
}

func (c *ConnectionsTab) refreshNames() {
	c.names = make([]string, 0, len(c.cfg.Connections))
	for n := range c.cfg.Connections {
		c.names = append(c.names, n)
	}
	sort.Strings(c.names)
}

func (c ConnectionsTab) handleEnter() (tea.Model, tea.Cmd) {
	if c.cursor >= len(c.names) {
		return c, nil
	}
	name := c.names[c.cursor]
	if name == c.cfg.ActiveConnection {
		return c, nil
	}

	c.cfg.ActiveConnection = name
	_ = config.Save(c.cfgPath, c.cfg)
	c.refreshNames()

	newCfg := c.cfg
	return c, func() tea.Msg { return tui.ConfigReloadedMsg{Cfg: newCfg} }
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
	conn := c.cfg.Connections[name]

	c.editingName = name
	c.fname = name
	c.fhost = conn.Host
	c.fport = strconv.Itoa(conn.Port)
	c.fdatabase = conn.Database
	c.fusername = conn.Username
	c.fpassword = "****"
	timeout := conn.Timeout
	if timeout == 0 {
		timeout = 30
	}
	c.ftimeout = strconv.Itoa(timeout)
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
						return fmt.Errorf("port must be 1-65535")
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
	timeout, _ := strconv.Atoi(strings.TrimSpace(c.ftimeout))
	if port == 0 {
		port = 3306
	}
	if timeout == 0 {
		timeout = 30
	}

	password := c.fpassword
	if c.editingName != "" && password == "****" {
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
	c.refreshNames()

	newCfg := c.cfg
	return c, func() tea.Msg { return tui.ConfigReloadedMsg{Cfg: newCfg} }
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

	delete(c.cfg.Connections, targetName)
	if c.cfg.ActiveConnection == targetName {
		c.cfg.ActiveConnection = ""
	}

	_ = config.Save(c.cfgPath, c.cfg)
	c.refreshNames()
	if c.cursor >= len(c.names) {
		c.cursor = max(0, len(c.names)-1)
	}

	newCfg := c.cfg
	return c, func() tea.Msg { return tui.ConfigReloadedMsg{Cfg: newCfg} }
}
