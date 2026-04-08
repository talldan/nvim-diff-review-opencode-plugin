# nvim-diff-review-opencode-plugin

An agent-driven guided code review tool for Neovim and [OpenCode](https://opencode.ai). An AI agent walks you through code changes hunk by hunk, showing side-by-side diffs in Neovim while discussing the changes in a separate OpenCode chat.

## How it works

The plugin connects an OpenCode agent to Neovim's [diffview.nvim](https://github.com/sindrets/diffview.nvim) via Neovim's built-in RPC socket. The agent can query all change hunks, reorder them for narrative coherence, open diffs, and navigate between hunks — all while the user interacts via the OpenCode chat.

```
┌────────────────────────────┬──────────────────────┐
│                            │                      │
│  Neovim showing diff of    │  OpenCode agent:     │
│  src/store/selectors.js    │                      │
│  (cursor at hunk 2 of 3)   │  "I added validation  │
│                            │   for the edge case   │
│  - old code in red         │   where the block     │
│  + new code in green       │   name is             │
│                            │   undefined..."       │
│                            │                      │
│                            │  Any questions about  │
│                            │  this change?         │
└────────────────────────────┴──────────────────────┘
```

The review workflow:

1. Agent queries all change hunks across all files
2. Agent decides a review order — reordering for narrative coherence (e.g., data model first, then API, then UI) or using natural order for small changes
3. Agent opens the diff view and begins the review walk-through
4. For each hunk: agent explains the change, user asks questions or leaves feedback
5. Agent notes feedback but **does not edit files** during the review
6. After the last hunk, agent closes the diff view
7. Agent proposes a commit message and commits the original work
8. If feedback was left, agent applies it as a separate commit
9. Optionally, a second review of just the feedback changes

## Components

The plugin has two parts that are installed separately:

### 1. Neovim plugin (`lua/diff-review/`)

A Lua module that:

- Registers global functions queryable via Neovim's RPC socket:
  - `DiffviewState()` — current diffview state (file, position, file list)
  - `DiffviewHunks(ref?)` — all diff hunks as a flat array, parsed from `git diff` output using diffview.nvim's diff parser
  - `DiffviewGoTo(file, line)` — navigate diffview to a specific file and line
- Provides diffview.nvim hooks that clean up buffers when the diff view is closed (so reviewed files don't linger as open tabs)

### 2. OpenCode plugin (`opencode-plugin/index.ts`)

An OpenCode plugin that registers a `diff_review` tool the AI agent uses to control the diff view. Actions:

| Action | Description |
|--------|-------------|
| `get_hunks` | Get all diff hunks across all files as a flat array. Each hunk is self-contained with file path, status, and line ranges. Optionally scoped to specific files or a git ref. |
| `start_review` | Open the diff view and begin the review walk-through. Accepts an optional ordered array of hunks (from `get_hunks`) to control review order. If omitted, uses natural hunk order. Navigates to the first item. |
| `next` | Navigate to the next item in the review queue. Prevents wrap-around at the last item. |
| `prev` | Navigate to the previous item in the review queue. Prevents wrap-around at the first item. |
| `status` | Get current position in the review queue without navigating. |
| `close` | Close the diff view and clear the review queue. |

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
  "plugin": ["opencode-nvim-diff-review"]
}
```

This can go in your global config (`~/.config/opencode/opencode.json`) or a project-level config (`opencode.json` in your project root).

Restart OpenCode to load the plugin. The `diff_review` tool will be available to the AI agent automatically.

### 3. Neovim RPC socket

The tool communicates with Neovim via its RPC socket. In most cases, **no configuration is needed** — the tool auto-discovers running Neovim instances.

#### Auto-discovery (default)

The tool automatically finds Neovim by:

1. Checking the `NVIM_SOCKET` environment variable (if set, always used)
2. Scanning for Neovim sockets in standard locations (`$TMPDIR` and `/tmp`)
3. Preferring the Neovim instance whose working directory matches the current project
4. Falling back to the first live Neovim instance found

This means if you just run `nvim` in your project directory, OpenCode will find it automatically.

#### Explicit configuration (optional)

If auto-discovery doesn't work for your setup (e.g., multiple Neovim instances in the same directory), you can set the socket path explicitly:

```bash
export NVIM_SOCKET=/tmp/nvim.sock
nvim --listen $NVIM_SOCKET
```

Make sure `NVIM_SOCKET` is set in the environment where OpenCode runs.

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

### Hunk-based review

The review operates at the **hunk level** rather than the file level. This means:

- A file with 3 separate change regions is presented as 3 review items
- The agent can reorder hunks across files for narrative coherence (e.g., show a data model change in `model.ts` before the API endpoint in `api.ts` that uses it, even if they're in different files)
- Small files with a single change are naturally one review item
- The agent can filter out trivial hunks (e.g., import reordering) from the review

Hunks are retrieved by running `git diff -U0` and parsing the output with diffview.nvim's built-in unified diff parser (`diffview.vcs.utils.parse_diff`). The `-U0` flag produces zero-context hunks, giving exact change boundaries. (Note: `-U0` omits the count in hunk headers when it's 1, e.g., `@@ -134 +134,4 @@`. The plugin normalizes these to the `N,M` form before parsing.)

### Hunk-focus folding

When navigating to a hunk, the plugin folds all other regions of the file so only the target hunk is visible — similar to `git add -p`. This is achieved by:

1. Switching both diff windows from `foldmethod=diff` to `foldmethod=manual`
2. Creating two manual folds: one above the hunk and one below
3. Showing 5 lines of context above and below the hunk

The fold highlight is overridden with a custom `DiffviewDiffFoldedReview` highlight group (linked to `Comment` by default) so fold lines look like muted separators rather than diff modifications. Users can override this highlight group in their colorscheme.

Line numbers are switched to absolute (`number`, no `relativenumber`) during hunk focus so they match the line ranges shown in the hunk headers.

### Review queue

The review queue is managed on the TypeScript (OpenCode plugin) side. It holds:

- An ordered array of hunk items (set by `start_review`)
- The current position in the queue (advanced by `next`/`prev`)

The Lua (Neovim) side is stateless — it provides functions to query hunks and navigate the diff view, but doesn't track review progress. This keeps the Neovim plugin simple and the state management in one place.

### Key design decisions

- **`--headless` flag on remote calls**: Prevents Neovim from emitting terminal escape sequences when invoked from a subprocess (e.g., Bun's shell). Without this, the JSON response gets polluted with control codes.
- **State queries via global Lua functions**: `DiffviewState()`, `DiffviewHunks()`, and `DiffviewGoTo()` are registered as globals so they can be called via `luaeval()` from Neovim's `--remote-expr` without needing the module require path.
- **Wrap-around prevention**: The tool checks queue bounds before navigating and refuses to advance past the first/last item.
- **Buffer cleanup on close**: diffview.nvim intentionally keeps local file buffers open after closing (so you can continue editing). The plugin tracks which buffers existed before the review and removes any new ones on close — unless they have unsaved edits.
- **Async cursor positioning**: `DiffviewGoTo` stores a pending target and applies it via a `DiffviewDiffBufWinEnter` autocmd + `vim.defer_fn`. This ensures the cursor is positioned after diffview's async `set_file` completes (which resets cursor to line 1 on `file_open_new`).
- **Socket auto-discovery**: When `NVIM_SOCKET` is not set, the tool scans `$TMPDIR/nvim.$USER/` and `/tmp` for Neovim socket files, verifies each is live, and uses `lsof` to match the Neovim process's working directory against the current project. This allows zero-configuration usage in ad-hoc terminals — just run `nvim` and OpenCode will find it.

### Review workflow instructions

The tool description embeds detailed workflow instructions for the AI agent:

- **Lint before review**: The agent is told to fix lint/format issues before opening the diff, so the user only sees clean changes.
- **Narrative ordering**: The agent analyzes hunks and reorders them for coherent presentation — explaining foundational changes before dependent ones.
- **No edits during review**: The agent is explicitly instructed to never edit files during the review. Feedback is collected and applied afterward.
- **Two-commit pattern**: Original work is committed first, then feedback changes are committed separately. This gives clean git history and allows the second review to show only the feedback diff.
- **Interactive pacing**: The agent explains each hunk, asks for feedback, and waits for the user's response before moving on.

## Future improvements

These were discussed during development but not yet implemented:

### Expand (surrounding context)

Show surrounding code context around the current hunk. Useful when the agent or user needs to see more of the file to understand a change. Would be implemented as an `expand` action.

### Accept/reject per-hunk

Allow the user to accept or reject individual hunks from the diff view, similar to `git add -p`. This would integrate with diffview.nvim's staging capabilities.

### OpenCode session diff integration

Instead of using `git diff` to determine changed files, use OpenCode's `/session/:id/diff` API endpoint to get exactly which files the agent modified in the current session. This would avoid showing unrelated uncommitted changes.
