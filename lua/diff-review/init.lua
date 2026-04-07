-- diff-review: Neovim plugin for OpenCode-driven guided code reviews
--
-- Provides:
-- 1. A global DiffviewState() function that external tools can query via Neovim's
--    RPC socket to get the current diffview state (file, position, file list).
-- 2. Diffview hooks that clean up buffers when the diff view is closed.
--
-- Requires: sindrets/diffview.nvim
--
-- Usage from outside Neovim:
--   nvim --headless --server $NVIM_SOCKET --remote-expr "luaeval('DiffviewState()')"

local M = {}

--- Track which buffers existed before diffview opened.
--- Used by the cleanup hooks to avoid removing buffers the user had open.
local pre_diffview_bufs = {}

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
--- Configures diffview.nvim hooks for buffer cleanup.
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

  -- Register the DiffviewState global function (already done at module load,
  -- but this ensures it's available even if the module is lazy-loaded)
  _G.DiffviewState = DiffviewState

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
