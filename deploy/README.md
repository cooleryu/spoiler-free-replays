# Shared match directory

The public service only serves `GET /replays/catalog.json`. It has no login,
playback, media proxy, configurable upstream URL, or arbitrary search endpoint.
Clients retain their own Bilibili sessions and revalidate video metadata locally.

Run `npm ci --ignore-scripts`, then `npm run catalog:serve` with Node.js 24.
The service listens on `127.0.0.1:4320`. An existing HTTPS reverse proxy should
expose only this directory route. Keep the ordinary local app private.

The configured Bilibili series supplies the official replay list. Successful
results are shared for five minutes and concurrent refreshes share one request.
If the source fails or returns no recent matches while a recent list is available,
the previous list and its original timestamp remain visible with a warning.
Failed refreshes are retried at most once per thirty seconds.
There is no background timer or paid AI dependency.

`spoiler-free-catalog.service` is an example systemd unit. Its installation uses
`/opt/spoiler-free-catalog/current` for code and a dedicated state directory for
the cache. Deploy new code to a separate release directory, preserve the previous
symlink and reverse-proxy configuration, validate the proxy configuration, then
reload. The public service never needs the user's browser or Bilibili credentials.
