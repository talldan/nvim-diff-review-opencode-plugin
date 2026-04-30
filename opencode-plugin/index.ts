import { type Plugin, tool } from "@opencode-ai/plugin"

const PLUGIN_VERSION = "0.6.1"
const DISTANT_GROUP_SPAN_LINES = 200

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

interface NvimRpcError extends Error {
  socket: string
  expr: string
  exitCode: number
  stdout: string
  stderr: string
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

/** Maps git status letters to human-readable labels. */
const STATUS_LABELS: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
  U: "unmerged",
}

const statusLabel = (status: string | undefined): string =>
  (status ? STATUS_LABELS[status] : undefined) ?? "changed"

/** Format a human-readable description of the current review position. */
const formatHunkPosition = (): string => {
  if (reviewQueue.length === 0) return "No review in progress."
  const item = reviewQueue[reviewPosition]
  const hunkCount = item.hunks.length
  const totalHunks = reviewQueue.reduce((sum, r) => sum + r.hunks.length, 0)
  const fileCount = new Set(reviewQueue.map(r => r.file)).size
  const visibleCount = visibleTo - visibleFrom + 1
  let msg = `Reviewing: ${item.file} (${statusLabel(item.status)}) — item ${reviewPosition + 1} of ${reviewQueue.length} across ${fileCount} file${fileCount === 1 ? "" : "s"} (${totalHunks} total hunks).`
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
 * Format a summary of the files and items covered in the review queue.
 */
const formatQueueSummary = (queue: ReviewItem[]): string => {
  const totalHunks = queue.reduce((sum, r) => sum + r.hunks.length, 0)
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
      const hunkDetail = hunkCount !== count ? `, ${hunkCount} hunks` : ""
      return `  ${file} (${statusLabel(status)}) — ${itemLabel}${hunkDetail}`
    }
  )
  const header = `\nReview: ${queue.length} items, ${totalHunks} hunks across ${fileGroups.size} file${fileGroups.size === 1 ? "" : "s"}:`
  return `${header}\n${lines.join("\n")}`
}

const hunkStart = (hunk: HunkItem): number =>
  hunk.new_start > 0 ? hunk.new_start : hunk.old_start

const hunkEnd = (hunk: HunkItem): number => {
  const start = hunkStart(hunk)
  const count = hunk.new_count > 0 ? hunk.new_count : hunk.old_count
  return count > 0 ? start + count - 1 : start
}

const formatGroupingWarnings = (queue: ReviewItem[]): string => {
  const warnings = queue.flatMap((item, index) => {
    if (item.hunks.length <= 1) return []

    const first = Math.min(...item.hunks.map(hunkStart))
    const last = Math.max(...item.hunks.map(hunkEnd))
    const span = last - first + 1

    if (span <= DISTANT_GROUP_SPAN_LINES) return []

    return [
      `  Item ${index + 1}: ${item.file} groups ${item.hunks.length} hunks across ${span} lines (${first}-${last})`,
    ]
  })

  if (warnings.length === 0) return ""

  return "\n\nGrouping warnings:\n" +
    `Some grouped items span more than ${DISTANT_GROUP_SPAN_LINES} lines. ` +
    "Consider splitting distant helper definitions, call sites, or tests into separate review items unless they cannot be understood independently.\n" +
    warnings.join("\n")
}

/**
 * Collect all hunks from queue items between fromIdx and toIdx (inclusive)
 * that belong to the same file. Returns the combined hunks array.
 */
const collectVisibleHunks = (queue: ReviewItem[], fromIdx: number, toIdx: number): HunkItem[] => {
  const hunks: HunkItem[] = []
  for (let i = fromIdx; i <= Math.min(toIdx, queue.length - 1); i++) {
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

const luaString = (value: string): string =>
  `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`

const luaEval = (code: string): string =>
  `luaeval('${code.replace(/'/g, "''")}')`

const formatRpcError = (error: NvimRpcError): string => {
  const stdout = error.stdout.trim() || "<empty>"
  const stderr = error.stderr.trim() || "<empty>"
  return "Neovim RPC command failed.\n\n" +
    `Socket: ${error.socket}\n` +
    `Expression: ${error.expr}\n` +
    `Exit code: ${error.exitCode}\n\n` +
    `stdout:\n${stdout}\n\n` +
    `stderr:\n${stderr}`
}

const isNvimRpcError = (error: unknown): error is NvimRpcError =>
  error instanceof Error &&
  typeof (error as any).socket === "string" &&
  typeof (error as any).expr === "string" &&
  typeof (error as any).exitCode === "number"

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
          "   - GROUP hunks that are in the same file and modify the same function, class\n" +
          "     section, or logical block. Adjacent or nearby hunks (within ~30 lines) in\n" +
          "     the same file should almost always be grouped together. This is important —\n" +
          "     without grouping, a function with 3 small changes becomes 3 separate items.\n" +
          "   - DO NOT group distant file regions by default. If related hunks are far\n" +
          "     apart (roughly >100-200 lines), prefer separate review items unless they\n" +
          "     cannot be understood independently. Show helper definitions first, then\n" +
          "     distant call sites as separate items.\n" +
          "   - KEEP tests separate from implementation unless they are tiny and adjacent\n" +
          "     within the same test file.\n" +
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
          "5. Explain the current item shown in the diff view. Mention relevant line\n" +
          "   numbers in the explanation so the user can map comments to the diff, e.g.\n" +
          "   '- Line 18 - updated the function docblock to add the new param' or\n" +
          "   '- Lines 20-25 - iterate through config before applying changes'.\n" +
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
            .enum(["get_hunks", "start_review", "next", "prev", "include_next", "status", "close", "plugin_version"])
            .describe(
              "get_hunks: retrieve all diff hunks across all files as a flat array. " +
              "start_review: open the diff view and begin reviewing, optionally with a custom order. " +
              "next: navigate to the next item in the review queue. " +
              "prev: navigate to the previous item in the review queue. " +
              "include_next: expand the visible area to also show the next item alongside the current one (items must be in the same file). " +
              "status: get current position in the review queue without navigating. " +
              "close: close the diff view and end the review. " +
              "plugin_version: return the plugin version for diagnostics."
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
            if (args.action === "plugin_version") {
              return `OpenCode plugin: v${PLUGIN_VERSION}\nNeovim plugin: unavailable (no Neovim socket found)\nCompatible: unknown`
            }

            return "Could not find a running Neovim instance.\n\n" +
              "The tool looks for Neovim in this order:\n" +
              "1. NVIM_SOCKET environment variable (if set)\n" +
              "2. Neovim instances whose working directory matches this project\n" +
              "3. Any running Neovim instance\n\n" +
              "Quick setup:\n" +
              "  export NVIM_SOCKET=/tmp/nvim.sock\n" +
              "  nvim --listen $NVIM_SOCKET"
          }

          const nvimExpr = async (expr: string): Promise<string> => {
            const proc = Bun.spawn(["nvim", "--headless", "--server", socket, "--remote-expr", expr], {
              stdout: "pipe",
              stderr: "pipe",
            })
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])

            if (exitCode !== 0) {
              const error = new Error(`nvim --remote-expr failed with exit code ${exitCode}`) as NvimRpcError
              error.socket = socket
              error.expr = expr
              error.exitCode = exitCode
              error.stdout = stdout
              error.stderr = stderr
              throw error
            }

            return stdout
          }

          const getNvimPluginVersion = async (): Promise<string | null> => {
            try {
              const type = (await nvimExpr(luaEval("type(DiffviewPluginVersion)"))).trim()
              if (type !== "function") return null
              return (await nvimExpr(luaEval("DiffviewPluginVersion()"))).trim()
            } catch {
              return null
            }
          }

          const checkNvimPlugin = async (): Promise<string | null> => {
            const requiredGlobals = ["DiffviewState", "DiffviewHunks", "DiffviewGoTo"]
            const missing: string[] = []

            for (const global of requiredGlobals) {
              const type = (await nvimExpr(luaEval(`type(${global})`))).trim()
              if (type !== "function") missing.push(global)
            }

            if (missing.length > 0) {
              return "Neovim is reachable, but the diff-review Lua plugin is not loaded.\n\n" +
                `Socket: ${socket}\n` +
                `Missing globals: ${missing.join(", ")}\n\n` +
                "Try restarting Neovim after updating the plugin, or run this in Neovim if the plugin is already in runtimepath:\n" +
                `:lua require("diff-review").setup()`
            }

            const nvimVersion = await getNvimPluginVersion()
            if (!nvimVersion) {
              return "Neovim is reachable and the diff-review Lua globals are loaded, but the Lua plugin does not expose DiffviewPluginVersion().\n\n" +
                `OpenCode plugin: v${PLUGIN_VERSION}\n` +
                "Neovim plugin: older than v0.6.1 or not updated\n\n" +
                "Please update the Neovim plugin (for lazy.nvim, run :Lazy update) and restart Neovim."
            }

            if (nvimVersion !== PLUGIN_VERSION) {
              return "diff-review plugin version mismatch.\n\n" +
                `OpenCode plugin: v${PLUGIN_VERSION}\n` +
                `Neovim plugin: v${nvimVersion}\n\n` +
                "This may still work if the APIs are compatible, but mismatches can cause confusing RPC failures.\n" +
                "Please update both the npm package and the Neovim plugin to the same version."
            }

            return null
          }

          if (args.action === "plugin_version") {
            const nvimVersion = await getNvimPluginVersion()
            const compatible = nvimVersion === PLUGIN_VERSION ? "yes" : nvimVersion ? "no" : "unknown"
            return `OpenCode plugin: v${PLUGIN_VERSION}\n` +
              `Neovim plugin: ${nvimVersion ? `v${nvimVersion}` : "unavailable or older than v0.6.1"}\n` +
              `Compatible: ${compatible}`
          }

          const getState = async (): Promise<DiffviewState> => {
            try {
              const raw = await nvimExpr(luaEval("DiffviewState()"))
              return JSON.parse(raw.trim())
            } catch {
              return { open: false, error: "Could not query diffview state" }
            }
          }

          const getHunks = async (ref?: string): Promise<HunkItem[]> => {
            const luaArg = ref ? luaString(ref) : ""
            const raw = await nvimExpr(luaEval(`DiffviewHunks(${luaArg})`))
            const parsed = JSON.parse(raw.trim())
            if (parsed.error) throw new Error(parsed.error)
            return parsed as HunkItem[]
          }

          /** Navigate diffview to show one or more hunks with fold focus. */
          const showHunks = async (hunks: HunkItem[]): Promise<void> => {
            const hunkSpec = buildHunkSpec(hunks)
            const raw = await nvimExpr(
              luaEval(`DiffviewGoTo(${luaString(hunks[0].file)}, ${hunkSpec})`)
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
            if (args.action !== "close") {
              const preflightError = await checkNvimPlugin()
              if (preflightError) return preflightError
            }

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
                await nvimExpr(luaEval(`vim.cmd(${luaString(cmd)})`))
                // Give diffview time to populate the file list
                await Bun.sleep(500)

                // Build the review queue
                if (args.order && args.order.length > 0) {

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
                  formatQueueSummary(reviewQueue) +
                  formatGroupingWarnings(reviewQueue)
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

                // If include_next expanded the visible range, first collapse back
                // to just the first item in the range.
                if (visibleTo > visibleFrom) {
                  reviewPosition = visibleFrom
                  visibleTo = visibleFrom
                  await showCurrentVisible()
                  return `Collapsed to single item. ${formatHunkPosition()}`
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
                await nvimExpr(luaEval(`require("diffview").close()`))

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
            if (isNvimRpcError(e)) {
              return formatRpcError(e)
            }

            return `Failed to control Neovim diff view: ${e.message ?? e}. ` +
              `Socket: ${socket}`
          }
        },
      }),
    },
  }
}
