#!/bin/zsh

# macOS double-click launcher — thin wrapper around run-web.sh so both entry
# points share one implementation. Launches Dictypio in the browser only
# (backend + Vite dev server).

# This script lives in Setup/; ${0:A:h:h} is the project root.
PROJECT_DIR="${0:A:h:h}"

# Double-click launches get a sparse PATH; add common Node/Homebrew paths.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

cd "$PROJECT_DIR" || { echo "Could not enter $PROJECT_DIR"; }

bash "$PROJECT_DIR/Setup/run-web.sh"

# Keep the Terminal window open after the servers stop so any error is visible.
echo ""
echo "Dictypio web servers have stopped."
echo "Press any key to close this window..."
read -k 1 -s
