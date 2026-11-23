#!/bin/sh
# Serve the app on http://localhost:8765 so it can be installed as an app (PWA).
# Keep the same port every time: the installed app belongs to this exact address.
cd "$(dirname "$(readlink -f "$0")")" || exit 1  # works when started through a link too
echo "12card: open http://localhost:8765 in Chrome (Ctrl+C to stop)"
exec python3 -m http.server 8765 --bind 127.0.0.1
