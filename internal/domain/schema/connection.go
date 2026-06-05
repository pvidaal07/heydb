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

// IsAgnostic returns true when this connection has no specific database target.
// An agnostic connection introspects all databases accessible to the MySQL user.
func (c Connection) IsAgnostic() bool {
	return c.Database == ""
}

// DSN returns a go-sql-driver/mysql compatible DSN string for the connection.
// When Database is empty (agnostic), the database path segment is omitted:
//
//	user:pass@tcp(host:port)/?parseTime=true
func (c Connection) DSN() string {
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?parseTime=true",
		c.User, c.Password, c.Host, c.Port, c.Database)
}
