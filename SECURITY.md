# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Report it privately through GitHub: [new security advisory](https://github.com/pvidaal07/heydb/security/advisories/new).

Include what you found, how to reproduce it, and its impact. Do not include real credentials or data. You will get an answer within a few days, and credit in the advisory if you want it.

## What matters most

heydb handles database credentials and reads production schemas, so these are in scope:

- passwords or other secrets leaking into files git can see, chat output, logs or error messages;
- any way to write to a database through heydb (sessions are read-only);
- agent tools reaching a database or files outside the project's `.heydb/`;
- path traversal or symlink tricks in `.heydb/` (connection names, snapshots, knowledge files);
- the release pipeline (workflows, npm publishing).

## Supported versions

| Version | Supported |
|---|---|
| 2.x (beta) | Yes |
| 1.x (Go, archived at `v1.3.1`) | No |
