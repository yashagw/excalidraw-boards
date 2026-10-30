# Self-hosting

One container, one port (3779), one data directory. No database.

## Docker Compose

The repository's `compose.yml` builds the image (a minute or two the first time)
and keeps boards in `./data`:

```sh
docker compose up -d
docker compose logs -f
```

To run the image yourself:

```sh
docker build -t excalidraw-boards .
docker run -d --name excalidraw-boards -p 127.0.0.1:3779:3779 \
  -e PUBLIC_URL=http://localhost:3779 \
  -v "$PWD/data:/data" excalidraw-boards
```

The image builds on amd64 and arm64. The server runs as root unless you pass a
user; to run as yourself, add `--user "$(id -u):$(id -g)"` and make sure that
user owns the data directory.

## Security

**There is no authentication.** Whoever reaches the port can read, change and
delete every board, and so can any MCP client pointed at it. That is fine on
`localhost` or a private network, and only there. Do one of these:

- Keep it on localhost. The Compose file publishes the port on `127.0.0.1` only;
  change it to `"3779:3779"` only on a network you trust.
- Put it on a private network such as [Tailscale](https://tailscale.com) or
  WireGuard, and do not expose it to the internet.
- If it must be public, put it behind a proxy that authenticates (for example
  oauth2-proxy, Authelia, Cloudflare Access) and note that MCP clients then need
  to pass that authentication too.

## Behind a reverse proxy

Any HTTP proxy works. Two things matter: allow large request bodies (pasted
images go into the board, up to 64 MB per save) and do not buffer
`/api/events`, which is a server-sent event stream that carries live updates.

Caddy (both are handled by default):

```
draw.example.com {
	reverse_proxy localhost:3779
}
```

nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3779;
    client_max_body_size 64m;
}
location /api/events {
    proxy_pass http://127.0.0.1:3779;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

Set `PUBLIC_URL` to the public address so links in MCP results point at it.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `3779` | Port the server listens on |
| `DATA_DIR` | `./data` (`/data` in the image) | Boards, trash, history and the library |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL for board links in MCP results |

## Backups

The data directory is the whole state, as plain files: back it up with whatever
you use for files (`rsync`, `restic`, a nightly `tar`). A file copy taken while
the server runs is safe, because boards are written to a temporary file and then
renamed into place.

For mistakes rather than disasters, the server keeps its own safety nets:
deleted boards go to `trash/`, and earlier versions to `history/`
([details](boards.md#history)).

## Upgrading

```sh
git pull
docker compose up -d --build
```

Boards are standard Excalidraw files, so they are not tied to a version of this
app.
