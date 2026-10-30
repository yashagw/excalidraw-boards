# Security

## Reporting a vulnerability

Please report vulnerabilities **privately** through
[GitHub's private vulnerability reporting](https://github.com/yashagw/excalidraw-boards/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it, and what an
attacker could do with it. You will get a reply within a week.

## Supported versions

Only the latest commit on `main` gets fixes.

## By design

Excalidraw Boards has **no authentication**: anyone who can reach it can read and
change every board, through the web app and through the MCP endpoint. It is meant
to run on localhost or a private network, as the
[self-hosting guide](docs/self-hosting.md#security) explains. Reports that amount
to "it has no login" are known and not treated as vulnerabilities. Ways to get
around that boundary, such as cross-site requests from a malicious page, or
reading or writing files outside the data directory, very much are.
