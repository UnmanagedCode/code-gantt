#!/usr/bin/env bash
# Link the main checkout's node_modules and .wiki into each new worktree.
#
# Contract (cc's runWorktreeHook): cwd is the new worktree, CC_PARENT_PATH is the
# main checkout, and the script runs as `bash <script>`. Idempotent: an entry that
# already exists in the worktree is left alone, so a real directory is never replaced.

set -euo pipefail

PARENT="${CC_PARENT_PATH:?CC_PARENT_PATH is unset — cc passes it when it runs this hook}"

link_from_parent() {
    local name="$1"
    local target="${PARENT}/${name}"

    if [ -e "$name" ] || [ -L "$name" ]; then
        echo "[post-worktree-create] ${name} already exists — skipping symlink."
    elif [ ! -d "$target" ]; then
        echo "[post-worktree-create] WARNING: ${target} not found; skipping ${name} symlink." >&2
    else
        ln -s "$target" "$name"
        echo "[post-worktree-create] Symlinked ${name} from ${target}."
    fi
}

link_from_parent node_modules
link_from_parent .wiki
