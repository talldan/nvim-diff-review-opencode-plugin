-- diff-review: Neovim plugin for OpenCode-driven guided code reviews
--
-- Provides:
-- 1. A global DiffviewState() function that external tools can query via Neovim's
--    RPC socket to get the current diffview state (file, position, file list).
-- 2. A global DiffviewHunks() function that returns all diff hunks across all files
--    as a flat array, using diffview.nvim's diff parser on git diff output.
-- 3. A global DiffviewGoTo(file, line) function that navigates diffview to a
--    specific file and line number.
-- 4. Diffview hooks that clean up buffers when the diff view is closed.
--
-- Requires: sindrets/diffview.nvim
--
-- Usage from outside Neovim:
--   nvim --headless --server $NVIM_SOCKET --remote-expr "luaeval('DiffviewState()')"
--   nvim --headless --server $NVIM_SOCKET --remote-expr "luaeval('DiffviewHunks()')"
--   nvim --headless --server $NVIM_SOCKET --remote-expr "luaeval('DiffviewHunks(\"HEAD~3\")')"
--   nvim --headless --server $NVIM_SOCKET --remote-expr "luaeval('DiffviewGoTo(\"src/foo.ts\", 42)')"

local M = {}

--- Track which buffers existed before diffview opened.
--- Used by the cleanup hooks to avoid removing buffers the user had open.
local pre_diffview_bufs = {}

--- Pending cursor position to set after diffview finishes opening a file.
--- DiffviewGoTo stores the target here, and the autocmd on DiffviewDiffBufWinEnter
--- applies it. This avoids a race with diffview's async file loading which resets
--- the cursor to line 1 after opening.
--- @type { file: string, line: number }?
local pending_goto = nil

--- Query the current diffview state.
--- Returns a JSON string with:
---   open: boolean          - whether diffview is active
---   current_file: string?  - repo-relative path of the file being shown
---   absolute_path: string? - absolute path on disk
---   status: string?        - git status letter (M, A, D, R, etc.)
---   index: number?         - 1-based position in the file list
---   total: number?         - total number of changed files
---   files: table?          - array of {path, status} for all files in the diff
---
--- Registered as a global function so it can be called via luaeval() from
--- Neovim's --remote-expr without requiring the module path.
function DiffviewState()
  local ok, lib = pcall(require, "diffview.lib")
  if not ok then
    return vim.json.encode({ open = false, error = "diffview.nvim not loaded" })
  end

  local utils = require("diffview.utils")
  local view = lib.get_current_view()
  if not view then
    return vim.json.encode({ open = false })
  end

  local panel = view.panel
  local cur_file = panel.cur_file
  local files = panel:ordered_file_list()
  local total = #files

  if not cur_file then
    return vim.json.encode({ open = true, current_file = vim.NIL, index = 0, total = total })
  end

  local index = utils.vec_indexof(files, cur_file)

  -- Build the list of all file paths for the summary
  local all_files = {}
  for _, f in ipairs(files) do
    table.insert(all_files, { path = f.path, status = f.status })
  end

  return vim.json.encode({
    open = true,
    current_file = cur_file.path,
    absolute_path = cur_file.absolute_path,
    status = cur_file.status,
    index = index,
    total = total,
    files = all_files,
  })
end

--- Get all diff hunks across all files as a flat array.
---
--- Runs `git diff` and parses the output using diffview.nvim's diff parser.
--- Each hunk is a self-contained object with its file path, git status, and
--- line range information.
---
--- @param ref string? Optional git ref to diff against (e.g. "HEAD~3").
---                    Defaults to diffing uncommitted changes vs HEAD.
---                    If diffview is open and has a rev_arg, that is used as
---                    the default instead.
--- @return string JSON-encoded flat array of hunk objects:
---   [{ file, status, old_start, old_count, new_start, new_count, header }]
function DiffviewHunks(ref)
  local ok, lib = pcall(require, "diffview.lib")
  if not ok then
    return vim.json.encode({ error = "diffview.nvim not loaded" })
  end

  local vcs_utils = require("diffview.vcs.utils")

  -- Determine the git toplevel directory
  local toplevel = vim.fn.systemlist("git rev-parse --show-toplevel")[1]
  if vim.v.shell_error ~= 0 or not toplevel then
    return vim.json.encode({ error = "Not in a git repository" })
  end

  -- If diffview is open, try to use its rev_arg as the default ref
  if not ref then
    local view = lib.get_current_view()
    if view and view.rev_arg and view.rev_arg ~= "" then
      ref = view.rev_arg
    end
  end

  -- Get git status for each file (to include status letters in hunk data)
  -- Use --name-status with the diff to get file statuses
  local status_cmd = "git diff --name-status"
  if ref then
    status_cmd = status_cmd .. " " .. ref
  end
  local status_lines = vim.fn.systemlist(status_cmd)
  local file_statuses = {}
  for _, line in ipairs(status_lines) do
    local status, path = line:match("^(%a)%s+(.+)$")
    if status and path then
      file_statuses[path] = status
    end
  end

  -- Run git diff to get the full patch output
  local diff_cmd = "git diff -U0"
  if ref then
    diff_cmd = diff_cmd .. " " .. ref
  end
  local diff_lines = vim.fn.systemlist(diff_cmd)
  if vim.v.shell_error ~= 0 then
    local err_msg = table.concat(diff_lines, "\n")
    return vim.json.encode({
      error = "git diff failed: " .. (err_msg ~= "" and err_msg or "unknown error"),
    })
  end

  if #diff_lines == 0 then
    return vim.json.encode({})
  end

  -- Normalize hunk headers for -U0 output.
  -- With -U0, git omits the count when it's 1 (e.g., "@@ -134 +134,4 @@"
  -- instead of "@@ -134,1 +134,4 @@"). diffview's parser expects the
  -- comma-separated form, so we normalize before parsing.
  for i, line in ipairs(diff_lines) do
    local old_spec, new_spec = line:match("^@@ %-(%S+) %+(%S+) @@")
    if old_spec then
      -- Ensure both sides have the ",count" format
      if not old_spec:match(",") then
        old_spec = old_spec .. ",1"
      end
      if not new_spec:match(",") then
        new_spec = new_spec .. ",1"
      end
      diff_lines[i] = "@@ -" .. old_spec .. " +" .. new_spec .. " @@"
    end
  end

  -- Parse the diff using diffview's parser
  local file_diffs = vcs_utils.parse_diff(diff_lines)

  -- Flatten into a single array: one entry per hunk, each with its file info
  local hunks = {}
  for _, file_diff in ipairs(file_diffs) do
    local path = file_diff.path_new or file_diff.path_old or ""
    local status = file_statuses[path] or "M"

    for _, hunk in ipairs(file_diff.hunks) do
      local header = string.format(
        "@@ -%d,%d +%d,%d @@",
        hunk.old_row, hunk.old_size, hunk.new_row, hunk.new_size
      )
      table.insert(hunks, {
        file = path,
        status = status,
        old_start = hunk.old_row,
        old_count = hunk.old_size,
        new_start = hunk.new_row,
        new_count = hunk.new_size,
        header = header,
      })
    end
  end

  return vim.json.encode(hunks)
end

--- Navigate diffview to a specific file and line number.
---
--- Finds the file in diffview's file list, switches to it if needed,
--- then moves the cursor to the specified line in the right-hand (new) buffer.
---
--- @param file string Repo-relative file path
--- @param line number Line number to jump to (in the new version of the file)
--- @return string JSON-encoded result: { ok: true } or { error: string }
function DiffviewGoTo(file, line)
  local ok, lib = pcall(require, "diffview.lib")
  if not ok then
    return vim.json.encode({ error = "diffview.nvim not loaded" })
  end

  local view = lib.get_current_view()
  if not view then
    return vim.json.encode({ error = "diffview is not open" })
  end

  local utils = require("diffview.utils")
  local panel = view.panel
  local files = panel:ordered_file_list()

  -- Find the target file in the file list
  local target = nil
  for _, f in ipairs(files) do
    if f.path == file then
      target = f
      break
    end
  end

  if not target then
    return vim.json.encode({ error = "File not found in diffview: " .. file })
  end

  -- Store the target so the autocmd can position the cursor after diffview
  -- finishes its async file loading (which resets cursor to line 1).
  pending_goto = { file = file, line = line }

  -- Switch to the target file if it's not already the current one
  local cur_file = panel.cur_file
  if not cur_file or cur_file.path ~= file then
    view:set_file(target)
  else
    -- Already on the right file — apply cursor position directly
    M._apply_pending_goto()
  end

  return vim.json.encode({ ok = true })
end

--- Diffview hook: called when a diff view is opened.
--- Snapshots the current buffer list so we know which buffers to clean up later.
function M.on_view_opened(view)
  pre_diffview_bufs = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then
      pre_diffview_bufs[buf] = true
    end
  end
end

--- Apply a pending cursor position after diffview has finished loading a file.
--- Called from the DiffviewDiffBufWinEnter autocmd and from DiffviewGoTo when
--- the file is already displayed.
function M._apply_pending_goto()
  if not pending_goto then return end

  local target_line = pending_goto.line
  pending_goto = nil

  -- Small delay to ensure diffview's own cursor positioning (which resets to
  -- line 1 on file_open_new) has completed before we override it.
  vim.defer_fn(function()
    local ok, lib = pcall(require, "diffview.lib")
    if not ok then return end

    local view = lib.get_current_view()
    if not view then return end

    -- Get the main window (right-hand / "b" side in a 2-way diff)
    local main_win = view.cur_layout:get_main_win()
    if not main_win or not main_win.id or not vim.api.nvim_win_is_valid(main_win.id) then
      return
    end

    local file = main_win.file
    if not file or not file.bufnr or not vim.api.nvim_buf_is_loaded(file.bufnr) then
      return
    end

    -- Clamp line to buffer length
    local max_line = vim.api.nvim_buf_line_count(file.bufnr)
    local line = math.min(math.max(target_line or 1, 1), max_line)
    vim.api.nvim_win_set_cursor(main_win.id, { line, 0 })
    vim.api.nvim_set_current_win(main_win.id)
    vim.cmd("normal! zz")
  end, 50)
end

--- Diffview hook: called when a diff view is closed.
--- Cleans up buffers that diffview created but the user didn't have open before.
--- - diffview:// internal buffers are always removed
--- - Real file buffers opened by diffview are removed if they have no unsaved edits
function M.on_view_closed(view)
  vim.schedule(function()
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_valid(buf) and not pre_diffview_bufs[buf] then
        local name = vim.api.nvim_buf_get_name(buf)
        -- Always clean up diffview's internal buffers (diffview:// scheme)
        if name:match("^diffview://") then
          pcall(vim.api.nvim_buf_delete, buf, { force = true })
        -- Also clean up real file buffers that diffview opened, but only if
        -- they're unmodified (don't wipe user edits)
        elseif vim.api.nvim_buf_is_loaded(buf) and not vim.bo[buf].modified then
          pcall(vim.api.nvim_buf_delete, buf, {})
        end
      end
    end
    pre_diffview_bufs = {}
  end)
end

--- Set up the plugin. Call this from your plugin spec or init.lua.
--- Configures diffview.nvim hooks for buffer cleanup and registers global
--- functions for external tool access.
---
--- Example with lazy.nvim:
---   {
---     "your-username/nvim-diff-review-opencode-plugin",
---     dependencies = { "sindrets/diffview.nvim" },
---     config = function()
---       require("diff-review").setup()
---     end,
---   }
function M.setup(opts)
  opts = opts or {}

  -- Register global functions (already defined at module load,
  -- but this ensures they're available even if the module is lazy-loaded)
  _G.DiffviewState = DiffviewState
  _G.DiffviewHunks = DiffviewHunks
  _G.DiffviewGoTo = DiffviewGoTo

  -- Listen for diffview's DiffviewDiffBufWinEnter autocmd to apply pending
  -- cursor positions after async file loading completes.
  vim.api.nvim_create_autocmd("User", {
    pattern = "DiffviewDiffBufWinEnter",
    callback = function()
      M._apply_pending_goto()
    end,
  })

  -- Configure diffview hooks
  local dv_ok, diffview = pcall(require, "diffview")
  if not dv_ok then
    vim.notify(
      "[diff-review] diffview.nvim is required but not installed",
      vim.log.levels.WARN
    )
    return
  end

  -- Get existing diffview config and merge our hooks
  local config = require("diffview.config")
  local existing_hooks = config.get_config().hooks or {}

  local orig_view_opened = existing_hooks.view_opened
  local orig_view_closed = existing_hooks.view_closed

  diffview.setup({
    hooks = vim.tbl_extend("force", existing_hooks, {
      view_opened = function(view)
        M.on_view_opened(view)
        if orig_view_opened then orig_view_opened(view) end
      end,
      view_closed = function(view)
        M.on_view_closed(view)
        if orig_view_closed then orig_view_closed(view) end
      end,
    }),
  })
end

return M
