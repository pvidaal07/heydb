package schema

import "fmt"

// Connection represents a database connection stored in the global DB.
// It replaces config.Connection from v1.
type Connection struct {
	ID        int
	ProjectID string
	Name      string
	Host      string
	Port      int
	Database  string
	User      string
	Password  string
	Active    bool
	SyncedAt  string
}

// DSN returns a go-sql-driver/mysql compatible DSN string for the connection.
func (c Connection) DSN() string {
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?parseTime=true",
		c.User, c.Password, c.Host, c.Port, c.Database)
}
