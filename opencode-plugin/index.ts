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

/** A review item is a group of one or more hunks in the same file. */
interface ReviewItem {
  file: string
  status: string
  hunks: HunkItem[]
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

let reviewQueue: ReviewItem[] = []
let reviewPosition = -1 // -1 means review not started
/** Tracks which queue items are currently visible (for include_next). */
let visibleFrom = 0
let visibleTo = 0
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
  const hunkCount = item.hunks.length
  const fileCount = new Set(reviewQueue.map(r => r.file)).size
  const visibleCount = visibleTo - visibleFrom + 1
  let msg = `Reviewing: ${item.file} (${statusLabel(item.status)}) — item ${reviewPosition + 1} of ${reviewQueue.length} across ${fileCount} file${fileCount === 1 ? "" : "s"}.`
  if (hunkCount > 1) {
    msg += ` (${hunkCount} hunks grouped)`
  }
  if (visibleCount > 1) {
    msg += ` Showing items ${visibleFrom + 1}–${visibleTo + 1} together.`
  }
  return msg
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
const formatQueueSummary = (queue: ReviewItem[]): string => {
  const fileGroups = new Map<string, { status: string; count: number; hunkCount: number }>()
  for (const item of queue) {
    const existing = fileGroups.get(item.file)
    if (existing) {
      existing.count++
      existing.hunkCount += item.hunks.length
    } else {
      fileGroups.set(item.file, { status: item.status, count: 1, hunkCount: item.hunks.length })
    }
  }
  const lines = Array.from(fileGroups.entries()).map(
    ([file, { status, count, hunkCount }]) => {
      const itemLabel = `${count} item${count === 1 ? "" : "s"}`
      const hunkLabel = hunkCount !== count ? ` (${hunkCount} hunks)` : ""
      return `  ${file} (${statusLabel(status)}) — ${itemLabel}${hunkLabel}`
    }
  )
  return `\nFiles in review:\n${lines.join("\n")}`
}

/**
 * Collect all hunks from queue items between fromIdx and toIdx (inclusive)
 * that belong to the same file. Returns the combined hunks array.
 */
const collectVisibleHunks = (queue: ReviewItem[], fromIdx: number, toIdx: number): HunkItem[] => {
  const hunks: HunkItem[] = []
  for (let i = fromIdx; i <= toIdx; i++) {
    hunks.push(...queue[i].hunks)
  }
  return hunks
}

/**
 * Build the Lua hunk spec string for DiffviewGoTo.
 * For a single hunk: {new_start=N, new_count=N, old_start=N, old_count=N}
 * For multiple hunks: {{...}, {...}, ...}
 */
const buildHunkSpec = (hunks: HunkItem[]): string => {
  const specs = hunks.map(
    h => `{new_start=${h.new_start},new_count=${h.new_count},old_start=${h.old_start},old_count=${h.old_count}}`
  )
  if (specs.length === 1) return specs[0]
  return `{${specs.join(",")}}`
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
          "3. Analyze the hunks and decide a review order. Group and reorder them:\n" +
          "   - GROUP hunks that are in the same file and modify the same function or\n" +
          "     logical block. Adjacent or nearby hunks (within ~30 lines) in the same\n" +
          "     file should almost always be grouped together. This is important — without\n" +
          "     grouping, a function with 3 small changes becomes 3 separate review items.\n" +
          "   - GROUP all import/require changes at the top of a file into one item.\n" +
          "   - REORDER for narrative coherence — e.g. show the data model change before\n" +
          "     the API that uses it, then the UI that calls the API.\n" +
          "   - FILTER OUT hunks that are trivial (e.g. whitespace-only changes).\n" +
          "   - Aim for roughly 10-20 review items even for large diffs.\n" +
          "   The 'order' parameter accepts an array of groups. Each group is an array of\n" +
          "   hunks that will be shown together as one review item. Single-hunk groups are\n" +
          "   fine — just wrap the hunk in an array.\n" +
          "4. Call with action 'start_review' with the ordered groups to open the diff\n" +
          "   view and begin. If you omit the order, natural hunk order is used.\n" +
          "5. Explain the current item shown in the diff view.\n" +
          "6. End with a short prompt like: '(n)ext, or do you have questions?'\n" +
          "   This lets the user type just 'n' to continue, or ask a question.\n" +
          "   You MUST wait for the user's response before calling 'next'.\n" +
          "   Never auto-advance through the review unless the user requests it.\n" +
          "7. If the user requests changes or leaves feedback, acknowledge it and note it\n" +
          "   down — but DO NOT make any changes yet. Continue the review.\n" +
          "8. When the user says 'next', 'n', or similar, call 'next' to advance.\n" +
          "   When you reach the last item, 'next' will tell you there are no more items.\n" +
          "   Alternatively, use 'include_next' to expand the visible area to also show\n" +
          "   the next item — useful when adjacent items are closely related and benefit\n" +
          "   from being reviewed together. The pointer advances so 'next' after\n" +
          "   'include_next' moves to the item after the expanded ones. 'prev' goes back\n" +
          "   and shows just that single item.\n" +
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
            .enum(["get_hunks", "start_review", "next", "prev", "include_next", "status", "close"])
            .describe(
              "get_hunks: retrieve all diff hunks across all files as a flat array. " +
              "start_review: open the diff view and begin reviewing, optionally with a custom order. " +
              "next: navigate to the next item in the review queue. " +
              "prev: navigate to the previous item in the review queue. " +
              "include_next: expand the visible area to also show the next item alongside the current one (items must be in the same file). " +
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
              tool.schema.array(
                tool.schema.object({
                  file: tool.schema.string().describe("Repo-relative file path"),
                  old_start: tool.schema.number().describe("Start line in old version"),
                  old_count: tool.schema.number().describe("Line count in old version"),
                  new_start: tool.schema.number().describe("Start line in new version"),
                  new_count: tool.schema.number().describe("Line count in new version"),
                })
              )
            )
            .optional()
            .describe(
              "Custom review order (start_review only). Array of groups, where each group " +
              "is an array of hunks to show together as one review item. Hunks within a " +
              "group must be in the same file. Single-hunk groups are fine: [[hunk1], [hunk2]]. " +
              "To group nearby hunks: [[hunk1, hunk2], [hunk3]]. " +
              "Each hunk needs: file, old_start, old_count, new_start, new_count. " +
              "Omit to use the natural hunk order (each hunk as its own item)."
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

          /** Navigate diffview to show one or more hunks with fold focus. */
          const showHunks = async (hunks: HunkItem[]): Promise<void> => {
            const file = hunks[0].file.replace(/"/g, '\\"')
            const hunkSpec = buildHunkSpec(hunks)
            const raw = await nvimExpr(
              `luaeval("DiffviewGoTo('${file}', ${hunkSpec})")`
            )
            const result = JSON.parse(raw.trim())
            if (result.error) throw new Error(result.error)
            // Give diffview time to switch files and the Lua side to
            // position cursor and set up folds
            await Bun.sleep(500)
          }

          /** Navigate to the current visible range in the queue. */
          const showCurrentVisible = async (): Promise<void> => {
            const hunks = collectVisibleHunks(reviewQueue, visibleFrom, visibleTo)
            await showHunks(hunks)
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
                  // Agent provided grouped order — resolve each group
                  const allHunks = await getHunks(ref)
                  const queue: ReviewItem[] = []
                  const unmatched: string[] = []

                  for (const group of args.order) {
                    const resolvedHunks: HunkItem[] = []
                    for (const orderItem of group) {
                      const match = findHunk(allHunks, orderItem)
                      if (match) {
                        resolvedHunks.push(match)
                      } else {
                        unmatched.push(`${orderItem.file} ${orderItem.old_start}→${orderItem.new_start}`)
                      }
                    }
                    if (resolvedHunks.length > 0) {
                      queue.push({
                        file: resolvedHunks[0].file,
                        status: resolvedHunks[0].status,
                        hunks: resolvedHunks,
                      })
                    }
                  }

                  if (queue.length === 0) {
                    return "Could not match any items in the provided order to actual hunks. " +
                      `Unmatched: ${unmatched.join(", ")}. ` +
                      "Call 'get_hunks' to see available hunks."
                  }

                  reviewQueue = queue
                } else {
                  // No custom order — each hunk becomes its own review item
                  const allHunks = await getHunks(ref)

                  if (allHunks.length === 0) {
                    return "Opened diff view but no hunks found." +
                      (ref ? ` (compared against ${ref})` : "")
                  }

                  reviewQueue = allHunks.map(h => ({
                    file: h.file,
                    status: h.status,
                    hunks: [h],
                  }))
                }

                // Navigate to the first item
                reviewPosition = 0
                visibleFrom = 0
                visibleTo = 0
                await showCurrentVisible()

                return `Started review with ${reviewQueue.length} item${reviewQueue.length === 1 ? "" : "s"}` +
                  (ref ? ` (comparing against ${ref})` : " (uncommitted changes vs HEAD)") +
                  `. ${formatHunkPosition()}` +
                  formatQueueSummary(reviewQueue)
              }

              case "next": {
                if (reviewQueue.length === 0) {
                  return "No review in progress. Call 'start_review' first."
                }

                // Advance past the current visible range
                const nextPos = visibleTo + 1
                if (nextPos >= reviewQueue.length) {
                  return `Already at the last item (item ${reviewPosition + 1} of ${reviewQueue.length}). ` +
                    `${formatHunkPosition()} There are no more items to review. ` +
                    "Use action 'close' to end the review."
                }

                reviewPosition = nextPos
                visibleFrom = nextPos
                visibleTo = nextPos
                await showCurrentVisible()

                return `Navigated to next item. ${formatHunkPosition()}`
              }

              case "prev": {
                if (reviewQueue.length === 0) {
                  return "No review in progress. Call 'start_review' first."
                }

                // Go back one item before the current visible range
                const prevPos = visibleFrom - 1
                if (prevPos < 0) {
                  return `Already at the first item (item ${reviewPosition + 1} of ${reviewQueue.length}). ` +
                    `${formatHunkPosition()} There are no previous items.`
                }

                reviewPosition = prevPos
                visibleFrom = prevPos
                visibleTo = prevPos
                await showCurrentVisible()

                return `Navigated to previous item. ${formatHunkPosition()}`
              }

              case "include_next": {
                if (reviewQueue.length === 0) {
                  return "No review in progress. Call 'start_review' first."
                }

                const nextPos = visibleTo + 1
                if (nextPos >= reviewQueue.length) {
                  return `Already showing the last item (item ${reviewPosition + 1} of ${reviewQueue.length}). ` +
                    "There are no more items to include."
                }

                // Check that the next item is in the same file
                const currentFile = reviewQueue[visibleFrom].file
                const nextItem = reviewQueue[nextPos]
                if (nextItem.file !== currentFile) {
                  return `Cannot include next item — it is in a different file ` +
                    `(${nextItem.file} vs ${currentFile}). ` +
                    `Use 'next' to navigate to it instead.`
                }

                // Extend the visible range to include the next item
                reviewPosition = nextPos
                visibleTo = nextPos
                await showCurrentVisible()

                return `Expanded view to include next item. ${formatHunkPosition()}`
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
                visibleFrom = 0
                visibleTo = 0
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
