#!/bin/sh
# Launches the packaged app inside the Flatpak sandbox. zypak — shipped by
# org.electronjs.Electron2.BaseApp — nests the Chromium sandbox inside the
# Flatpak one, which is why this goes through zypak-wrapper.sh rather than
# exec'ing the binary directly.

FLAGS=""

if [ -n "$WAYLAND_DISPLAY" ] || [ "$XDG_SESSION_TYPE" = "wayland" ]; then
  FLAGS="$FLAGS --enable-features=UseOzonePlatform --ozone-platform=wayland"
fi

# The Bare worker writes scratch files; point it at the per-application
# runtime directory, which Flatpak guarantees exists and is ours.
export TMPDIR="${XDG_RUNTIME_DIR:-/tmp}"

# FLATPAK_ID is set by Flatpak at runtime. The binary keeps the packaged
# productName, LightchainChat, exactly as forge's package step produced it.
exec zypak-wrapper.sh "/app/lib/${FLATPAK_ID}/LightchainChat" $FLAGS "$@"
