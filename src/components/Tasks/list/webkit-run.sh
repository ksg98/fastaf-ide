#!/bin/sh
set -eu
# The bundled wrapper replaces LD_LIBRARY_PATH, hiding workspace-only libraries.
task_webkit="${PLAYWRIGHT_BROWSERS_PATH:?}/webkit-2370/minibrowser-wpe"
export WEBKIT_EXEC_PATH="$task_webkit/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="$task_webkit/lib"
export WEBKIT_INSPECTOR_RESOURCES_PATH="$task_webkit/share"
export LD_LIBRARY_PATH="$task_webkit/lib:$task_webkit/sys/lib:${LD_LIBRARY_PATH:-}"
export WEBKIT_FORCE_COMPLEX_TEXT=1
exec "$task_webkit/bin/MiniBrowser" "$@"
