# Git operation snapshots

This extension captures one non-mutating Git snapshot per durable Pi operation.
It uses `git stash create`, anchors the resulting commit under
`refs/pi/operation-snapshots/<session>/<operation>`, and records only bounded
metadata in the Pi session.

The snapshot covers staged and unstaged tracked files. Untracked files,
ignored files, dirty submodules, ref changes, and remote effects are reported
but not captured. The extension never runs `git stash apply` and never updates
the user's `refs/stash`.

If Git reports a conflicted index or snapshot creation fails, read-only tools
remain available but mutation-capable tools are blocked for that operation.
Private snapshot refs are intentionally retained until an operator applies a
repository-specific retention policy.

Install by copying or symlinking this directory into an extension directory:

```bash
ln -s /path/to/pi/packages/coding-agent/examples/extensions/git-operation-snapshots \
  ~/.pi/agent/extensions/git-operation-snapshots
```
