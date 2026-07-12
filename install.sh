#!/usr/bin/env bash
# Install Aqua Dock into the current user's GNOME Shell extensions.
set -euo pipefail

UUID="aqua-dock@aedgecombe.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "Installing ${UUID}..."

rm -rf "${DEST}"
mkdir -p "${DEST}/schemas"

cp "${SRC}/metadata.json"  "${DEST}/"
cp "${SRC}/extension.js"   "${DEST}/"
cp "${SRC}/prefs.js"       "${DEST}/"
cp "${SRC}/stylesheet.css" "${DEST}/"
cp "${SRC}/schemas/"*.gschema.xml "${DEST}/schemas/"

echo "Compiling settings schema..."
glib-compile-schemas "${DEST}/schemas/"

echo
echo "Installed to ${DEST}"
echo
echo "Next steps:"
echo "  • On Wayland (your session): log out and back in, then run:"
echo "        gnome-extensions enable ${UUID}"
echo "  • On Xorg: press Alt+F2, type 'r', Enter — then enable as above."
echo
echo "  Open settings any time with:"
echo "        gnome-extensions prefs ${UUID}"
