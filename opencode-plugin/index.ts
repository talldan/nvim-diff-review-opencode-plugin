import { type Plugin, tool } from "@opencode-ai/plugin"

interface DiffviewFileInfo {
  path: string
  status: string
}

interface DiffviewState {
  open: boolean
  current_file?: string | null
  absolute_path?: string
  status?: string
  index?: number
  total?: number
  files?: DiffviewFileInfo[]
  error?: string
}

/**
 * Discover a Neovim RPC socket when NVIM_SOCKET is not explicitly set.
 *
 * Strategy:
 * 1. Check NVIM_SOCKET env var (always wins)
 * 2. Scan for socket files in known locations
 * 3. Verify each is live by attempting a connection
 * 4. Prefer the Neovim instance whose cwd matches ours (same project)
 * 5. Fall back to the first live socket found
 */
const discoverNvimSocket = async (): Promise<string | null> => {
  // 1. Explicit env var — skip discovery entirely
  if (process.env.NVIM_SOCKET) return process.env.NVIM_SOCKET

  // 2. Scan for socket files
  const tmpdir = process.env.TMPDIR || "/tmp"
  const user = process.env.USER || "unknown"
  let socketPaths: string[] = []

  try {
    const output =
      await Bun.$`find -L ${tmpdir}/nvim.${user} /tmp -maxdepth 4 -type s -name "nvim*" 2>/dev/null`.text()
    socketPaths = output.trim().split("\n").filter(Boolean)
  } catch {}

  if (socketPaths.length === 0) return null

  // 3 & 4. Check each socket — prefer cwd match, fall back to first live one
  const ourCwd = process.cwd()
  let fallback: string | null = null

  for (const socketPath of socketPaths) {
    try {
      // Verify socket is live with a simple expression
      await Bun.$`nvim --headless --server ${socketPath} --remote-expr "1+1"`.text()

      // Try to get the PID from the socket filename (default sockets: nvim.<pid>.0)
      let pid: string | undefined
      const pidFromName = socketPath.match(/nvim\.(\d+)\.\d+$/)
      if (pidFromName) {
        pid = pidFromName[1]
      } else {
        // For --listen sockets (no PID in filename), find the owning process
        try {
          const lsof = await Bun.$`lsof ${socketPath} 2>/dev/null`.text()
          const pidMatch = lsof.match(/nvim\s+(\d+)/)
          if (pidMatch) pid = pidMatch[1]
        } catch {}
      }

      // Get the cwd of the Neovim process and compare with ours
      if (pid) {
        try {
          const lsof = await Bun.$`lsof -p ${pid} -Fn 2>/dev/null`.text()
          const cwdMatch = lsof.match(/fcwd\nn(.+)/)
          if (cwdMatch && cwdMatch[1] === ourCwd) {
            return socketPath // Exact cwd match — this is our Neovim
          }
        } catch {}
      }

      // Remember the first live socket as fallback
      if (!fallback) fallback = socketPath
    } catch {
      // Socket not responsive — stale socket from a crashed Neovim, skip it
    }
  }

  return fallback
}

export const DiffReviewPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      diff_review: tool({
        description:
          "Control a diff review view in the user's Neovim editor. Use this to walk " +
          "the user through code changes after completing a task.\n\n" +
          "IMPORTANT: Before starting a review, ensure all changes are clean:\n" +
          "- Run any relevant linters/formatters and fix issues BEFORE opening the diff\n" +
          "- The user should only see final, clean changes — not intermediate lint fixes\n" +
          "- If you discover lint errors during review, close the diff, fix them, then restart\n\n" +
          "Workflow:\n" +
          "1. Fix any lint/format issues in your changes first\n" +
          "2. Call with action 'open' to show the diff (optionally scoped to specific files)\n" +
          "   — the response includes a list of ALL files that will be reviewed\n" +
          "3. Explain the changes visible in the current file (the response tells you which file is shown)\n" +
          "4. Ask the user if they have questions or feedback about these changes\n" +
          "5. If the user requests changes or leaves feedback on the current file, acknowledge it\n" +
          "   and note it down — but DO NOT make any changes yet. Continue the review.\n" +
          "6. Call with action 'next' to move to the next changed file\n" +
          "   — when you reach the last file, 'next' will tell you there are no more files\n" +
          "7. Repeat steps 3-6 for each file\n" +
          "8. Call with action 'close' when the review is complete\n" +
          "9. Propose a git commit message for the CURRENT changes and commit if the user approves\n" +
          "10. If the user left feedback or change requests during the review, NOW apply them\n" +
          "    — this creates a clean separation: one commit for the original work,\n" +
          "    a second commit for review feedback changes\n" +
          "11. If you made feedback changes, offer to walk through them with a second diff_review\n" +
          "    — since the original work is already committed, this diff will only show\n" +
          "    the feedback changes, making them easy to verify\n\n" +
          "CRITICAL: During the review (steps 3-7), NEVER make changes to files.\n" +
          "Only collect feedback. Apply changes AFTER the review is closed and the\n" +
          "original work is committed.\n\n" +
          "Every response includes the current file path and position (e.g., '2 of 3') " +
          "so you always know where you are in the review. Use the 'status' action " +
          "to re-orient if you lose track.",
        args: {
          action: tool.schema
            .enum(["open", "next", "prev", "close", "status"])
            .describe(
              "open: show diff view in Neovim. " +
              "next: navigate to next changed file. " +
              "prev: navigate to previous changed file. " +
              "close: close the diff view. " +
              "status: get current file and position without navigating."
            ),
          files: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe(
              "File paths to include in the diff (open only). " +
              "Omit to show all uncommitted changes."
            ),
          ref: tool.schema
            .string()
            .optional()
            .describe(
              "Git ref to diff against (open only). " +
              "Defaults to showing uncommitted changes vs HEAD. " +
              "Examples: HEAD~3, a commit hash, origin/main"
            ),
        },
        async execute(args, context) {
          const socket = await discoverNvimSocket()
          if (!socket) {
            return "Could not find a running Neovim instance.\n\n" +
              "The tool looks for Neovim in this order:\n" +
              "1. NVIM_SOCKET environment variable (if set)\n" +
              "2. Neovim instances whose working directory matches this project\n" +
              "3. Any running Neovim instance\n\n" +
              "Quick setup:\n" +
              "  export NVIM_SOCKET=/tmp/nvim.sock\n" +
              "  nvim --listen $NVIM_SOCKET"
          }

          const nvimExpr = (expr: string) =>
            Bun.$`nvim --headless --server ${socket} --remote-expr ${expr}`.text()

          const getState = async (): Promise<DiffviewState> => {
            try {
              const raw = await nvimExpr(`luaeval("DiffviewState()")`)
              return JSON.parse(raw.trim())
            } catch {
              return { open: false, error: "Could not query diffview state" }
            }
          }

          const statusLabel = (status: string | undefined): string =>
            status === "M" ? "modified" :
            status === "A" ? "added" :
            status === "D" ? "deleted" :
            status === "R" ? "renamed" :
            status ?? "changed"

          const formatState = (state: DiffviewState): string => {
            if (!state.open) return "Diff view is not open."
            if (!state.current_file)
              return `Diff view is open but no files to show (${state.total ?? 0} files total).`
            return `Currently showing: ${state.current_file} (${statusLabel(state.status)}) — file ${state.index} of ${state.total}.`
          }

          const formatFileList = (state: DiffviewState): string => {
            if (!state.files || state.files.length === 0) return ""
            const list = state.files
              .map((f, i) => `  ${i + 1}. ${f.path} (${statusLabel(f.status)})`)
              .join("\n")
            return `\nFiles to review:\n${list}`
          }

          try {
            switch (args.action) {
              case "open": {
                let cmd = "DiffviewOpen"
                if (args.ref) {
                  cmd += ` ${args.ref}`
                }
                if (args.files && args.files.length > 0) {
                  const escaped = args.files.map(f => f.replace(/ /g, "\\ ")).join(" ")
                  cmd += ` -- ${escaped}`
                }
                await nvimExpr(`luaeval("vim.cmd('${cmd.replace(/'/g, "''")}')")`)
                // Give diffview a moment to populate the file list
                await Bun.sleep(500)
                const state = await getState()
                return `Opened diff view in Neovim` +
                  (args.ref ? ` (comparing against ${args.ref})` : " (uncommitted changes vs HEAD)") +
                  `. ${formatState(state)}` +
                  formatFileList(state)
              }

              case "next": {
                const before = await getState()
                if (!before.open) return "Diff view is not open. Call with action 'open' first."

                // If already on the last file, don't navigate (diffview wraps around)
                if (before.index !== undefined && before.total !== undefined &&
                    before.index >= before.total) {
                  return `Already at the last file (file ${before.index} of ${before.total}). ` +
                    `${formatState(before)} There are no more files to review. ` +
                    "Use action 'close' to end the review."
                }

                await nvimExpr(`luaeval("require('diffview').emit('select_next_entry')")`)
                await Bun.sleep(200)
                const after = await getState()

                // Detect wrap-around: if index went down, diffview wrapped to the beginning
                if (before.index !== undefined && after.index !== undefined &&
                    after.index < before.index) {
                  // Undo the wrap by going back
                  await nvimExpr(`luaeval("require('diffview').emit('select_prev_entry')")`)
                  await Bun.sleep(200)
                  const restored = await getState()
                  return `Already at the last file (file ${restored.index} of ${restored.total}). ` +
                    `${formatState(restored)} There are no more files to review. ` +
                    "Use action 'close' to end the review."
                }

                return `Navigated to next file. ${formatState(after)}`
              }

              case "prev": {
                const before = await getState()
                if (!before.open) return "Diff view is not open. Call with action 'open' first."

                // If already on the first file, don't navigate (diffview wraps around)
                if (before.index !== undefined && before.index <= 1) {
                  return `Already at the first file (file ${before.index} of ${before.total}). ` +
                    `${formatState(before)} There are no previous files.`
                }

                await nvimExpr(`luaeval("require('diffview').emit('select_prev_entry')")`)
                await Bun.sleep(200)
                const after = await getState()

                // Detect wrap-around: if index went up, diffview wrapped to the end
                if (before.index !== undefined && after.index !== undefined &&
                    after.index > before.index) {
                  // Undo the wrap by going forward
                  await nvimExpr(`luaeval("require('diffview').emit('select_next_entry')")`)
                  await Bun.sleep(200)
                  const restored = await getState()
                  return `Already at the first file (file ${restored.index} of ${restored.total}). ` +
                    `${formatState(restored)} There are no previous files.`
                }

                return `Navigated to previous file. ${formatState(after)}`
              }

              case "status": {
                const state = await getState()
                if (!state.open) return "Diff view is not currently open."
                return `${formatState(state)}${formatFileList(state)}`
              }

              case "close": {
                await nvimExpr(`luaeval("require('diffview').close()")`)
                return "Closed the diff view in Neovim."
              }
            }
          } catch (e: any) {
            return `Failed to control Neovim diff view: ${e.message ?? e}. ` +
              `Is Neovim running with --listen ${socket} and the diff-review plugin installed?`
          }
        },
      }),
    },
  }
}
