# nvim-diff-review-opencode-plugin

An agent-driven guided code review tool for Neovim and [OpenCode](https://opencode.ai). An AI agent walks you through code changes file by file, showing side-by-side diffs in Neovim while discussing the changes in a separate OpenCode chat.

## How it works

The plugin connects an OpenCode agent to Neovim's [diffview.nvim](https://github.com/sindrets/diffview.nvim) via Neovim's built-in RPC socket. The agent can open diffs, navigate between files, and query the current review state — all while the user interacts via the OpenCode chat.

```
┌────────────────────────────┬──────────────────────┐
│                            │                      │
│  Neovim showing diff of    │  OpenCode agent:     │
│  src/store/selectors.js    │                      │
│                            │  "I refactored the   │
│  - old code in red         │   getBlockName func  │
│  + new code in green       │   to handle the new  │
│                            │   edge case where..." │
│                            │                      │
│                            │  Any questions about  │
│                            │  these changes?       │
└────────────────────────────┴──────────────────────┘
```

The review workflow:

1. Agent opens a diff view in Neovim (scoped to specific files or all uncommitted changes)
2. Agent explains the changes in the current file
3. User asks questions or leaves feedback — agent notes it but **does not edit files**
4. Agent navigates to the next file and repeats
5. After the last file, agent closes the diff view
6. Agent proposes a commit message and commits the original work
7. If feedback was left, agent applies it as a separate commit
8. Optionally, a second review of just the feedback changes

## Components

The plugin has two parts that are installed separately:

### 1. Neovim plugin (`lua/diff-review/`)

A Lua module that:

- Registers a global `DiffviewState()` function queryable via Neovim's RPC socket
- Provides diffview.nvim hooks that clean up buffers when the diff view is closed (so reviewed files don't linger as open tabs)

### 2. OpenCode plugin (`opencode-plugin/index.ts`)

An OpenCode plugin that registers a `diff_review` tool the AI agent uses to control the diff view. Actions:

| Action | Description |
|--------|-------------|
| `open` | Open a diff view, optionally scoped to specific files or a git ref. Returns the file list and current position. |
| `next` | Navigate to the next file. Detects and prevents wrap-around at the last file. |
| `prev` | Navigate to the previous file. Detects and prevents wrap-around at the first file. |
| `status` | Get current file and position without navigating. Includes the full file list. |
| `close` | Close the diff view and clean up buffers. |

## Dependencies

- [Neovim](https://neovim.io/) 0.9+
- [diffview.nvim](https://github.com/sindrets/diffview.nvim)
- [OpenCode](https://opencode.ai) 1.3+

## Installation

### 1. Neovim plugin

Using [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "talldan/nvim-diff-review-opencode-plugin",
  dependencies = { "sindrets/diffview.nvim" },
  config = function()
    require("diff-review").setup()
  end,
}
```

This also installs diffview.nvim as a dependency if you don't already have it. You can configure diffview.nvim separately — the plugin merges its hooks with any existing diffview hooks you have.

### 2. OpenCode plugin

Add the plugin to your `opencode.json` configuration:

```json
{
  "plugin": ["github:talldan/nvim-diff-review-opencode-plugin"]
}
```

This can go in your global config (`~/.config/opencode/opencode.json`) or a project-level config (`opencode.json` in your project root).

Restart OpenCode to load the plugin. The `diff_review` tool will be available to the AI agent automatically.

### 3. Neovim RPC socket

The tool communicates with Neovim via its RPC socket. You need to:

1. Start Neovim with a listen address:
   ```bash
   export NVIM_SOCKET=/tmp/nvim.sock
   nvim --listen $NVIM_SOCKET
   ```

2. Make sure `NVIM_SOCKET` is set in the environment where OpenCode runs.

If you use [CMUX](https://cmux.com), you can set this in your workspace configuration so both Neovim and OpenCode share the socket path automatically.

## Design

### Architecture

```
OpenCode (agent)                    Neovim (editor)
     │                                   │
     │  nvim --headless --server         │
     │    $NVIM_SOCKET --remote-expr     │
     │    "luaeval('...')"               │
     │ ─────────────────────────────────>│
     │                                   │
     │  JSON response                    │
     │ <─────────────────────────────────│
     │                                   │
```

The tool uses Neovim's `--remote-expr` to evaluate Lua expressions on the running Neovim instance. This is a standard Neovim feature that works in any terminal — no CMUX or specific terminal emulator required.

Key design decisions:

- **`--headless` flag on remote calls**: Prevents Neovim from emitting terminal escape sequences when invoked from a subprocess (e.g., Bun's shell). Without this, the JSON response gets polluted with control codes.
- **State queries via `DiffviewState()`**: A global Lua function registered at plugin load time. Returns JSON with the current file, position, and full file list. Registered as a global (not module-scoped) so it can be called via `luaeval()` without needing the module require path.
- **Wrap-around prevention**: diffview.nvim wraps from the last file to the first (and vice versa) when navigating. The tool detects this by comparing indices before and after navigation, and undoes the wrap if detected.
- **Buffer cleanup on close**: diffview.nvim intentionally keeps local file buffers open after closing (so you can continue editing). The plugin tracks which buffers existed before the review and removes any new ones on close — unless they have unsaved edits.
- **Small delays after navigation**: 200-500ms sleeps after diffview commands to let the UI update before querying state. Without this, the state query can return stale data.

### Review workflow instructions

The tool description embeds detailed workflow instructions for the AI agent:

- **Lint before review**: The agent is told to fix lint/format issues before opening the diff, so the user only sees clean changes.
- **No edits during review**: The agent is explicitly instructed to never edit files during the review. Feedback is collected and applied afterward.
- **Two-commit pattern**: Original work is committed first, then feedback changes are committed separately. This gives clean git history and allows the second review to show only the feedback diff.
- **Interactive pacing**: The agent explains each file's changes, asks for feedback, and waits for the user's response before moving on.

## Future improvements

These were discussed during development but not yet implemented:

### Chunk-level navigation

Navigate within a file between individual hunks (like `git add -p`), not just between files. This would allow the agent to walk through a large file's changes piece by piece rather than presenting the whole diff at once.

### Logical ordering

Instead of reviewing files in filesystem order, the agent would use its understanding of the codebase to present changes in a narrative order — e.g., "first the data model change, then the API that uses it, then the UI that calls the API." This would make reviews of larger changesets more coherent.

### Accept/reject per-hunk

Allow the user to accept or reject individual hunks from the diff view, similar to `git add -p`. This would integrate with diffview.nvim's staging capabilities.

### Line range focus

The agent could jump to specific line ranges within a diff to highlight the key change, rather than showing the full file diff. Useful for large files where only a small section was modified.

### OpenCode session diff integration

Instead of using `git diff` to determine changed files, use OpenCode's `/session/:id/diff` API endpoint to get exactly which files the agent modified in the current session. This would avoid showing unrelated uncommitted changes.
