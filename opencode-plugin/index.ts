import { type Plugin, tool } from "@opencode-ai/plugin"

// --- Types ---

interface HunkItem {
  file: string
  status: string
  old_start: number
  old_count: number
  new_start: number
  new_count: number
  header: string
}

interface DiffviewState {
  open: boolean
  current_file?: string | null
  absolute_path?: string
  status?: string
  index?: number
  total?: number
  files?: { path: string; status: string }[]
  error?: string
}

// --- Review queue state (persists across tool calls within a session) ---

let reviewQueue: HunkItem[] = []
let reviewPosition = -1 // -1 means review not started
let reviewRef: string | undefined
let reviewFiles: string[] | undefined

// --- Neovim socket discovery ---

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

// --- Helpers ---

const STATUS_LABELS: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
}

const statusLabel = (status: string | undefined): string =>
  (status && STATUS_LABELS[status]) ?? "changed"

const formatHunkPosition = (): string => {
  if (reviewQueue.length === 0) return "No review in progress."
  const item = reviewQueue[reviewPosition]
  const fileCount = new Set(reviewQueue.map(h => h.file)).size
  return `Reviewing: ${item.file} (${statusLabel(item.status)}) ${item.header} — item ${reviewPosition + 1} of ${reviewQueue.length} across ${fileCount} file${fileCount === 1 ? "" : "s"}.`
}

/**
 * Match an order item from the agent to a hunk in the available hunks list.
 * A hunk is uniquely identified by {file, old_start, old_count, new_start, new_count}.
 */
const findHunk = (
  hunks: HunkItem[],
  orderItem: { file: string; old_start: number; old_count: number; new_start: number; new_count: number }
): HunkItem | undefined =>
  hunks.find(
    h =>
      h.file === orderItem.file &&
      h.old_start === orderItem.old_start &&
      h.old_count === orderItem.old_count &&
      h.new_start === orderItem.new_start &&
      h.new_count === orderItem.new_count
  )

/**
 * Format a summary of the files covered in the review queue.
 */
const formatQueueSummary = (queue: HunkItem[]): string => {
  const fileGroups = new Map<string, { status: string; count: number }>()
  for (const item of queue) {
    const existing = fileGroups.get(item.file)
    if (existing) {
      existing.count++
    } else {
      fileGroups.set(item.file, { status: item.status, count: 1 })
    }
  }
  const lines = Array.from(fileGroups.entries()).map(
    ([file, { status, count }]) =>
      `  ${file} (${statusLabel(status)}) — ${count} hunk${count === 1 ? "" : "s"}`
  )
  return `\nFiles in review:\n${lines.join("\n")}`
}

// --- Plugin ---

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
          "2. Call with action 'get_hunks' to retrieve all change hunks across all files.\n" +
          "   Each hunk includes file path, status, and line range info.\n" +
          "3. Analyze the hunks and decide a review order. Reorder them for narrative\n" +
          "   coherence — e.g. show the data model change before the API that uses it,\n" +
          "   then the UI that calls the API. For small changes, the natural order is fine.\n" +
          "   You may also filter out hunks that are trivial (e.g. import reordering).\n" +
          "4. Call with action 'start_review' with the ordered hunks array to open the diff\n" +
          "   view and begin. If you omit the order, natural hunk order is used.\n" +
          "5. Explain the current hunk shown in the diff view.\n" +
          "6. Ask the user if they have questions or feedback about these changes.\n" +
          "7. If the user requests changes or leaves feedback, acknowledge it and note it\n" +
          "   down — but DO NOT make any changes yet. Continue the review.\n" +
          "8. Call with action 'next' to advance to the next item in the review queue.\n" +
          "   When you reach the last item, 'next' will tell you there are no more items.\n" +
          "9. Repeat steps 5-8 for each item\n" +
          "10. Call with action 'close' when the review is complete\n" +
          "11. Propose a git commit message for the CURRENT changes and commit if the user approves\n" +
          "12. If the user left feedback or change requests during the review, NOW apply them\n" +
          "    — this creates a clean separation: one commit for the original work,\n" +
          "    a second commit for review feedback changes\n" +
          "13. If you made feedback changes, offer to walk through them with a second diff_review\n" +
          "    — since the original work is already committed, this diff will only show\n" +
          "    the feedback changes, making them easy to verify\n\n" +
          "CRITICAL: During the review (steps 5-9), NEVER make changes to files.\n" +
          "Only collect feedback. Apply changes AFTER the review is closed and the\n" +
          "original work is committed.\n\n" +
          "Every response includes the current item and position (e.g., 'item 2 of 5') " +
          "so you always know where you are in the review. Use the 'status' action " +
          "to re-orient if you lose track.",
        args: {
          action: tool.schema
            .enum(["get_hunks", "start_review", "next", "prev", "status", "close"])
            .describe(
              "get_hunks: retrieve all diff hunks across all files as a flat array. " +
              "start_review: open the diff view and begin reviewing, optionally with a custom order. " +
              "next: navigate to the next item in the review queue. " +
              "prev: navigate to the previous item in the review queue. " +
              "status: get current position in the review queue without navigating. " +
              "close: close the diff view and end the review."
            ),
          ref: tool.schema
            .string()
            .optional()
            .describe(
              "Git ref to diff against (get_hunks and start_review only). " +
              "Defaults to showing uncommitted changes vs HEAD. " +
              "Examples: HEAD~3, a commit hash, origin/main"
            ),
          files: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe(
              "File paths to include in the diff (get_hunks and start_review only). " +
              "Omit to include all uncommitted changes."
            ),
          order: tool.schema
            .array(
              tool.schema.object({
                file: tool.schema.string().describe("Repo-relative file path"),
                old_start: tool.schema.number().describe("Start line in old version"),
                old_count: tool.schema.number().describe("Line count in old version"),
                new_start: tool.schema.number().describe("Start line in new version"),
                new_count: tool.schema.number().describe("Line count in new version"),
              })
            )
            .optional()
            .describe(
              "Custom review order (start_review only). Array of hunk identifiers " +
              "from the get_hunks response, in the order you want to review them. " +
              "Each item needs: file, old_start, old_count, new_start, new_count. " +
              "Omit to use the natural hunk order."
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

          const getHunks = async (ref?: string): Promise<HunkItem[]> => {
            const luaArg = ref ? `"${ref.replace(/"/g, '\\"')}"` : ""
            const raw = await nvimExpr(`luaeval("DiffviewHunks(${luaArg})")`)
            const parsed = JSON.parse(raw.trim())
            if (parsed.error) throw new Error(parsed.error)
            return parsed as HunkItem[]
          }

          const goToHunk = async (item: HunkItem): Promise<void> => {
            const file = item.file.replace(/"/g, '\\"')
            // Pass hunk boundaries so Lua can set up folds to focus on this hunk
            const hunkSpec = `{new_start=${item.new_start},new_count=${item.new_count},old_start=${item.old_start},old_count=${item.old_count}}`
            const raw = await nvimExpr(
              `luaeval("DiffviewGoTo('${file}', ${hunkSpec})")`
            )
            const result = JSON.parse(raw.trim())
            if (result.error) throw new Error(result.error)
            // Give diffview time to switch files and the Lua side to
            // position cursor and set up folds
            await Bun.sleep(500)
          }

          try {
            switch (args.action) {
              case "get_hunks": {
                // Store ref/files for later use by start_review
                reviewRef = args.ref
                reviewFiles = args.files

                const hunks = await getHunks(args.ref)

                if (hunks.length === 0) {
                  return "No changes found." +
                    (args.ref ? ` (compared against ${args.ref})` : "")
                }

                // Summarize: count files and hunks
                const fileSet = new Set(hunks.map(h => h.file))
                const summary = `Found ${hunks.length} hunk${hunks.length === 1 ? "" : "s"} ` +
                  `across ${fileSet.size} file${fileSet.size === 1 ? "" : "s"}` +
                  (args.ref ? ` (compared against ${args.ref})` : "") + ".\n\n"

                return summary + JSON.stringify(hunks, null, 2)
              }

              case "start_review": {
                // Use ref/files from get_hunks if not explicitly provided
                const ref = args.ref ?? reviewRef
                const files = args.files ?? reviewFiles

                // Open diffview
                let cmd = "DiffviewOpen"
                if (ref) {
                  cmd += ` ${ref}`
                }
                if (files && files.length > 0) {
                  const escaped = files.map(f => f.replace(/ /g, "\\ ")).join(" ")
                  cmd += ` -- ${escaped}`
                }
                await nvimExpr(`luaeval("vim.cmd('${cmd.replace(/'/g, "''")}')")`)
                // Give diffview time to populate the file list
                await Bun.sleep(500)

                // Build the review queue
                if (args.order && args.order.length > 0) {
                  // Agent provided a custom order — resolve each item to a full hunk
                  const allHunks = await getHunks(ref)
                  const queue: HunkItem[] = []
                  const unmatched: string[] = []

                  for (const orderItem of args.order) {
                    const match = findHunk(allHunks, orderItem)
                    if (match) {
                      queue.push(match)
                    } else {
                      unmatched.push(`${orderItem.file} ${orderItem.old_start}→${orderItem.new_start}`)
                    }
                  }

                  if (queue.length === 0) {
                    return "Could not match any items in the provided order to actual hunks. " +
                      `Unmatched: ${unmatched.join(", ")}. ` +
                      "Call 'get_hunks' to see available hunks."
                  }

                  reviewQueue = queue

                  if (unmatched.length > 0) {
                    // Warn but proceed with what we have
                  }
                } else {
                  // No custom order — use natural hunk order
                  reviewQueue = await getHunks(ref)

                  if (reviewQueue.length === 0) {
                    return "Opened diff view but no hunks found." +
                      (ref ? ` (compared against ${ref})` : "")
                  }
                }

                // Navigate to the first item
                reviewPosition = 0
                await goToHunk(reviewQueue[0])

                return `Started review with ${reviewQueue.length} item${reviewQueue.length === 1 ? "" : "s"}` +
                  (ref ? ` (comparing against ${ref})` : " (uncommitted changes vs HEAD)") +
                  `. ${formatHunkPosition()}` +
                  formatQueueSummary(reviewQueue)
              }

              case "next": {
                if (reviewQueue.length === 0) {
                  return "No review in progress. Call 'start_review' first."
                }

                if (reviewPosition >= reviewQueue.length - 1) {
                  return `Already at the last item (item ${reviewPosition + 1} of ${reviewQueue.length}). ` +
                    `${formatHunkPosition()} There are no more items to review. ` +
                    "Use action 'close' to end the review."
                }

                reviewPosition++
                await goToHunk(reviewQueue[reviewPosition])

                return `Navigated to next item. ${formatHunkPosition()}`
              }

              case "prev": {
                if (reviewQueue.length === 0) {
                  return "No review in progress. Call 'start_review' first."
                }

                if (reviewPosition <= 0) {
                  return `Already at the first item (item ${reviewPosition + 1} of ${reviewQueue.length}). ` +
                    `${formatHunkPosition()} There are no previous items.`
                }

                reviewPosition--
                await goToHunk(reviewQueue[reviewPosition])

                return `Navigated to previous item. ${formatHunkPosition()}`
              }

              case "status": {
                const state = await getState()
                if (!state.open && reviewQueue.length === 0) {
                  return "No review in progress and diff view is not open."
                }

                if (reviewQueue.length === 0) {
                  return "Diff view is open but no review queue. Call 'start_review' to begin."
                }

                return formatHunkPosition()
              }

              case "close": {
                await nvimExpr(`luaeval("require('diffview').close()")`)

                // Clear review state
                const itemCount = reviewQueue.length
                reviewQueue = []
                reviewPosition = -1
                reviewRef = undefined
                reviewFiles = undefined

                return `Closed the diff view and ended the review` +
                  (itemCount > 0 ? ` (reviewed ${itemCount} item${itemCount === 1 ? "" : "s"}).` : ".")
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
