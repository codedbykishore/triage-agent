#!/bin/bash
# mock-kiro.sh — Simulates headless Kiro CLI for demo purposes.
#
# When invoked, reads error.log in cwd, identifies the bug, and applies a fix.
# This mimics what the real Kiro agent would do inside the worktree.
#
# Called as: kiro chat --headless --no-interactive --system-prompt "<prompt>"
# We ignore all arguments and just operate on cwd.
#
# Exit 0 = fix produced. Non-zero = failed.

set -e

# The cwd is the worktree directory (set by kiroRunner.js)
WORKTREE_DIR="$(pwd)"

if [ ! -f "$WORKTREE_DIR/error.log" ]; then
  echo "No error.log found in $WORKTREE_DIR" >&2
  exit 1
fi

ERROR_CONTENT=$(cat "$WORKTREE_DIR/error.log")

# Detect error type and apply the appropriate fix
if echo "$ERROR_CONTENT" | grep -q "Cannot read properties of null"; then
  echo "Detected: Null pointer dereference in readUserId()"
  echo "Applying fix: Add null guard before accessing user.profile.id"
  
  # Fix the null pointer bug in server.js
  if [ -f "$WORKTREE_DIR/server.js" ]; then
    sed -i 's/function readUserId() {/function readUserId() {/' "$WORKTREE_DIR/server.js"
    sed -i '/const user = null;/,/return user\.profile\.id;/{
      s/const user = null;.*$/const user = null; \/\/ simulated: lookup miss returns null/
      s/return user\.profile\.id;.*$/if (!user || !user.profile) { return "unknown"; } return user.profile.id;/
    }' "$WORKTREE_DIR/server.js"
    echo "Fixed: server.js — added null guard in readUserId()"
  fi

elif echo "$ERROR_CONTENT" | grep -q "JSON"; then
  echo "Detected: Unguarded JSON.parse"
  echo "Applying fix: Wrap JSON.parse in try-catch"
  
  if [ -f "$WORKTREE_DIR/server.js" ]; then
    sed -i 's/function parseConfig(body) {/function parseConfig(body) {/' "$WORKTREE_DIR/server.js"
    sed -i '/function parseConfig/,/^}/{
      s/return JSON\.parse(body);.*$/try { return JSON.parse(body); } catch (e) { return {}; }/
    }' "$WORKTREE_DIR/server.js"
    echo "Fixed: server.js — wrapped JSON.parse in try-catch"
  fi

else
  echo "Error type not recognized — cannot produce fix" >&2
  exit 1
fi

echo ""
echo "Summary: Applied minimal fix for the reported runtime error."
echo "Changed files: server.js"
exit 0
