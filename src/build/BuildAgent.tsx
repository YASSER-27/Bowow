import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import JSZip from 'jszip'
import { useAppStore, buildAbortControllers } from '../store'
import type { BuildFile, BuildFileEvent, BuildToolCall, BuildTimelineItem } from '../types'
import { BuildError, BuildErrorReason } from '../types'
import { SvgIcon, fileSvgName } from '../data/svg/icons'
import { parse as incrementalParseJson } from 'partial-json'
import { applyEditsToNormalizedContent, stripBom, detectLineEnding, normalizeToLF, restoreLineEndings } from '../utils/edit-diff'
import { withFileMutationQueue } from '../utils/file-mutation-queue'
import { diffLines, type Change } from 'diff'
import type { BuildMessage } from '../utils/buildEngine'
import { validateContextBeforeApi, pruneLastMessages, executeStreamingApi, processChunkContent, looksLikeToolCallJson, extractToolCallsFromText } from '../utils/buildEngine'
import { ColoredDiff } from './ColoredDiff'
import { DiffViewer } from './DiffViewer'
import { ToolResultSummary } from './ToolResultSummary'
import { analyzeError, type ErrorAnalysis } from '../utils/errorAnalysis'
import { countTokens, validateContextLength, getModelContextLimit, calculateContextUsagePercentage } from '../utils/tokenizer'
import { getUniqueId } from '../utils/uniqueId'
import { formatError, formatAnthropicError } from '../utils/formatError'
import { withRetry, isContextLengthError, isRetryableError } from '../utils/retry'
import { apiRequest, get, post, ApiRequestError } from '../utils/apiClient'
import { truncateHead, truncateLine, formatSize } from '../utils/truncate'
import { getErrorString } from '../utils/error'
import { createStreamHandlers, ToolStatus } from '../utils/streamHelpers'
import { findLastSafeSplitPoint } from '../utils/messageSplitting'
import { compactChatHistory, shouldAutoCompact, pruneLastMessage, findCompactionIndex, getHistoryForLLM } from '../utils/buildCompaction'
import { normalizePath, joinPaths, basename, extname, dirname } from '../utils/pathResolver'
import { isValidAnthropicApiKey, getApiKeyValidationError } from '../utils/apiKeyValidation'
import { writeClipboardText } from '../utils/clipboard'
import { useCommandPermission } from '../utils/permissions'
import { useCheckpoint } from '../utils/checkpoint'
import { execGitStatus, execGitDiff, execGitLog, execGitCommit } from '../utils/gitTools'
import SettingsModal from '../SettingsModal/SettingsModal'
import yasserPic from '../assets/yasser.jpg'
import animationGif from '../assets/animation.gif'

const MarkdownContent = ({ content, color }: { content: string; color: string }) => {
  const cleaned = content.replace(/<\/?plan>/gi, '').trim()
  if (!cleaned) return null
  const parts: { type: 'text' | 'code' | 'bold' | 'italic'; content: string; lang?: string }[] = []
  const codeRegex = /```(\w*)\n([\s\S]*?)```/g
  let lastIndex = 0, match
  while ((match = codeRegex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) parts.push({ type: 'text', content: cleaned.slice(lastIndex, match.index) })
    parts.push({ type: 'code', content: match[2], lang: match[1] || undefined })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < cleaned.length) parts.push({ type: 'text', content: cleaned.slice(lastIndex) })
  return (
    <div style={{ color, lineHeight: 1.6, fontSize: 'var(--font-md)', whiteSpace: 'pre-wrap' }}>
      {parts.map((part, i) =>
        part.type === 'code' ? (
          <pre key={i} style={{ background: '#111', color: '#e0e0e6', borderRadius: 6, padding: 12, margin: '8px 0', fontSize: 'var(--font-md)', overflow: 'auto', lineHeight: 1.4 }}>
            <code>{part.content}</code>
          </pre>
        ) : (
          <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{part.content}</span>
        )
      )}
    </div>
  )
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a file with full content. WARNING: if the file already exists, this OVERWRITES it completely — it does not fail. Only use this on an existing path after you have read_file\'d it and a full rewrite is truly needed; otherwise use edit_file for a targeted change.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, e.g. src/game.py' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the content of an existing file. ALWAYS use this before editing a file you have not just created yourself in this conversation. You can optionally specify start_line and end_line to read specific sections of large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'number', description: 'Optional line number to start reading from (1-indexed)' },
          end_line: { type: 'number', description: 'Optional line number to end reading at (1-indexed, inclusive)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace specific text in an existing file (str_replace). ' +
        'Each old_str MUST be unique in the file — include enough surrounding lines to guarantee uniqueness. ' +
        'The match is exact: whitespace, indentation, newlines must match precisely. ' +
        'When replace_all is true, all occurrences of old_str will be replaced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_str: { type: 'string', description: 'Text to replace — must be exact including all whitespace' },
          new_str: { type: 'string', description: 'Replacement text (must differ from old_str)' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences of old_str (default false)' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: 'List files and directories inside a project directory path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path, e.g. src/' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_search',
      description: 'Search for files by filename pattern (glob syntax).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. src/**/*.py' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search file contents by regex pattern. Returns matching lines with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for in file contents' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'semantic_search',
      description: 'Search for relevant files based on semantic meaning and project dependencies. Use this when you are unsure which files are related to a feature or bug.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query, e.g. "auth logic" or "navigation component"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_zip',
      description: 'Compress all current project files into a .zip archive for download.',
      parameters: {
        type: 'object',
        properties: {
          fileName: { type: 'string', description: 'Name of the zip file, e.g. project.zip' },
        },
        required: ['fileName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_project_map',
      description: 'Scan the project files and generate a project_map.json file that maps dependencies and file relationships. Call this when you need to understand project structure.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the project directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
          cwd: { type: 'string', description: 'Working directory' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show git status — modified, untracked, staged files. Run this before git_diff or git_commit.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff — uncommitted changes. Use this to review changes before committing.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Show recent git commit history (last 10).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image based on a prompt.',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_image',
      description: 'Edit an existing image based on a prompt.',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, imageBase64: { type: 'string' } },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Stage all changes (git add -A) and commit with a given message.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message describing the changes' },
        },
        required: ['message'],
      },
    },
  },
]

function buildSystemPrompt(provider: string): string {
  const base = `You are a file-building agent that communicates ONLY through tool calls. Your job is to create, read, edit, and verify files using the available tool calls.

CRITICAL RULE — ABSOLUTELY NO TEXT OUTPUT BETWEEN TOOL CALLS:
- You MUST NOT output any plan, reasoning, summary, explanation, or code as text outside of tool calls.
- You MUST NOT use <plan>, [BUILD], [RESEARCH], or any other planning markers in your text output.
- You MUST NOT show code blocks, file content, diffs, or anything else inline.
- After receiving a tool result, silently decide your next tool call and output ONLY the next tool call.
- When ALL work is complete, output a MAXIMUM 1-line summary (e.g. "Done: created src/index.html with basic structure").
- If the user asks a question you can answer without tools, respond with at most 1-2 lines.

KNOWLEDGE GRAPH:
- For complex tasks, use 'generate_project_map' to create/update 'project_map.json'.
- Refer to 'project_map.json' to understand dependencies before editing files.
- Use Windows-compatible shell commands (e.g., 'dir' instead of 'ls', 'type' instead of 'cat').
- Use 'python' to run scripts, 'node' for JavaScript files.
- File paths use forward slashes (/) but the OS accepts backslashes too.

CORE WORKFLOW:
1. Read existing files first before editing them — never assume what a file contains.
2. Write or edit code using create_file (for new files) or edit_file (for existing files).
3. Run the code using run_command to verify it works.
4. If there are errors, analyze the output and use edit_file to fix bugs.
5. Repeat until the code runs perfectly.

STRICT RULES:
1. BE DIRECT — Only call tools. Never narrate your plan or reasoning in text output. Write a max 1-line summary only when ALL work is complete.
2. NO BLOAT — Do not create unnecessary helper files. Create only what is needed.
3. NO INFINITE LOOPS — If a command fails 3+ times with the same error, stop and explain the issue clearly instead of repeating the same approach.
4. PRESERVE — Do not delete or rewrite existing functionality the user did not ask to change.
5. READ BEFORE EDIT — Always read_file before edit_file. Never blindly recreate a file with create_file — it OVERWRITES without warning.
6. VERIFY — After creating or editing any .py, .js, or .html file, run at minimum a syntax check (e.g., python -m py_compile, node --check).
7. PACKAGE — If the user asks for the full project, a ZIP file, or to "send all files", use the create_zip tool to package the current project state.
8. OBEY — When the user says "run X.py" or "شغل X.py", do ONLY run_command — do NOT edit or create any files unless they fail to run. Listen precisely to what the user asks.

EDIT_FILE BEST PRACTICES:
- Each old_str must be unique in the file — include enough surrounding lines to guarantee uniqueness.
- Keep the old_str as small as possible while still being unique.
- The replacement is exact — whitespace, indentation, and newlines must match precisely.

PROJECT STRUCTURE:
- All files are stored under the project root directory.
- For HTML projects, put all CSS inline in <style> tags and all JS inline in <script> tags inside a single .html file unless the user explicitly asks for separate files.`

  const jsonFallbackNote = (provider === 'llama' || provider === 'ollama')
    ? `\n\nOUTPUT FORMAT (one tool call per response):\n{"name":"create_file","args":{"path":"src/index.html","content":"<h1>Hello</h1>"}}`
    : ''

  return base + jsonFallbackNote
}

// Available tools:
// - create_file: Create a new file. Args: path (string), content (string)
// - read_file: Read an existing file. Args: path (string)
// - edit_file: Replace text in a file. Args: path (string), old_str (string), new_str (string), replace_all (boolean, optional)
// - ls: List directory contents. Args: path (string)
// - glob_search: Find files by glob pattern. Args: pattern (string)
// - grep_search: Search file contents by regex. Args: pattern (string)
// - run_command: Execute a shell command. Args: command (string), cwd (string, optional)
// 
// Rules:
// - Allowed extensions: .html .css .js .ts .tsx .jsx .vue .svelte .json .py .md .yaml .yml .env .txt .xml .svg .sh .bat .ps1 .toml .ini .cfg .conf .sql .rb .go .rs .java .kt .swift .php .dockerfile .makefile
// - For HTML projects, prefer putting CSS in <style> tags and JS in <script> tags inside the .html file rather than creating separate .css/.js files
// - For edit_file, use the smallest possible old_str/new_str
// - First read_file then edit_file — never edit without reading
// - After ALL tool calls, write a 2-line summary

// ── Helpers ──

function computeDiffStats(oldContent: string, newContent: string): { added: number; removed: number } {
  const a = oldContent.split('\n');
  const b = newContent.split('\n');
  const m = a.length, n = b.length;
  if (m * n > 4_000_000) {
    const setA = new Set(a), setB = new Set(b);
    return { added: b.filter(l => !setA.has(l)).length, removed: a.filter(l => !setB.has(l)).length };
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcsLen = dp[0][0];
  return { added: n - lcsLen, removed: m - lcsLen };
}

const ALLOWED_EXTS = ['.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.json', '.py', '.md', '.yaml', '.yml', '.env', '.txt', '.xml', '.svg', '.sh', '.bat', '.ps1', '.toml', '.ini', '.cfg', '.conf', '.sql', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.php', '.dockerfile', '.makefile', ''];

// Files without extension that should be allowed
const ALLOWED_NO_EXT = ['dockerfile', 'makefile', 'procfile', '.gitignore', '.env.example', '.editorconfig', '.prettierrc', '.eslintrc'];

function validatePath(path: string): string | null {
  if (path.includes('..') || path.startsWith('/')) {
    return 'Unsafe path';
  }
  const name = basename(path).toLowerCase();
  if (ALLOWED_NO_EXT.includes(name)) return null;
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex === -1) {
    return null; // allow files without extension (e.g. Makefile, Dockerfile)
  }
  const ext = path.slice(dotIndex).toLowerCase();
  if (!ALLOWED_EXTS.includes(ext)) {
    return null; // allow unknown extensions instead of blocking
  }
  return null;
}

function wrapContent(content: string, ext: string, path: string): string {
  return `<!DOCTYPE html><html><head><style>
body{margin:0;background:#121212;color:#e0e0e6;font-family:'Consolas','Courier New',monospace;font-size:12px;padding:12px;white-space:pre-wrap;word-break:break-word;overflow:auto;height:100vh;box-sizing:border-box;}
.fn{position:sticky;top:0;background:#121212;padding:4px 0 8px;font-size:10px;color:#00adb5;border-bottom:1px solid #2a2a32;margin-bottom:8px;}
</style></head><body><div class="fn">${path}</div><code>${content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></body></html>`
}

function truncateTerminalOutput(text: string, maxChars = 12000): string {
  if (text.length <= maxChars) return text
  const keepHead = 4000
  const keepTail = maxChars - keepHead - 200
  const head = text.slice(0, keepHead)
  const tail = text.slice(text.length - keepTail)
  const linesTruncated = text.slice(keepHead, text.length - keepTail).split('\n').length
  return `${head}\n\n... [${linesTruncated} lines of terminal output truncated to save context window] ...\n\n${tail}`
}

function createCanvasNode(path: string, content: string) {
  const ext = extname(path).replace(/^\./, '').toLowerCase()
  const isHtml = ext === 'html'
  const isImage = content.startsWith('data:image/') || /^(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(ext)
  const name = basename(path)
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
    componentId: 'build:' + normalizePath(path),
    x: 100 + Math.random() * 200,
    y: 100 + Math.random() * 200,
    width: isImage ? 480 : 360,
    height: isImage ? 360 : 280,
    name,
    category: 'Build',
    type: ext,
    html: isImage ? '' : (isHtml ? '' : wrapContent(content, ext, path)),
    css: '',
    js: '',
    iframeSrcDoc: isHtml ? content : (isImage ? `<!DOCTYPE html><html><head><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#121212;}</style></head><body><img src="${content}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;" /></body></html>` : undefined),
    description: `Build: ${path}`,
    source: 'build-agent',
    mode: 'source' as const,
  }
}

function inlineBuildAssets(buildId: number) {
  const state = useAppStore.getState()
  const buildData = state.builds[buildId]
  if (!buildData) return
  const buildProjectFiles = buildData.projectFiles
  const { canvasElements, updateCanvasElement } = state
  for (const file of buildProjectFiles) {
    if (!file.path.endsWith('.html')) continue
    let html = file.content
    const linkedCss = [...html.matchAll(/<link[^>]+href=["']([^"']+\.css)["'][^>]*\/?>/gi)]
    for (const match of linkedCss) {
      const ref = match[1].replace(/^\.\//, '')
      const cssFile = buildProjectFiles.find(f => f.path.endsWith('/' + ref) || f.path === ref)
      if (cssFile) {
        html = html.replace(match[0], `<style>\n${cssFile.content}\n</style>`)
      }
    }
    const linkedJs = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi)]
    for (const match of linkedJs) {
      const ref = match[1].replace(/^\.\//, '')
      const jsFile = buildProjectFiles.find(f => f.path.endsWith('/' + ref) || f.path === ref)
      if (jsFile) {
        html = html.replace(match[0], `<script>\n${jsFile.content}\n<\/script>`)
      }
    }
    if (html !== file.content) {
      const node = canvasElements.find(e => e.componentId === 'build:' + file.path)
      if (node) updateCanvasElement(node.id, { iframeSrcDoc: html })
    }
  }
}

// ── Tool call parser helpers ──

function looksLikeHtml(text: string): boolean {
  const t = text.trim()
  return /^<!DOCTYPE\s+html/i.test(t) || /^<html[\s>]/i.test(t)
}

/** Best-effort incremental parse of a streaming tool-call args string, used for live previews. */
function parsePreviewArgs(argsStr: string): { path?: string; content?: string; new_str?: string; command?: string } | null {
  if (!argsStr || !argsStr.trim()) return null
  try {
    const partial = incrementalParseJson(argsStr)
    if (partial && typeof partial === 'object') return partial as any
  } catch {}
  return null
}

/** Per-provider tool description overrides */
const TOOL_OVERRIDES: Record<string, Partial<typeof TOOL_DEFS[0]['function']>> = {
  llama: {
    description: 'Local model: create a file. Output JSON: {"name":"create_file","args":{"path":"...","content":"..."}}',
  },
  ollama: {
    description: 'Local model: create a file. Output JSON: {"name":"create_file","args":{"path":"...","content":"..."}}',
  },
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return window.btoa(binary)
}

function nextId() { return crypto.randomUUID?.() || `tl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` }

export default function BuildAgent({ buildId }: { buildId: number }) {
  const sessionId = useMemo(() => getUniqueId(), [])
  const builds = useAppStore(s => s.builds)
  const activeBuild = useAppStore(s => s.activeBuild)
  const buildData = builds[buildId]
  const buildProjectFiles = buildData?.projectFiles || []
  const timeline = buildData?.timeline || []
  const addBuildFile = useAppStore(s => s.addBuildFile)
  const updateBuildFile = useAppStore(s => s.updateBuildFile)
  const setBuildIsRunning = useAppStore(s => s.setBuildIsRunning)
  const addCanvasElement = useAppStore(s => s.addCanvasElement)
  const updateCanvasElement = useAppStore(s => s.updateCanvasElement)
  const addConnection = useAppStore(s => s.addConnection)
  const setBuildEditingPaths = useAppStore(s => s.setBuildEditingPaths)
  const apiSettings = useAppStore(s => s.apiSettings)
  const setApiModel = useAppStore(s => s.setApiModel)
  const buildWorkDir = useAppStore(s => s.builds[buildId]?.workDir ?? null)
  const setBuildWorkDir = useAppStore(s => s.setBuildWorkDir)
  // Map each user message to subsequent file paths+ids (until next user message)
  const userFileMap = useMemo(() => {
    const map = new Map<string, { paths: string[]; fileIds: string[] }>()
    let curr: string | null = null
    for (const item of timeline) {
      if (item.type === 'user') { curr = item.id; map.set(curr, { paths: [], fileIds: [] }) }
      else if (item.type === 'file' && curr && item.path) {
        map.get(curr)!.paths.push(item.path); map.get(curr)!.fileIds.push(item.id)
      }
    }
    return map
  }, [timeline])
  const addTimelineItem = useAppStore(s => s.addBuildTimelineItem)
  const updateTimelineItem = useAppStore(s => s.updateBuildTimelineItem)
  const removeTimelineItem = useAppStore(s => s.removeBuildTimelineItem)
  const clearTimeline = useAppStore(s => s.clearBuildTimeline)
  const saveImport = useAppStore(s => s.saveImport)

  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [isAutoRetrying, setIsAutoRetrying] = useState(false)
  const [isShellRunning, setIsShellRunning] = useState(false)
  const [runningCommand, setRunningCommand] = useState('')
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const [tokenCount, setTokenCount] = useState(0)
  const [retryConversation, setRetryConversation] = useState<{ role: string; content: string }[] | null>(null)
  const [activeMsgId, setActiveMsgId] = useState<string | null>(null)
  const [lastErrorId, setLastErrorId] = useState<string | null>(null)
  const [diffViewerContent, setDiffViewerContent] = useState<string | null>(null)
  const [contextPercent, setContextPercent] = useState(0)
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set())
  const [attachedImage, setAttachedImage] = useState<string | null>(null)
  const attachmentsRef = useRef<Map<string, { content: string; isImage: boolean }>>(new Map())
  const [attachVersion, setAttachVersion] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [collapsedItems, setCollapsedItems] = useState<Set<string>>(new Set())
  const toggleCollapse = (id: string) => {
    setCollapsedItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const { confirmingCmd, requestPermission, clearPermission, alwaysApprove, setAlwaysApprove } = useCommandPermission()
  const toggleError = (id: string) => {
    setExpandedErrors(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }
  const autoRetryTimerRef = useRef<NodeJS.Timeout | null>(null)
  const retryCountRef = useRef(0)
  const lastErrorAnalysisRef = useRef<ErrorAnalysis | null>(null)
  const tokenCountRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const buildOutputRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  // idx (from the streaming delta) -> timeline file id, reset once per model step
  const previewFileIds = useRef<Map<number, string>>(new Map())
  const { checkpointStack, saveCheckpoint, undoLastCheckpoint } = useCheckpoint()

  const calcTokens = (content: string) => countTokens(content)

  // ResizeObserver auto-scroll — only when user hasn't scrolled up
  useEffect(() => {
    const el = buildOutputRef.current
    if (!el) return
    const onScroll = () => {
      const isUp = el.scrollHeight - el.scrollTop - el.clientHeight > 60
      setUserScrolledUp(isUp)
    }
    el.addEventListener('scroll', onScroll)
     const ro = new ResizeObserver(() => {
       if (!userScrolledUp) {
         el.scrollTop = el.scrollHeight
       }
     })
     ro.observe(el)
     
     // Periodic force-scroll during response generation to ensure fluidity
     const scrollInterval = setInterval(() => {
       if (isRunning && !userScrolledUp) {
         el.scrollTop = el.scrollHeight
       }
     }, 100)

     return () => {
       el.removeEventListener('scroll', onScroll)
       ro.disconnect()
       clearInterval(scrollInterval)
     }
   }, [timeline.length, isRunning, userScrolledUp])

  // ── Tool execution ──

  /** Scan real filesystem and sync into buildProjectFiles store */
  const syncFromDisk = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const store = useAppStore.getState()
      const workDir = store.builds[buildId]?.workDir
      const buildDir = (workDir || await window.electronAPI.getBuildDirectory()).replace(/\\/g, '/')
      const files = await window.electronAPI.readDirRecursive(buildDir)
      for (const rawPath of files) {
        const normalized = rawPath.replace(/\\/g, '/')
        const relPath = normalized.startsWith(buildDir + '/')
          ? normalized.slice(buildDir.length + 1)
          : normalized
        if (!relPath) continue
        const s2 = useAppStore.getState()
        if (!s2.builds[buildId].projectFiles.find(f => f.path === relPath)) {
          const content = await window.electronAPI.readFile(rawPath)
          s2.addBuildFile(buildId, { path: relPath, content })
        }
      }
    } catch (e) {
      console.debug('[BuildAgent] syncFromDisk:', e)
    }
  }, [buildId])

  const execTool = useCallback(async (tc: BuildToolCall): Promise<BuildFileEvent> => {
    try {
    tc.arguments = tc.arguments || {}
    const path = tc.arguments.path || ''

    // ── ls: list directory (reads from real filesystem) ──
    if (tc.name === 'ls') {
      const rawPath = tc.arguments.path || '.'
      const dirPath = rawPath.replace(/^\.\/?/, '').replace(/^\/+/, '').replace(/\/+$/, '')
      if (window.electronAPI) {
        try {
      const store = useAppStore.getState()
      const workDir = store.builds[buildId]?.workDir
      const buildDir = (workDir || await window.electronAPI.getBuildDirectory())
      const targetDir = dirPath ? joinPaths(buildDir, dirPath) : buildDir
      const names = await window.electronAPI.readDir(targetDir)
          const listing = names.length ? names.join('\n') : '(empty directory)'
          return { action: 'read', path: rawPath, stats: { added: 0, removed: 0 }, status: 'success', content: listing }
        } catch (e) {
          console.debug('[BuildAgent] ls filesystem error:', e)
        }
      }
      const state = useAppStore.getState()
      const files = dirPath === ''
        ? state.builds[buildId].projectFiles
        : state.builds[buildId].projectFiles.filter(f => f.path === dirPath || f.path.startsWith(dirPath + '/'))
      const listing = files.length ? files.map(f => f.path).join('\n') : '(empty directory)'
      return { action: 'read', path: rawPath, stats: { added: 0, removed: 0 }, status: 'success', content: listing }
    }

    // ── glob_search: find files by pattern ──
    if (tc.name === 'glob_search') {
      const pattern = tc.arguments.pattern || ''
      const regexBody = pattern.replace(/\*\*|\*|\?/g, (m) => m === '**' ? '.*' : m === '*' ? '[^/]*' : '.')
      const regex = new RegExp('^' + regexBody + '$')
      // Try real filesystem first
      if (window.electronAPI) {
        try {
          const store = useAppStore.getState()
          const workDir = store.builds[buildId]?.workDir
          const buildDir = (workDir || await window.electronAPI.getBuildDirectory())
          const files = await window.electronAPI.readDirRecursive(buildDir)
          const matches = files.map(f => f.replace(buildDir.replace(/\\/g, '/'), '').replace(/^[/\\]/, '').replace(/\\/g, '/')).filter(f => f && regex.test(f))
          const listing = matches.length ? matches.join('\n') : '(no matches)'
          return { action: 'read', path: `glob:${pattern}`, stats: { added: 0, removed: 0 }, status: 'success', content: listing }
        } catch (e) {
          // Fallback to in-memory
        }
      }
      const state = useAppStore.getState()
      const matches = state.builds[buildId].projectFiles.filter(f => regex.test(f.path))
      const listing = matches.length ? matches.map(f => f.path).join('\n') : '(no matches)'
      return { action: 'read', path: `glob:${pattern}`, stats: { added: 0, removed: 0 }, status: 'success', content: listing }
    }

    // ── grep_search: search file contents by regex ──
    if (tc.name === 'grep_search') {
      const pattern = tc.arguments.pattern || ''
      // Try real filesystem first
      if (window.electronAPI) {
        try {
          const store = useAppStore.getState()
          const workDir = store.builds[buildId]?.workDir
          const buildDir = (workDir || await window.electronAPI.getBuildDirectory())
          const files = await window.electronAPI.readDirRecursive(buildDir)
          const regex = new RegExp(pattern)
          const results: string[] = []
          for (const fullPath of files) {
            try {
              const content = await window.electronAPI.readFile(fullPath)
              const lines = content.split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  const relPath = fullPath.replace(buildDir.replace(/\\/g, '/'), '').replace(/^[/\\]/, '').replace(/\\/g, '/')
                  results.push(`${relPath}:${i + 1}: ${lines[i]}`)
                }
              }
            } catch { /* skip unreadable */ }
          }
          const listing = results.length ? results.join('\n') : '(no matches)'
          return { action: 'read', path: `grep:${pattern}`, stats: { added: 0, removed: 0 }, status: 'success', content: listing }
        } catch (e) {
          // Fallback to in-memory
        }
      }
      const state = useAppStore.getState()
      try {
        const regex = new RegExp(pattern)
        const results = state.builds[buildId].projectFiles.flatMap(f => {
          const lines = f.content.split('\n')
          const matches: string[] = []
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push(`${f.path}:${i + 1}: ${lines[i]}`)
            }
          }
          return matches
        })
        const listing = results.length ? results.join('\n') : '(no matches)'
        return { action: 'read', path: `grep:${pattern}`, stats: { added: 0, removed: 0 }, status: 'success', content: listing }
      } catch {
        return { action: 'read', path: `grep:${pattern}`, stats: { added: 0, removed: 0 }, status: 'error', error: 'Invalid regex pattern' }
      }
    }

    if (tc.name === 'create_zip') {
      const fileName = tc.arguments.fileName || 'project.zip'
      const state = useAppStore.getState()
      const files = state.builds[buildId].projectFiles
      if (files.length === 0) {
        return { action: 'run', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: 'No files to zip' }
      }
      try {
        const zip = new JSZip()
        for (const file of files) {
          zip.file(file.path, file.content)
        }
        const zipBlob = await zip.generateAsync({ type: 'blob' })
        const arrayBuffer = await zipBlob.arrayBuffer()
        const base64Zip = arrayBufferToBase64(arrayBuffer)
        
        if (window.electronAPI?.saveBuildFile) {
          await window.electronAPI.saveBuildFile({ content: base64Zip, defaultName: fileName })
        } else {
          const url = URL.createObjectURL(zipBlob)
          const a = document.createElement('a')
          a.href = url; a.download = fileName
          a.click()
          URL.revokeObjectURL(url)
        }
        return { action: 'run', path: fileName, stats: { added: 1, removed: 0 }, status: 'success', content: `Successfully created ${fileName} containing ${files.length} files.` }
      } catch (e: any) {
        return { action: 'run', path: fileName, stats: { added: 0, removed: 0 }, status: 'error', error: `Zip failed: ${e.message}` }
      }
    }

    if (['create_file', 'read_file', 'edit_file'].includes(tc.name)) {
      const err = validatePath(path)
      if (err) return { action: tc.name === 'create_file' ? 'create' : 'edit', path, stats: { added: 0, removed: 0 }, status: 'error', error: err }
    }

    const state = useAppStore.getState()
        const existing = state.builds[buildId].projectFiles.find(f => f.path === path)

    if (tc.name === 'create_file') {
      const content = tc.arguments.content || ''
      const lines = content.split('\n').length
      const oldContent = existing ? existing.content : ''
      // Save checkpoint for undo
      if (existing) saveCheckpoint(buildId, path, oldContent)
      await withFileMutationQueue(path, async () => {
        if (existing) {
          updateBuildFile(buildId, path, content)
        } else {
          addBuildFile(buildId, { path, content })
        }
        if (window.electronAPI?.writeBuildFile) {
          const store = useAppStore.getState()
          const writePath = store.builds[buildId]?.workDir ? joinPaths(store.builds[buildId]!.workDir!, path) : path
          await window.electronAPI.writeBuildFile({ filePath: writePath, content })
        } else {
          console.warn('[BuildAgent] electronAPI.writeBuildFile not available')
        }
      })
      const node = createCanvasNode(path, content)
      const existingNode = useAppStore.getState().canvasElements.find(e => e.componentId === 'build:' + path)
      if (existingNode) {
        const isHtml = path.endsWith('.html')
        updateCanvasElement(existingNode.id, {
          html: isHtml ? '' : wrapContent(content, path.split('.').pop() || '', path),
          css: '',
          iframeSrcDoc: isHtml ? content : undefined,
        })
      } else {
        addCanvasElement(node)
        const els = useAppStore.getState().canvasElements
        if (els.length > 1) addConnection({ id: crypto.randomUUID?.() || Math.random().toString(36).slice(2), fromId: els[els.length - 2].id, toId: node.id })
      }
      if (path.endsWith('.html')) {
        saveImport({ name: basename(path), html: content, css: '', js: '', source: 'build-agent' })
      }
      const stats = existing ? computeDiffStats(oldContent, content) : { added: lines, removed: 0 }
      return { action: 'create', path, stats, status: 'success', content }
    }

    if (tc.name === 'read_file') {
      if (!existing) return { action: 'read', path, stats: { added: 0, removed: 0 }, status: 'error', error: 'File not found' }
      const startLine = tc.arguments.start_line ? parseInt(tc.arguments.start_line) : undefined
      const endLine = tc.arguments.end_line ? parseInt(tc.arguments.end_line) : undefined
      
      let content = existing.content
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split('\n')
        const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0
        const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length
        content = lines.slice(start, end).join('\n')
      }
      return { action: 'read', path, stats: { added: 0, removed: 0 }, status: 'success', content }
    }

    if (tc.name === 'git_status') {
      return execGitStatus()
    }
    if (tc.name === 'git_diff') {
      return execGitDiff()
    }
    if (tc.name === 'git_log') {
      return execGitLog()
    }
    if (tc.name === 'generate_image') {
      const prompt = tc.arguments.prompt || ''
      const result = await window.electronAPI?.generateImage({ prompt })
      const contentType = (typeof result === 'string' && result.startsWith('data:')) ? result.split(';')[0].split('/')[1] : 'png'
      return { action: 'read', path: `generated_image.${contentType || 'png'}`, stats: { added: 0, removed: 0 }, status: 'success', content: result || '' }
    }
    if (tc.name === 'edit_image') {
      const prompt = tc.arguments.prompt || ''
      const imageBase64 = tc.arguments.imageBase64 || ''
      const result = await window.electronAPI?.editImage({ prompt, imageBase64 })
      const contentType = (typeof result === 'string' && result.startsWith('data:')) ? result.split(';')[0].split('/')[1] : 'png'
      return { action: 'read', path: `edited_image.${contentType || 'png'}`, stats: { added: 0, removed: 0 }, status: 'success', content: result || '' }
    }
    if (tc.name === 'git_commit') {
      const message = tc.arguments.message || 'Update'
      return execGitCommit(message)
    }

    if (tc.name === 'semantic_search') {
      const query = (tc.arguments.query || '').toLowerCase()
      const state = useAppStore.getState()
      const files = state.builds[buildId].projectFiles
      
      let map: Record<string, string[]> = {}
      const mapFile = files.find(f => f.path === 'project_map.json')
      if (mapFile) {
        try { map = JSON.parse(mapFile.content) } catch {}
      }

      const results: string[] = []
      for (const file of files) {
        if (file.path.toLowerCase().includes(query) || file.content.toLowerCase().includes(query)) {
          results.push(file.path)
        }
      }

      const finalResults = new Set(results)
      for (const path of results) {
        const deps = map[path] || []
        deps.forEach(d => {
          const resolved = files.find(f => f.path.endsWith(d))?.path
          if (resolved) finalResults.add(resolved)
        })
      }

      return { 
        action: 'read', 
        path: 'semantic_search', 
        stats: { added: 0, removed: 0 }, 
        status: 'success', 
        content: `Suggested files for query "${query}":\n${Array.from(finalResults).join('\n') || 'No relevant files found. Try generating a project map first.'}` 
      }
    }

    if (tc.name === 'generate_project_map') {
      const state = useAppStore.getState()
      const files = state.builds[buildId].projectFiles
      const map: Record<string, string[]> = {}
      
      for (const file of files) {
        const imports = [...file.content.matchAll(/(?:import|require)[\s\S]+?["']\.\/?([^"']+)["']/g)].map(m => m[1])
        map[file.path] = imports
      }
      
      const content = JSON.stringify(map, null, 2)
      await execTool({ name: 'create_file', arguments: { path: 'project_map.json', content } } as any)
      return { action: 'run', path: 'project_map.json', stats: { added: 0, removed: 0 }, status: 'success', content: 'Project map generated.' }
    }

    if (tc.name === 'run_command') {
      if (!window.electronAPI) {
        return { action: 'run', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: 'Electron API not available. Please restart the app.' }
      }
      const store = useAppStore.getState()
      const workDir = store.builds[buildId]?.workDir
      const buildDir = (workDir || await window.electronAPI.getBuildDirectory())
      const cmd = tc.arguments.command || ''
      const cwd = tc.arguments.cwd ? joinPaths(buildDir, tc.arguments.cwd) : buildDir
      
      const approved = await requestPermission(cmd, cwd)
      if (!approved) {
        return { action: 'run', path: cwd || '/', stats: { added: 0, removed: 0 }, status: 'error', error: 'Command rejected by user' }
      }
      setIsShellRunning(true)
      setRunningCommand(cmd)
      try {
        if (!window.electronAPI?.runCommand) {
          throw new Error('Electron API runCommand not available')
        }
        const result = await window.electronAPI.runCommand({ command: cmd, cwd })
        setIsShellRunning(false)
        setRunningCommand('')
        
        // AUTO-HEALING: If error exists, auto-inject into conversation
        if (result.exitCode !== 0) {
          const autoFixMsg = `The command '${cmd}' failed with the following error:\n${result.stderr}\n\nPlease analyze the files involved and fix the issue immediately.`
          conversationRef.current.push({ role: 'user', content: autoFixMsg })
        }
        
        return {
          action: 'run',
          path: cwd || '/',
          stats: { added: 0, removed: 0 },
          status: result.exitCode === 0 ? 'success' : 'error',
          content: truncateTerminalOutput((result.stdout + '\n' + result.stderr).trim()),
          error: result.error || undefined,
        }
      } catch (e) {
        setIsShellRunning(false)
        setRunningCommand('')
        throw e
      }
    }

    if (!existing) return { action: 'edit', path, stats: { added: 0, removed: 0 }, status: 'error', error: 'File not found' }
    setBuildEditingPaths(buildId, [path])

    const oldStr = tc.arguments.old_str || ''
    const newStr = tc.arguments.new_str || ''
    const replaceAll = tc.arguments.replace_all === 'true'
    const oldFull = existing.content

    try {
      // Strip BOM, normalize line endings, then apply edits
      const { bom, text: cleanContent } = stripBom(oldFull)
      const originalEnding = detectLineEnding(cleanContent)
      const edits = replaceAll
        ? [{ oldText: oldStr, newText: newStr }]
        : [{ oldText: oldStr, newText: newStr }]

      const { baseContent, newContent: editedContent } = applyEditsToNormalizedContent(
        normalizeToLF(cleanContent),
        edits,
        path,
      )
      const finalContent = bom + restoreLineEndings(editedContent, originalEnding)

      if (finalContent === oldFull) {
        setBuildEditingPaths(buildId, [])
        return { action: 'edit', path, stats: { added: 0, removed: 0 }, status: 'error', error: 'No changes made — replacement produced identical content' }
      }

      // Save checkpoint for undo
      saveCheckpoint(buildId, path, oldFull)
      await withFileMutationQueue(path, async () => {
        updateBuildFile(buildId, path, finalContent)
        if (window.electronAPI?.writeBuildFile) {
          const store = useAppStore.getState()
          const writePath = store.builds[buildId]?.workDir ? joinPaths(store.builds[buildId]!.workDir!, path) : path
          await window.electronAPI.writeBuildFile({ filePath: writePath, content: finalContent })
        } else {
          console.warn('[BuildAgent] electronAPI.writeBuildFile not available')
        }
      })
      const stats = computeDiffStats(oldFull, finalContent)
      const existingNode = useAppStore.getState().canvasElements.find(e => e.componentId === 'build:' + path)
      if (existingNode) {
        const isHtml = path.endsWith('.html')
        updateCanvasElement(existingNode.id, {
          html: isHtml ? '' : wrapContent(finalContent, path.split('.').pop() || '', path),
          css: '',
          iframeSrcDoc: isHtml ? finalContent : undefined,
        })
      }
      setBuildEditingPaths(buildId, [])
      return { action: 'edit', path, stats, status: 'success', content: finalContent }
    } catch (err: any) {
      setBuildEditingPaths(buildId, [])
      return { action: 'edit', path, stats: { added: 0, removed: 0 }, status: 'error', error: err.message || 'Edit failed' }
    }
    } catch (err: any) {
      console.error('[BuildAgent] execTool unexpected error:', err)
      const tc = (arguments[0] as BuildToolCall) || {} // This is a bit tricky since we are in a callback
      const action = tc.name === 'run_command' ? 'run' : 'read'
      const path = (tc.arguments || {}).path || ''
      return { action, path, stats: { added: 0, removed: 0 }, status: 'error', error: err.message || 'Unexpected error' }
    }
  }, [buildId, addBuildFile, updateBuildFile, addCanvasElement, addConnection, updateCanvasElement, setBuildEditingPaths, saveImport, setIsShellRunning, syncFromDisk])

  // ── Streaming ──

  const streamWithCallbacks = useCallback(async (
    messages: { role: string; content: string }[],
    signal: AbortSignal,
    onText: (chunk: string) => void,
    onToolPreview?: (idx: number, name: string, path: string | undefined, contentSoFar: string) => void,
  ): Promise<{ text: string; toolCalls: BuildToolCall[]; inlineData?: { mimeType: string; data: string }[] }> => {
    const { provider, baseUrl, model: modelName, apiKeys } = apiSettings
    const apiKey = apiKeys[provider] || ''
    // Context validation: prune messages if approaching context limit
    const modelCfg = { model: modelName, defaultCompletionOptions: { contextLength: 200_000, maxTokens: 32768 } }
    let validMessages = [...messages]
    let validation = validateContextBeforeApi(validMessages as any, modelCfg)
    while (!validation.isValid && validMessages.length > 1) {
      const removed = validMessages.shift()
      if (removed?.role === 'assistant' && validMessages[0]?.role === 'user') validMessages.shift()
      validation = validateContextBeforeApi(validMessages as any, modelCfg)
    }
    if (!validation.isValid) throw new Error(`Context limit exceeded: ${validation.error}`)

    // Check if auto-compaction would help — and actually apply it
    const contextInfo = validateContextLength({
      chatHistory: messages.map(m => ({ message: { role: m.role as any, content: m.content } })),
      model: { model: modelName, defaultCompletionOptions: { contextLength: 200_000 } },
    })
    if (contextInfo.isValid && contextInfo.inputTokens) {
      const pct = calculateContextUsagePercentage(contextInfo.inputTokens, { model: modelName, defaultCompletionOptions: { contextLength: 200_000 } })
      const historyForCompact = messages.map(m => ({ message: { role: m.role, content: m.content } }))
      const needsCompact = shouldAutoCompact({ history: historyForCompact as any, model: modelCfg })
      const keyOk = provider === 'openai' ? isValidAnthropicApiKey(apiKey) : true
      const keyErr = getApiKeyValidationError(apiKey)
      const compactIdx = findCompactionIndex(historyForCompact as any)
      const prunedByLast = pruneLastMessage(historyForCompact as any)
      console.debug(`[BuildAgent] session=${sessionId} context=${pct}% compact=${needsCompact} idx=${compactIdx} pruneLast=${prunedByLast.length} keyOk=${keyOk} keyErr=${keyErr}`)
      // Actually compact: if there's a prior compaction point, slice to it
      if (needsCompact && compactIdx !== null && compactIdx > 0) {
        const compactedMessages = getHistoryForLLM(historyForCompact as unknown as any[], compactIdx) as unknown as typeof messages
        if (compactedMessages.length < messages.length) {
          console.debug(`[BuildAgent] applied compaction: ${messages.length} -> ${compactedMessages.length} messages`)
          messages = compactedMessages.map(m => ({ role: (m as any).message?.role || (m as any).role, content: (m as any).message?.content || (m as any).content || '' }))
        }
      } else if (needsCompact && messages.length > 4) {
        // No prior compaction point — prune oldest preserving system + recent context
        const keep = Math.max(4, Math.ceil(messages.length * 0.6))
        const system = messages[0]?.role === 'system' ? [messages[0]] : []
        const tail = messages.slice(messages.length - keep + system.length)
        messages = [...system, { role: 'assistant' as any, content: `[Auto-compacted: conversation history truncated from ${messages.length} to ${system.length + tail.length} messages to stay within context limits]` }, ...tail]
        console.debug(`[BuildAgent] pruned compact: kept ${messages.length} messages`)
      }
    }
    
    messages = validMessages

    let url = ''
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (provider === 'llama' || provider === 'ollama') {
      url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
    } else if (provider === 'openai') {
      url = 'https://api.openai.com/v1/chat/completions'
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    } else if (provider === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions'
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    } else if (provider === 'gemini') {
      const cleanModel = modelName.replace(/^models\//, '')
      url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent`
      if (apiKey) headers['x-goog-api-key'] = apiKey
    }

    const isGemini = provider === 'gemini'

    if (isGemini) {
      const geminiResult = await executeStreamingApi(
        messages as BuildMessage[],
        modelCfg,
        provider,
        baseUrl,
        apiKey,
        TOOL_DEFS,
        {
          onContent: (delta) => onText(delta),
          onToolStart: (name, args) => {
            if (onToolPreview && (name === 'create_file' || name === 'edit_file')) {
              const argObj = args || {}
              onToolPreview(0, name, argObj.path, argObj.content ?? argObj.new_str ?? '')
            }
          },
        },
        signal,
      )
      return { text: geminiResult.text, toolCalls: geminiResult.toolCalls as any, inlineData: geminiResult.inlineData }
    }

    const bodyObj: any = {
      model: modelName, messages,
      temperature: 0.2, max_tokens: 32768,
    }
    // Apply tool overrides per provider
    const override = TOOL_OVERRIDES[provider]
    const toolsForRequest = override
      ? TOOL_DEFS.map(t => ({
          ...t,
          function: { ...t.function, ...override, parameters: t.function.parameters },
        }))
      : TOOL_DEFS
    // llama.cpp/ollama often don't support OpenAI tool calling — skip tools and rely on fallback text parsing
    if (provider !== 'llama' && provider !== 'ollama') {
      bodyObj.tools = toolsForRequest
      bodyObj.tool_choice = 'auto'
    }
    bodyObj.stream = true
    if (provider === 'llama' && apiSettings.disableReasoning) bodyObj.stop = ['<think>']

    const res = await withRetry(async (retrySignal) => {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(bodyObj), signal: retrySignal })
      if (!r.ok) {
        let detail = ''
        try { detail = await r.text() } catch {}
        throw new Error(`API error: ${r.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`)
      }
      return r
    }, signal)
    if (!res.body) throw new Error('No response body')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    let fallbackToolText = ''
    let isFallbackToolMode = false
    let textBuffer = ''
    const toolCallsMap = new Map<number, { name: string; args: string }>()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6))
            const delta = parsed.choices?.[0]?.delta
            if (delta?.content) {
              fullText = processChunkContent(delta.content, fullText)
              if (!isFallbackToolMode && looksLikeToolCallJson(fullText)) {
                isFallbackToolMode = true
                fallbackToolText = fullText
                textBuffer = ''
              }
    if (isFallbackToolMode) {
      fallbackToolText += delta.content
    } else {
      textBuffer += delta.content
      onText(delta.content) // Send immediately for live streaming
    }
    if (textBuffer.length > 1000) {
      textBuffer = '' // Prevent memory leak but keep streaming live
    }
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index
                if (!toolCallsMap.has(idx)) toolCallsMap.set(idx, { name: '', args: '' })
                const existing = toolCallsMap.get(idx)!
                if (tc.function?.name) existing.name += tc.function.name
                if (tc.function?.arguments) existing.args += tc.function.arguments

                // Live preview: as create_file/edit_file arguments stream in, surface
                // the growing content immediately instead of waiting for the full call.
                if (onToolPreview && (existing.name === 'create_file' || existing.name === 'edit_file')) {
                  const partial = parsePreviewArgs(existing.args)
                  if (partial) {
                    const previewContent = partial.content ?? partial.new_str ?? ''
                    onToolPreview(idx, existing.name, partial.path, previewContent)
                  }
                }
              }
            }
          } catch {}
        }
      }
    }

    // Flush any remaining buffered text if not a tool call
    if (textBuffer && !isFallbackToolMode) {
      onText(textBuffer)
      textBuffer = ''
    }

    if (isFallbackToolMode && fallbackToolText.trim()) {
      const extracted = extractToolCallsFromText(fallbackToolText)
      if (extracted.length > 0) {
        for (const item of extracted) {
          toolCallsMap.set(toolCallsMap.size + 1000, {
            name: item.name,
            args: JSON.stringify(item.args),
          })
        }
      } else {
        onText('\n⚠ A tool call from the model could not be parsed and was dropped.')
      }
    }

    // ── HTML auto-detection ──
    // If no tool calls were detected but the output looks like raw HTML, auto-create a file
    if (toolCallsMap.size === 0 && looksLikeHtml(fullText)) {
      const fileName = 'index.html'
      toolCallsMap.set(0, {
        name: 'create_file',
        args: JSON.stringify({ path: fileName, content: fullText }),
      })
    }

    // Build tool calls from streamed deltas
    const toolCalls: BuildToolCall[] = []
    for (const [k, v] of toolCallsMap) {
      if (v.name) {
        try {
          const args = JSON.parse(v.args)
          ;(args as any).__previewKey = k
          toolCalls.push({ name: v.name as any, arguments: args })
        } catch {
          toolCalls.push({ name: v.name as any, arguments: { __previewKey: k } as any })
        }
      }
    }

    // Strip tool call JSON from returned text (handles nested braces in args)
    let cleanContent = fullText
    if (toolCallsMap.size > 0) {
      const re = /\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{/g
      let m: RegExpExecArray | null
      while ((m = re.exec(cleanContent)) !== null) {
        let depth = 1
        let i = m.index + m[0].length - 1
        while (i < cleanContent.length && depth > 0) {
          i++
          if (cleanContent[i] === '{') depth++
          else if (cleanContent[i] === '}') depth--
        }
        if (depth === 0) {
          cleanContent = cleanContent.slice(0, m.index) + cleanContent.slice(i + 1)
          re.lastIndex = 0
        }
      }
      // Remove array-wrapped tool calls
      cleanContent = cleanContent.replace(/\[[\s\S]*?\]/g, inner => {
        try { const p = JSON.parse(inner); if (Array.isArray(p) && p.length > 0 && p[0]?.name) return ''; return inner } catch { return inner }
      })
      cleanContent = cleanContent.replace(/```[\w]*\n?[\s\S]*?```/g, '')
      cleanContent = cleanContent.replace(/```tool[\s\S]*?```/g, '')
      if (looksLikeHtml(cleanContent)) cleanContent = ''
      cleanContent = cleanContent.trim()
    }

    return { text: cleanContent, toolCalls }
  }, [apiSettings])

  // ── Shared per-run helpers (used by both a fresh build and a continued build) ──

  /** Builds the live-preview callback for a single model step. */
  const makePreviewHandler = useCallback(() => {
    return (idx: number, name: string, path: string | undefined, contentSoFar: string) => {
      if (!path) return
      const tokenCount = countTokens(contentSoFar)
      const lineCount = contentSoFar ? contentSoFar.split('\n').length : 0
      const existingId = previewFileIds.current.get(idx)
      if (!existingId) {
        const fileId = nextId()
        previewFileIds.current.set(idx, fileId)
        addTimelineItem(buildId, {
          type: 'file', id: fileId, path,
          action: name === 'create_file' ? 'create' : 'edit',
          stats: { added: lineCount, removed: 0 }, 
          tokenCount, 
          status: 'pending',
        })
      } else {
        updateTimelineItem(buildId, existingId, { path, stats: { added: lineCount, removed: 0 }, tokenCount })
      }
    }
  }, [addTimelineItem, updateTimelineItem])

  /** Runs one agent turn to completion (looping over model steps until it stops or hits a guard). */
    const runAgentLoop = useCallback(async (conversation: { role: string; content: string }[]) => {
      let stepCount = 0
      const MAX_STEPS = 30

      // Per-turn guards
      let codeFileTouchedThisTurn = false
      let ranCommandThisTurn = false
      let verifyNudged = false
      let lastToolSig = ''
      let repeatSigCount = 0

      // 1. FULL PROJECT SNAPSHOT: Save state before starting the turn
      const state = useAppStore.getState()
      const projectSnapshot = state.builds[buildId]?.projectFiles.map(f => ({ ...f })) || []
      saveCheckpoint(buildId, 'PROJECT_SNAPSHOT', JSON.stringify(projectSnapshot))

      await syncFromDisk()

      while (stepCount < MAX_STEPS) {
        try {
          stepCount++
          abortRef.current?.abort()
          buildAbortControllers.delete(buildId)
          abortRef.current = new AbortController()
          buildAbortControllers.set(buildId, abortRef.current)

          tokenCountRef.current = 0
          setTokenCount(0)
          
          // 2. ADVANCED CONTEXT CHECK: Use analyzeError logic to pre-emptively compact
          const totalTokens = conversation.reduce((s, m) => s + calcTokens((m as any)?.content || ''), 0)
          setContextPercent(Math.min(100, Math.round((totalTokens / 200_000) * 100)))
          
          if (totalTokens > 150_000) { // Start compacting at 75% to be safe
            const historyForCompact = conversation.map(m => ({ message: { role: m.role, content: m.content } }))
            const compactIdx = findCompactionIndex(historyForCompact as any)
            if (compactIdx !== null && compactIdx > 0) {
              const compacted = getHistoryForLLM(historyForCompact as unknown as any[], compactIdx) as unknown as typeof conversation
              conversation = compacted.map(m => ({ role: (m as any).message?.role || (m as any).role, content: (m as any).message?.content || (m as any).content || '' }))
            }
          }

          previewFileIds.current = new Map()
          const assistantId = nextId()
          addTimelineItem(buildId, { type: 'assistant', id: assistantId, content: '' })

          const onToolPreview = makePreviewHandler()

      const { text, toolCalls, inlineData } = await streamWithCallbacks(conversation, abortRef.current!.signal, (chunk) => {
        // Prevent leaking raw tool calls or plan tags
        const cleanChunk = chunk.replace(/<plan>[\s\S]*?<\/plan>/gi, '')
                                .replace(/\[\{"name":[\s\S]*?\}\]/gi, '')
        
        const cur = useAppStore.getState().builds[buildId].timeline
            const target = cur.find(t => t.id === assistantId)
            if (!target) return
            const newContent = (target.content || '') + cleanChunk
            updateTimelineItem(buildId, assistantId, { content: newContent })
            tokenCountRef.current = calcTokens(newContent)
            setTokenCount(tokenCountRef.current)
          }, onToolPreview)

      // Save inline media (images, audio, etc.) from Gemini multimodal response
      if (inlineData && inlineData.length > 0) {
        for (const item of inlineData) {
          const ext = item.mimeType.split('/')[1]?.split(';')[0] || 'bin'
          const name = item.mimeType.startsWith('image/') ? 'generated' : 'file'
          const fileName = `${name}-${Date.now()}.${ext}`
          const dataUrl = `data:${item.mimeType};base64,${item.data}`
          const fileId = nextId()
          addTimelineItem(buildId, { type: 'file', id: fileId, path: fileName, action: 'create', stats: { added: 1, removed: 0 }, status: 'success', content: dataUrl })
          addBuildFile(buildId, { path: fileName, content: dataUrl })
          if (window.electronAPI) {
            const store = useAppStore.getState()
            const writePath = store.builds[buildId]?.workDir ? joinPaths(store.builds[buildId]!.workDir!, fileName) : fileName
            await window.electronAPI.writeBuildFile({ filePath: writePath, content: item.data })
          }
        }
      }

      const cleanText = text.trim()
      const hasTools = toolCalls.length > 0

      if (!hasTools) {
        if (!cleanText) {
          removeTimelineItem(buildId, assistantId)
        }
        // Verification nudge ENABLED: Only if intent is BUILD and files were touched
        const lastUserMsg = conversationRef.current[conversationRef.current.length - 1].content.toUpperCase()
        const isBuildIntent = lastUserMsg.includes('[BUILD]') || !lastUserMsg.includes('[RESEARCH]')
        
        if (true && isBuildIntent && codeFileTouchedThisTurn && !ranCommandThisTurn && !verifyNudged) {
          verifyNudged = true
          const nudge = '⚠ لقد قمت بتعديل كود برمجى ولكنك لم تقم بتشغيله للتحقق (run_command). يرجى التحقق من الكود قبل إنهاء المهمة.'
          addTimelineItem(buildId, { type: 'assistant', id: nextId(), content: nudge })
        }
        break
      }

      if (!cleanText) {
        removeTimelineItem(buildId, assistantId)
      }

      const pendingIds: string[] = []
      for (const tc of toolCalls) {
        tc.arguments = tc.arguments || {}
        const path = tc.arguments.pattern || tc.arguments.path || ''
        const previewKey = (tc.arguments as any).__previewKey
        const reuseId = previewKey !== undefined ? previewFileIds.current.get(previewKey) : undefined
        const fileId = reuseId || nextId()
        pendingIds.push(fileId)
        const action = tc.name === 'create_file' ? 'create' : tc.name === 'edit_file' ? 'edit' : tc.name === 'run_command' ? 'run' : 'read'
        if (!reuseId) {
          addTimelineItem(buildId, { type: 'file', id: fileId, path, action, stats: { added: 0, removed: 0 }, status: 'pending' })
        } else {
          updateTimelineItem(buildId, fileId, { path, action })
        }
      }

      const resultLines: string[] = []

      // ── Parallel tool execution ──
      // Group: read operations (ls, glob, grep, read_file) can run in parallel.
      // Write operations (create_file, edit_file) and run_command must run sequentially.
      const isReadOp = (name: string) => ['ls', 'glob_search', 'grep_search', 'read_file'].includes(name)
      const readOps = toolCalls.filter(tc => isReadOp(tc.name))
      const writeOps = toolCalls.filter(tc => !isReadOp(tc.name))

      // Execute reads in parallel
      const readResults = await Promise.all(readOps.map(async (tc) => {
        const ev = await execTool(tc)
        return { tc, ev }
      }))

      // Execute writes sequentially (order matters)
      const writeResults: { tc: typeof toolCalls[0]; ev: BuildFileEvent }[] = []
      for (const tc of writeOps) {
        const sig = tc.name + '::' + JSON.stringify(tc.arguments)
        if (sig === lastToolSig) repeatSigCount++
        else { repeatSigCount = 1; lastToolSig = sig }
        const ev = await execTool(tc)
        writeResults.push({ tc, ev })
      }

      // Merge results preserving original order
      const allResults: { tc: typeof toolCalls[0]; ev: BuildFileEvent }[] = []
      let ri = 0, wi = 0
      for (const tc of toolCalls) {
        if (isReadOp(tc.name)) {
          allResults.push(readResults[ri++])
        } else {
          allResults.push(writeResults[wi++])
        }
      }

      for (let i = 0; i < allResults.length; i++) {
        const { tc, ev } = allResults[i]

        // Loop guard (for sequential write ops only — read results already calculated)
        if (!isReadOp(tc.name)) {
          // Already handled above
        } else {
          const sig = tc.name + '::' + JSON.stringify(tc.arguments)
          if (sig === lastToolSig) repeatSigCount++
          else { repeatSigCount = 1; lastToolSig = sig }
        }

        // Build content preview for display
        const args = tc.arguments || {}
        let previewContent = ''
        let diffPreview = ''
        if (tc.name === 'create_file' && ev.status === 'success') {
          const lines = ((args.content as string) || '').split('\n')
          previewContent = lines.slice(0, 50).join('\n')
          if (lines.length > 50) previewContent += '\n...'
          diffPreview = lines.map(l => `+${l}`).join('\n').slice(0, 2000)
        }
        if (tc.name === 'edit_file' && ev.status === 'success') {
          const oldStr = (args.old_str as string) || ''
          const newStr = (args.new_str as string) || ''
          
          // If oldStr is empty but the edit was successful, it might be an addition
          const changes: Change[] = diffLines(oldStr, newStr)
          const parts: string[] = []
          
          for (const change of changes) {
            const lines = change.value.split('\n')
            for (const line of lines) {
              if (line === '') continue
              if (change.added) parts.push(`+${line}`)
              else if (change.removed) parts.push(`-${line}`)
              else parts.push(` ${line}`)
            }
          }
          
          // Ensure we have a preview even if the diff is empty but status is success
          diffPreview = parts.length > 0 ? parts.join('\n').slice(0, 2000) : `Modified ${ev.path}`
        }
        if (tc.name === 'run_command' && ev.content) {
          const lines = ev.content.split('\n')
          previewContent = lines.slice(0, 30).join('\n')
          if (lines.length > 30) previewContent += '\n...'
        }
        const isHtml = ev.path?.endsWith('.html')
        const fullContent = isHtml && tc.name === 'create_file' ? ((tc.arguments as any).content || '')
          : isHtml && tc.name === 'edit_file' ? (useAppStore.getState().builds[buildId].projectFiles.find(f => f.path === ev.path)?.content || '')
            : undefined
        updateTimelineItem(buildId, pendingIds[i], {
          path: ev.path, action: ev.action, stats: ev.stats, status: ev.status, error: ev.error,
          previewContent, diffPreview,
          toolName: tc.name, content: ev.content, iframeSrcDoc: fullContent,
        })
        const overwroteExisting = tc.name === 'create_file' && ev.status === 'success' && ev.stats.removed > 0
        // Full content for AI context (needed for edit_file to find exact old_str)
        resultLines.push(
          ev.status === 'error'
            ? `${ev.action} ${ev.path}: ERROR — ${ev.error || ''}${ev.content ? '\nOutput:\n' + ev.content : ''}`
            : ev.action === 'read'
              ? `Content of ${ev.path}:\n\`\`\`\n${ev.content}\n\`\`\``
              : ev.action === 'run'
                ? `Shell Output (${ev.path}):\n\`\`\`\n${ev.content}\n\`\`\``
                : overwroteExisting
                  ? `${ev.action} ${ev.path}: +${ev.stats.added} -${ev.stats.removed} (NOTE: this file already existed — you just overwrote ${ev.stats.removed} of its old lines. Make sure that was intentional.)`
                  : `${ev.action} ${ev.path}: +${ev.stats.added} -${ev.stats.removed}`
        )
        if (tc.name === 'run_command') ranCommandThisTurn = true
        if ((tc.name === 'create_file' || tc.name === 'edit_file') && /\.(py|js|html)$/i.test(tc.arguments.path || '')) {
          codeFileTouchedThisTurn = true
        }
      }
      inlineBuildAssets(buildId)

      // Hard stop if the model is stuck repeating the exact same call.
      if (repeatSigCount >= 4) {
        addTimelineItem(buildId, { type: 'assistant', id: nextId(), content: '⚠ توقفت لأن نفس الأمر تكرر عدة مرات بدون أي تغيير في النتيجة. جرب صياغة الطلب بشكل مختلف أو تحقق من بيئة التشغيل (shell) يدويًا.' })
        break
      }

      if (cleanText) {
        conversation.push({ role: 'assistant', content: cleanText })
      }
      const toolCallJson = JSON.stringify(toolCalls.map(tc => ({ name: tc.name, args: tc.arguments })))
      conversation.push({ role: 'assistant', content: toolCallJson })
      let toolResultMsg = `Tool results:\n${resultLines.join('\n')}\n\nContinue with next steps if needed, or write summary if done.`
      if (repeatSigCount === 3) {
        toolResultMsg += `\n\n⚠ NOTICE: You just called the exact same tool with identical arguments 3 times in a row with no new information. Do NOT repeat it again — try a different command, or explain the problem instead.`
      }
      conversation.push({ role: 'user', content: toolResultMsg })
      if (repeatSigCount === 3) {
        addTimelineItem(buildId, { type: 'user', id: nextId(), content: '⚠ Stop.' })
      }
      } catch (err: any) {
        if (err.name === 'AbortError') return
        
        // 3. SMART ERROR ANALYSIS: Use analyzeError to provide better feedback and auto-recovery
        const analysis = analyzeError(err)
        console.error(`[BuildAgent] Step Error [${analysis.statusCode || 'unknown'}]:`, err)
        
        const errContent = `Error: ${err?.message || err || 'Unknown error'}${analysis.customErrorMessage ? '\n\n' + analysis.customErrorMessage : ''}`
        const errorId = nextId()
        addTimelineItem(buildId, { type: 'assistant', id: errorId, content: errContent })
        setLastErrorId(errorId)
        setExpandedErrors(prev => new Set(prev).add(errorId))
        
        // Save conversation for the Retry button on error
        setRetryConversation(conversation)
        break
      }
    }

    return stepCount
  }, [buildId, streamWithCallbacks, execTool, addTimelineItem, updateTimelineItem, removeTimelineItem, makePreviewHandler, syncFromDisk])

  // ── Main build loop ──
  const conversationRef = useRef<{ role: string; content: string }[]>([])

  const handleOpenProject = async () => {
    const dir = await window.electronAPI.selectProjectDir()
    if (dir) {
      setBuildWorkDir(buildId, dir)
      addTimelineItem(buildId, {
        type: 'user', id: nextId(),
        content: `Working directory set to: \`${dir}\``,
      })
    }
  }

  const handleBuild = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt) return

    // Clear any previous retry state on fresh user message
    setRetryConversation(null)
    retryCountRef.current = 0

    // ── /new command — pick working directory ──
    if (prompt === '/new') {
      setInput('')
      if (!window.electronAPI?.selectDirectory) return
      const dir = await window.electronAPI.selectDirectory()
      if (dir) {
        setBuildWorkDir(buildId, dir)
        addTimelineItem(buildId, {
          type: 'user', id: nextId(),
          content: `Working directory set to: \`${dir}\``,
        })
        // Load files from the new directory into project files
        const state = useAppStore.getState()
        const files = await window.electronAPI.readDirRecursive(dir)
        for (const rawPath of files) {
          const normalized = rawPath.replace(/\\/g, '/')
          const relPath = normalized.startsWith(dir.replace(/\\/g, '/') + '/')
            ? normalized.slice(dir.replace(/\\/g, '/').length + 1)
            : normalized
          if (!relPath || relPath.startsWith('.git/') || relPath.startsWith('node_modules/')) continue
          const content = await window.electronAPI.readFile(rawPath)
          state.addBuildFile(buildId, { path: relPath, content })
        }
      }
      return
    }

    // ── /api command — open settings ──
    if (prompt === '/api') {
      setInput('')
      setShowSettings(true)
      return
    }

    // ── /info command — show app info ──
    if (prompt === '/info') {
      setInput('')
      setShowInfo(true)
      return
    }

    // ── /md command — export chat as markdown ──
    if (prompt === '/md') {
      setInput('')
      const lines: string[] = [`# Build Chat Export`, '', `**Date:** ${new Date().toLocaleString()}`, '', '---', '']
      for (const item of timeline) {
        if (item.content) {
          const role = item.type === 'user' ? '**You**' : item.type === 'assistant' ? '**Assistant**' : `**${item.type}**`
          lines.push(`${role} (${new Date(item.createdAt).toLocaleTimeString()}):`)
          lines.push('')
          lines.push(item.content)
          lines.push('')
          lines.push('---')
          lines.push('')
        }
      }
      const mdContent = lines.join('\n')
      window.electronAPI?.saveBuildFile({ content: mdContent, defaultName: 'build-chat.md' })
      return
    }

    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    // Resolve attachments: images → imageContent, files → file timeline items
    let imageContent: string | null = null
    const fileAttachments: { content: string; fileName: string }[] = []
    attachmentsRef.current.forEach((entry, marker) => {
      if (entry.isImage) {
        imageContent = entry.content
      } else {
        fileAttachments.push({ content: entry.content, fileName: marker.slice(1) })
      }
    })
    attachmentsRef.current.clear()
    setAttachVersion(0)

    // Check if model supports images
    const modelName = apiSettings.model?.toLowerCase() || ''
    const provider = apiSettings.provider
    const modelSupportsImages = 
      provider === 'gemini' ||
      (provider === 'openai' && (modelName.includes('vision') || modelName.includes('gpt-4o') || modelName.includes('gpt-4-turbo'))) ||
      (provider === 'openrouter' && (modelName.includes('vision') || modelName.includes('gpt-4o') || modelName.includes('claude-3') || modelName.includes('gemini')))

    if (imageContent && !modelSupportsImages) {
      const errMsg = `The selected model "${apiSettings.model}" does not support image input. Please switch to a vision-capable model or remove the image attachment.`
      addTimelineItem(buildId, { type: 'assistant', id: nextId(), content: errMsg })
      return
    }

    const isCurrentlyRunning = isRunning
    const userMsgId = nextId()
    addTimelineItem(buildId, {
      type: 'user', id: userMsgId,
      content: imageContent || prompt,
      previewContent: imageContent ? prompt : undefined,
    })

    // Add file attachments as file timeline items with visible content
    fileAttachments.forEach(att => {
      addTimelineItem(buildId, {
        type: 'file',
        id: nextId(),
        path: att.fileName,
        content: att.content,
        previewContent: att.content,
        action: 'read',
        status: 'success',
        stats: { added: 0, removed: 0 },
      })
    })

    // Build conversation content for AI
    const fileContext = fileAttachments.map(att =>
      `--- ${att.fileName || 'attached-file'} ---\n${att.content}\n--- end ---`
    ).join('\n\n')
    const conversationContent = imageContent
      ? `${imageContent}\n\n${prompt}`
      : fileContext
        ? `${fileContext}\n\n${prompt}`
        : prompt

    if (isCurrentlyRunning) {
      conversationRef.current.push({ role: 'user', content: conversationContent })
      return
    }

    setIsRunning(true)
    setBuildIsRunning(buildId, true)

    const state = useAppStore.getState()
    const currentFiles = state.builds[buildId].projectFiles
    const fileList = currentFiles.length
      ? `Current project files:\n` +
        currentFiles.map(f => `- ${f.path}`).join('\n')
      : 'No files exist in this project yet.'

    conversationRef.current = [
      { role: 'system', content: buildSystemPrompt(apiSettings.provider) + '\n\n' + fileList },
      ...useAppStore.getState().builds[buildId].timeline.filter(t => t.type !== 'file').map(t => ({
        role: t.type === 'user' ? 'user' as const : 'assistant' as const,
        content: t.content || '',
      })),
      { role: 'user', content: conversationContent },
    ]

    try {
      const stepCount = (await runAgentLoop(conversationRef.current)) ?? 0
      if (stepCount >= 30) {
        addTimelineItem(buildId, { type: 'assistant', id: nextId(), content: `⚠ Stopped after 30 steps — the task may be incomplete. Send another message to continue.` })
      }
    } catch (err: any) {
      // ... same catch as before
    } finally {
      setIsRunning(false)
      setBuildIsRunning(buildId, false)
      setContextPercent(0)
      abortRef.current = null
      buildAbortControllers.delete(buildId)
    }
  }, [buildId, input, isRunning, runAgentLoop, setBuildIsRunning, addTimelineItem, apiSettings, attachedImage])

  const handleContinueBuild = useCallback(async (isAutoRetry = false) => {
    if (isRunning) return

    // Auto-hide last error message to clean up chat
    const timeline = useAppStore.getState().builds[buildId].timeline
    const lastError = [...timeline].reverse().find(item => item.type === 'assistant' && item.content?.startsWith('Error:'))
    if (lastError) removeTimelineItem(buildId, lastError.id)

    if (!isAutoRetry) retryCountRef.current = 0

    setIsRunning(true)
    setBuildIsRunning(buildId, true)
    tokenCountRef.current = 0
    setTokenCount(0)


    const conversationToUse = retryConversation || conversationRef.current

    try {
      const stepCount = (await runAgentLoop(conversationToUse)) ?? 0
      if (stepCount >= 30) {
        addTimelineItem(buildId, { type: 'assistant', id: nextId(), content: `⚠ Stopped after 30 steps — the task may be incomplete. Send another message to continue.` })
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return
      const analysis = analyzeError(err)
      lastErrorAnalysisRef.current = analysis
      const customMsg = analysis.customErrorMessage ? `\n\n${analysis.customErrorMessage}` : ''
      const errContent = `Error: ${err.message}${customMsg}` + (analysis.statusCode ? `\n\n[status=${analysis.statusCode}]` : '')
      const errorId = nextId()
      addTimelineItem(buildId, { type: 'assistant', id: errorId, content: errContent })
      setLastErrorId(errorId)
      if (!err.message.includes('Abort')) setRetryConversation(conversationToUse)
    } finally {
      setIsRunning(false)
      setBuildIsRunning(buildId, false)
      setContextPercent(0)
      abortRef.current = null
      buildAbortControllers.delete(buildId)
    }
  }, [buildId, retryConversation, isRunning, runAgentLoop, setBuildIsRunning, addTimelineItem])

  const handleStop = () => { 
    abortRef.current?.abort(); 
    buildAbortControllers.delete(buildId)
    if (autoRetryTimerRef.current) {
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
      setIsAutoRetrying(false);
    }
    retryCountRef.current = 0
    setIsRunning(false); 
    setBuildIsRunning(buildId, false); 
    setContextPercent(0) 
  }
  const handleClear = () => { clearTimeline(buildId); setContextPercent(0) }
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleBuild() }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const isImage = file.type.startsWith('image/')
    const reader = new FileReader()
    reader.onload = () => {
      const content = reader.result as string
      const marker = `@${file.name}`
      attachmentsRef.current.set(marker, { content, isImage })
      setAttachVersion(v => v + 1)
    }
    if (isImage) {
      reader.readAsDataURL(file)
    } else {
      reader.readAsText(file)
    }
    e.target.value = ''
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const marker = `@${file.name || 'pasted-image.png'}`
          attachmentsRef.current.set(marker, { content: dataUrl, isImage: true })
          setAttachVersion(v => v + 1)
        }
        reader.readAsDataURL(file)
        return
      }
    }
  }

  // Ref for auto-retry (avoids closure staleness)
  const handleContinueBuildRef = useRef(handleContinueBuild)
  handleContinueBuildRef.current = handleContinueBuild

  // F5 to start build
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F5' || e.code === 'F5' || e.keyCode === 116) {
        e.preventDefault()
        try { handleBuild() } catch {}
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleBuild])

  // Scroll spy — track which user message is most centered
  useEffect(() => {
    const el = buildOutputRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const userItems = timeline.filter(i => i.type === 'user')
        const cr = el.getBoundingClientRect()
        const cx = cr.top + cr.height / 2
        let closest: string | null = null
        let minDist = Infinity
        for (const item of userItems) {
          const irm = itemRefs.current.get(item.id)
          if (!irm) continue
          const er = irm.getBoundingClientRect()
          const dist = Math.abs(er.top + er.height / 2 - cx)
          if (dist < minDist) { minDist = dist; closest = item.id }
        }
        setActiveMsgId(closest)
      })
    }
    el.addEventListener('scroll', onScroll)
    return () => { el.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [timeline])

  // Auto-retry on server errors with quota detection, max retries, and exponential backoff
  useEffect(() => {
    const lastItem = timeline[timeline.length - 1]
    if (!(lastItem?.type === 'assistant' && (lastItem.content?.includes('500') || lastItem.content?.includes('502') || lastItem.content?.includes('503') || lastItem.content?.includes('429')) && retryConversation && !isRunning)) {
      setIsAutoRetrying(false)
      return
    }

    const MAX_RETRIES = 3
    const analysis = lastErrorAnalysisRef.current

    // Quota/billing errors — never auto-retry
    if (analysis?.quotaExhausted) {
      setIsAutoRetrying(false)
      setRetryConversation(null)
      return
    }

    // Cap retries
    if (retryCountRef.current >= MAX_RETRIES) {
      setIsAutoRetrying(false)
      setRetryConversation(null)
      addTimelineItem(buildId, { type: 'assistant', id: nextId(), content: `⚠ Auto-retry stopped — the API did not recover after ${MAX_RETRIES} attempts. Click "Retry" to try again manually.` })
      retryCountRef.current = 0
      return
    }

    // Exponential backoff: 5s, 15s, 30s
    const delays = [5000, 15000, 30000]
    const delay = delays[retryCountRef.current] ?? 30000
    retryCountRef.current += 1

    setIsAutoRetrying(true)
    const timer = setTimeout(() => {
      setIsAutoRetrying(false)
      handleContinueBuild(true)
    }, delay)
    autoRetryTimerRef.current = timer
    return () => {
      clearTimeout(timer)
      autoRetryTimerRef.current = null
    }
  }, [timeline, retryConversation, isRunning])

  const handleSaveFileToPC = useCallback(async (path: string, content?: string) => {
    const state = useAppStore.getState()
    const file = state.builds[buildId].projectFiles.find(f => f.path === path)
    const data = content || file?.content
    if (!data) return
    const api = window.electronAPI
    if (api?.saveBuildFile) {
      if (data.startsWith('data:')) {
        // Base64 image — save via saveImageFile
        await api.saveImageFile(data, basename(path) || 'image.png')
      } else {
        await api.saveBuildFile({ content: data, defaultName: basename(path) || 'file.txt' })
      }
    } else {
      const mime = data.startsWith('data:') ? data.split(';')[0].split(':')[1] : 'text/plain'
      const blob = data.startsWith('data:')
        ? await (await fetch(data)).blob()
        : new Blob([data], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = basename(path) || 'file.txt'
      a.click()
      URL.revokeObjectURL(url)
    }
  }, [])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }
  }, [input])

  const handleRevert = (item: BuildTimelineItem) => {
    setInput(item.content || '')
    const state = useAppStore.getState()
    const build = state.builds[buildId]
    const timeline = build.timeline
    const index = timeline.findIndex(i => i.id === item.id)
    if (index === -1) return

    // Collect all file paths modified by items from this index onward
    const affectedPaths = new Set<string>()
    for (let i = index; i < timeline.length; i++) {
      const t = timeline[i]
      if (t.type === 'file' && t.path && (t.action === 'create' || t.action === 'edit')) {
        affectedPaths.add(t.path)
      }
    }

    // For each affected file, find the last version before the revert point
    const prevVersions = new Map<string, string>()
    for (const path of affectedPaths) {
      let found = false
      for (let i = index - 1; i >= 0; i--) {
        const t = timeline[i]
        if (t.type === 'file' && t.path === path && t.content !== undefined) {
          prevVersions.set(path, t.content)
          found = true
          break
        }
      }
      if (!found) {
        prevVersions.set(path, '') // empty = file didn't exist before
      }
    }

    // Remove all items from the clicked index onward
    for (let i = index; i < timeline.length; i++) {
      state.removeBuildTimelineItem(buildId, timeline[i].id)
    }

    // Restore files to their previous state
    for (const [path, content] of prevVersions) {
      if (content === '') {
        state.removeBuildFile(buildId, path)
      } else {
        state.updateBuildFile(buildId, path, content)
      }
    }

    setTimeout(() => {
      textareaRef.current?.focus()
      setUserScrolledUp(true)
    }, 100)
  }

  const handleDropFile = (file: File) => {
    const isImage = file.type.startsWith('image/')
    const reader = new FileReader()
    reader.onload = () => {
      const content = reader.result as string
      attachmentsRef.current.set(`@${file.name}`, { content, isImage })
      setAttachVersion(v => v + 1)
    }
    if (isImage) {
      reader.readAsDataURL(file)
    } else {
      reader.readAsText(file)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', position: 'relative' }}>
      <style>{`
        .build-agent-root {
          --font-xxs: clamp(7px, 0.9vw, 10px);
          --font-xs: clamp(8px, 1vw, 12px);
          --font-sm: clamp(10px, 1.3vw, 14px);
          --font-md: clamp(12px, 1.6vw, 17px);
          --font-lg: clamp(14px, 2vw, 22px);
          --font-xl: clamp(16px, 2.5vw, 28px);
        }
      `}</style>
      <div className="build-agent-root" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', position: 'relative' }}>
      <div style={{ height: 28, WebkitAppRegion: 'drag' as any, background: '#121212', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2, paddingRight: 4 }}>
        <button onClick={() => window.electronAPI?.windowMinimize()}
          style={{ WebkitAppRegion: 'no-drag' as any, border: 'none', background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '2px 6px', borderRadius: 3 }}
          title="Minimize">─</button>
        <button onClick={() => window.electronAPI?.windowClose()}
          style={{ WebkitAppRegion: 'no-drag' as any, border: 'none', background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '2px 6px', borderRadius: 3 }}
          title="Close">✕</button>
      </div>
      <div ref={buildOutputRef} style={{ flex: 1, overflow: 'hidden auto', padding: '4px 0', position: 'relative', maxWidth: 800, margin: '0 auto', width: '100%' }}>
        {showSettings ? (
          <SettingsModal inline onClose={() => setShowSettings(false)} />
        ) : (<>
         {timeline.length === 0 && (
           <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 16px', fontSize: 'var(--font-md)', color: '#555', textAlign: 'center', lineHeight: 1.6 }}>
              <img src={animationGif} alt="animation" draggable={false} style={{ width: 200, height: 200, marginBottom: 12, userSelect: 'none' }} />
             <div style={{ color: '#444', fontSize: 'var(--font-sm)', marginBottom: 8 }}>Bowow By Yasser-27</div>
             <div onClick={handleOpenProject} style={{ cursor: 'pointer', color: '#444', fontWeight: 400, marginBottom: 10, textDecoration: 'underline' }}>
               Click here to open project or type /new
             </div>
           </div>
         )}
        {timeline.map(item => {
          const setItemRef = (el: HTMLDivElement | null) => {
            if (el) itemRefs.current.set(item.id, el); else itemRefs.current.delete(item.id)
          }
          if (item.type === 'file') {
            return (
              <div key={item.id} ref={setItemRef}>
                <div className="build-file-chip" style={{
                  display: 'flex', flexDirection: 'column',
                  margin: '2px 8px', padding: '8px 12px', borderRadius: 6, fontSize: 'var(--font-md)',
                  border: item.status === 'error' ? '1px solid #444' : 'none',
                  background: '#121212',
                  color: '#888',
                }}>
                     <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                       {item.action !== 'run' && (
                         item.status === 'error' ? (
                           <span style={{ color: '#f87171', fontWeight: 'bold', fontSize: 'var(--font-md)' }}>⚠</span>
                         ) : (
                           <SvgIcon name={fileSvgName(item.path || '')} />
                         )
                       )}
                       <span style={{ fontWeight: 500 }}>{item.action === 'run' ? 'Shell Execution' : (item.path || '')}</span>
                       {item.stats && item.stats.added > 0 && (
                         <span style={{
                           background: 'rgba(18, 18, 18, 0.15)', color: '#4caf50',
                           fontWeight: 700, fontSize: 'var(--font-xxs)', padding: '1px 5px', borderRadius: 3,
                           letterSpacing: 0.3,
                         }}>+{item.stats.added}</span>
                       )}
                       {item.stats && item.stats.removed > 0 && (
                         <span style={{
                           background: 'rgba(18, 18, 18, 0.15)', color: '#f44336',
                           fontWeight: 700, fontSize: 'var(--font-xxs)', padding: '1px 5px', borderRadius: 3,
                           letterSpacing: 0.3,
                         }}>-{item.stats.removed}</span>
                       )}
                      {item.tokenCount !== undefined && <span style={{ color: '#444', fontSize: 'var(--font-xs)' }}>({item.tokenCount}t)</span>}
                      {item.status === 'pending' && (!item.stats || item.stats.added === 0) && <span className="thinking-shimmer" style={{ fontSize: 'var(--font-xs)', marginLeft: 2 }}>…</span>}
                    {item.status === 'error' && <span className="thinking-shimmer" style={{ color: '#f87171', fontSize: 'var(--font-sm)' }} title={item.error || ''}>⚠ {item.error}</span>}
                        <button onClick={e => { e.stopPropagation(); toggleCollapse(item.id) }}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#666', fontSize: 'var(--font-sm)', padding: '2px 4px', marginLeft: 'auto', transform: collapsedItems.has(item.id) ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }}>
                         ▶
                       </button>
                  </div>
                  {!collapsedItems.has(item.id) && (<>
                  {item.diffPreview && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', maxHeight: 200, overflow: 'auto' }}>
                      <ColoredDiff diffContent={item.diffPreview} />
                      <button onClick={() => setDiffViewerContent(item.diffPreview ?? null)}
                        style={{ marginTop: 4, border: '1px solid #444', background: '#121212', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '2px 8px', borderRadius: 4, color: '#888' }}>
                        View Full Diff
                      </button>
                    </div>
                  )}

                  {!item.diffPreview && item.toolName === 'run_command' && !!item.content && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a' }}>
                      <ToolResultSummary toolName="run_command" content={String(item.content)} />
                    </div>
                  )}
                  {!item.diffPreview && item.toolName === 'read_file' && !!item.content && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a' }}>
                      <ToolResultSummary toolName="read_file" content={String(item.content)} />
                    </div>
                  )}
                  {!item.diffPreview && item.content && (
                    item.path && /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(item.path) && (
                      <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', paddingTop: 4 }}>
                        <img src={item.content.startsWith('data:') ? item.content : `data:image/${item.path.split('.').pop()?.toLowerCase() === 'svg' ? 'svg+xml' : item.path.split('.').pop()?.toLowerCase() || 'png'};base64,${item.content}`}
                          style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 4, display: 'block' }} />
                      </div>
                    )
                  )}
                  {!item.diffPreview && item.path && /\.(mp3|wav|ogg|aac|flac)$/i.test(item.path) && item.content && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', paddingTop: 4 }}>
                      <audio controls style={{ width: '100%', height: 36 }}
                        src={item.content.startsWith('data:') ? item.content : `data:audio/${item.path.split('.').pop()?.toLowerCase()};base64,${item.content}`} />
                    </div>
                  )}
                  {!item.diffPreview && item.previewContent && item.toolName !== 'run_command' && item.toolName !== 'read_file' && !item.iframeSrcDoc && !/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|mp3|wav|ogg|aac|flac)$/i.test(item.path || '') && (
                    <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', color: '#888', fontSize: 'var(--font-sm)', fontFamily: 'Consolas, monospace', lineHeight: 1.4, maxHeight: 200, overflow: 'auto' }}>{truncateHead(item.previewContent, { maxLines: 200 }).content}</pre>
                  )}
                  {!item.diffPreview && item.iframeSrcDoc && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', paddingTop: 4 }}>
                      <div style={{ border: '1px solid #444', borderRadius: 4, overflow: 'hidden', background: '#fff', height: 180 }}>
                        <iframe srcDoc={item.iframeSrcDoc} sandbox="allow-scripts" style={{ width: '100%', height: '100%', border: 'none' }} />
                      </div>
                    </div>
                  )}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', marginTop: 4, borderTop: '1px solid #2a2a2a', paddingTop: 3, justifyContent: 'flex-end' }}>
                        <button onClick={() => handleSaveFileToPC(item.path || '', item.content)}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#888', fontSize: 'var(--font-sm)', padding: '2px 4px' }}
                          title="Save to PC">Save to PC</button>
                        <button onClick={async () => { await writeClipboardText(item.content || ''); }}
                         style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#666', fontSize: 'var(--font-sm)', padding: '2px 4px' }}
                         title="Copy content">Copy</button>
                        {item.status === 'error' && (
                          <button onClick={handleContinueBuild}
                            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#888', fontSize: 'var(--font-sm)', padding: '2px 4px', fontWeight: 600 }}
                            title="Continue execution">Continue</button>
                        )}
                          <button onClick={() => useAppStore.getState().removeBuildTimelineItem(buildId, item.id)}
                         style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#f44336', fontSize: 'var(--font-sm)', padding: '2px 4px' }}
                         title="Remove step">Delete</button>
                      </div>
                  </>)}
                </div>
              </div>
            )
          }
          return (
            <div key={item.id} ref={setItemRef}>
               {item.type === 'assistant' ? (
                  item.content?.toLowerCase().includes('error:') ? (
                    <div style={{ margin: '4px 8px', padding: '8px 10px', borderRadius: 6, fontSize: 'var(--font-md)', border: '1px solid #f44336', background: '#121212' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button onClick={e => { e.stopPropagation(); toggleCollapse(item.id) }}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#f87171', fontSize: 'var(--font-sm)', padding: 0, transform: collapsedItems.has(item.id) ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }}>
                          ▶
                        </button>
                        <div style={{ color: '#f87171', fontWeight: 600, marginBottom: 4 }}>Error</div>
                      </div>
                      {!collapsedItems.has(item.id) && <div style={{ color: '#c0c0c6', whiteSpace: 'pre-wrap', fontSize: 'var(--font-md)', marginBottom: 8 }}>{item.content}</div>}
                       <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                         <button onClick={() => { navigator.clipboard.writeText(item.content || ''); }}
                           style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#666', fontSize: 'var(--font-sm)', padding: '0 4px' }}>Copy</button>
                         {isRunning || isAutoRetrying ? (
                           <button onClick={handleStop} style={{
                             padding: '3px 10px', fontSize: 'var(--font-sm)', cursor: 'pointer',
                             border: '1px solid #f44336', borderRadius: 4, background: '#2a1010', color: '#f87171',
                           }}>Stop</button>
                         ) : (
                           <button onClick={handleContinueBuild} style={{
                             padding: '3px 10px', fontSize: 'var(--font-sm)', cursor: 'pointer',
                             border: '1px solid #444', borderRadius: 4, background: '#2a2a2a', color: '#e0e0e6',
                           }}>{item.content?.includes('getBuildDirectory') ? 'Continue' : 'Retry'}</button>
                         )}
                       </div>
                      </div>
                    ) : (
                      item.content && (
                        <div style={{ margin: '4px 8px', padding: '8px 10px', borderRadius: 6, fontSize: 'var(--font-md)', lineHeight: 1.5, border: '1px solid #2a2a2a', background: '#121212' }}>
                          <MarkdownContent content={item.content} color="#c0c0c6" />
                        </div>
                      )
                    )
                ) : (
             <div style={{
                     margin: '2px 8px', padding: '8px 10px', borderRadius: 6, fontSize: 'var(--font-md)', lineHeight: 1.5,
                     border: '1px solid #333', background: '#121212', height: 'auto',
                     width: 'fit-content', marginLeft: 'auto',
                   }}>
                     <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                       <button onClick={e => { e.stopPropagation(); toggleCollapse(item.id) }}
                         style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#666', fontSize: 'var(--font-sm)', padding: 0, transform: collapsedItems.has(item.id) ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }}>
                         ▶
                       </button>
                       <span style={{ color: '#888', fontSize: 'var(--font-sm)', fontWeight: 500 }}>{item.type === 'user' ? 'You' : 'Assistant'}</span>
                     </div>
                     {!collapsedItems.has(item.id) && (item.content || item.previewContent) && (<>
                     {item.content?.startsWith('data:image/') ? (
                      <>
                        <img src={item.content} style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 4, display: 'block' }} />
                        {item.previewContent && (
                          <div style={{ marginTop: 6, color: '#888', fontSize: 'var(--font-md)', whiteSpace: 'pre-wrap' }}>{item.previewContent}</div>
                        )}
                      </>
                    ) : item.type === 'user' ? (
                      <div style={{ color: '#e0e0e6', whiteSpace: 'pre-wrap', fontSize: 'var(--font-md)', wordBreak: 'break-word' }}>{item.content}</div>
                    ) : (
                      <MarkdownContent content={item.content || ''} color="#c0c0c6" />
                    )}
                      {item.type === 'user' && (
                     <div style={{ display: 'flex', gap: 8, marginTop: 8, paddingTop: 6, borderTop: '1px solid #2a2a2a' }}>
                       <button onClick={() => writeClipboardText(item.content || '')} style={{ background: 'transparent', border: 'none', color: '#888', fontSize: 'var(--font-sm)', cursor: 'pointer' }}>Copy</button>
                       <button onClick={() => handleRevert(item)} style={{ background: 'transparent', border: 'none', color: '#f44336', fontSize: 'var(--font-sm)', cursor: 'pointer' }}>Revert</button>
                     </div>
                  )}
                  </>)}
                  </div>
              )}
            </div>
          )
        })}

        {isRunning && (
          <div style={{
            margin: '2px 8px', padding: '8px 12px', fontSize: 'var(--font-md)', color: '#888',
            background: '#121212', borderRadius: 6,
          }}>
            <span style={{
              display: 'inline-block', fontWeight: 'bold',
              backgroundImage: 'linear-gradient(90deg, #555, #fff, #555)',
              backgroundSize: '200% 100%', backgroundRepeat: 'no-repeat',
              WebkitBackgroundClip: 'text', backgroundClip: 'text',
              color: 'transparent', animation: 'shimmerBg 1.2s infinite linear',
            }}>
              {isShellRunning ? `Shell${runningCommand ? ': ' + runningCommand : ''}` : 'Thinking'}
            </span>
          </div>
        )}
         {isRunning && userScrolledUp && (
           <button onClick={() => { if (buildOutputRef.current) { buildOutputRef.current.scrollTop = buildOutputRef.current.scrollHeight; setUserScrolledUp(false) } }}
             style={{ position: 'sticky', bottom: 8, left: '50%', transform: 'translateX(-50%)', padding: '4px 14px', fontSize: 'var(--font-sm)', color: '#ccc', background: '#2a2a2a', border: '1px solid #444', borderRadius: 12, cursor: 'pointer', zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}>
             ↓ Scroll to bottom
           </button>
         )}
         {!isRunning && userScrolledUp && timeline.length > 0 && (
           <button onClick={() => { if (buildOutputRef.current) { buildOutputRef.current.scrollTop = buildOutputRef.current.scrollHeight; setUserScrolledUp(false) } }}
             style={{ position: 'sticky', bottom: 8, left: '50%', transform: 'translateX(-50%)', padding: '4px 14px', fontSize: 'var(--font-sm)', color: '#ccc', background: '#2a2a2a', border: '1px solid #444', borderRadius: 12, cursor: 'pointer', zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}>
             ↓ Scroll to bottom
           </button>
         )}
        <div ref={messagesEndRef} />
        </>)}
      </div>

      <style>{`.sd{display:flex;align-items:center;justify-content:center;width:18px;height:18px;cursor:pointer;pointer-events:auto}.sd::after{content:'';display:block;width:6px;height:2px;border-radius:2px;background:var(--sd-bg,#aaa);transition:all .2s ease}.sd:hover::after{width:14px;height:3px;background:#fff}.sd[data-has]{--sd-bg:#22c55e}.sd[data-active]::after{width:10px;height:3px;background:var(--sd-bg,#fff)}*{scrollbar-width:thin;scrollbar-color:#444 transparent}*::-webkit-scrollbar{width:6px;height:6px}*::-webkit-scrollbar-track{background:transparent}*::-webkit-scrollbar-thumb{background:#444;border-radius:3px}*::-webkit-scrollbar-thumb:hover{background:#555}.info-modal{width:380px;max-width:90vw;background:#121212;border:1px solid #2a2a2a;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6)}@keyframes shimmerBg{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
      {/* Scroll indicators — user messages only */}
      {timeline.filter(i => i.type === 'user').length > 1 && (
        <div style={{
          position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)',
          display: 'flex', flexDirection: 'column', gap: 4,
          padding: '6px 2px', pointerEvents: 'none', zIndex: 15,
        }}>
          {timeline.filter(i => i.type === 'user').map(item => {
            const info = userFileMap.get(item.id)
            const hasFiles = info && info.paths.length > 0
            const isActive = activeMsgId === item.id
            // Scroll to first file item when has files, otherwise to user message
            const scrollId = hasFiles && info ? info.fileIds[0] : item.id
            return (
              <div key={item.id} className="sd"
                {...(hasFiles ? { 'data-has': '' } : {})}
                {...(isActive ? { 'data-active': '' } : {})}
                onClick={() => {
                  const container = buildOutputRef.current
                  const el = itemRefs.current.get(scrollId)
                  if (container && el) {
                    const cr = container.getBoundingClientRect()
                    const er = el.getBoundingClientRect()
                    container.scrollTop += er.top - cr.top - cr.height / 2 + er.height / 2
                  }
                }}
                title={hasFiles ? `Navigate to ${info!.paths[0]}` : 'User message'}
              />
            )
          })}
        </div>
      )}

      {confirmingCmd && (
        <div style={{
          margin: '0 8px', padding: '8px 12px', fontSize: 'var(--font-md)',
          background: '#121212', borderRadius: 6, border: '1px solid #333', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', flex: 1 }}>
              <span style={{
                display: 'inline-block', fontWeight: 'bold', flexShrink: 0,
                backgroundImage: 'linear-gradient(90deg, #555, #fff, #555)',
                backgroundSize: '200% 100%', backgroundRepeat: 'no-repeat',
                WebkitBackgroundClip: 'text', backgroundClip: 'text',
                color: 'transparent', animation: 'shimmerBg 1.2s infinite linear',
              }}>Shell</span>
              <span style={{ color: '#ffd700', fontFamily: 'monospace', fontSize: 'var(--font-sm)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{confirmingCmd.command}</span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
              <button onClick={() => setAlwaysApprove(!alwaysApprove)}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '0 4px', color: alwaysApprove ? '#4ade80' : '#666' }}>{alwaysApprove ? 'Always ✓' : 'Always'}</button>
              <button onClick={() => { confirmingCmd.resolve(false); clearPermission() }}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '0 4px', color: '#f44336' }}>Reject</button>
              <button onClick={() => { confirmingCmd.resolve(true); clearPermission() }}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '0 4px', color: '#4ade80' }}>Approve</button>
            </div>
          </div>
        </div>
      )}

        <div style={{
          padding: '8px 10px', borderTop: '1px solid #2a2a2a', background: '#121212', flexShrink: 0,
          maxWidth: 800, margin: '0 auto', width: '100%',
        }}>
          {buildWorkDir && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <span style={{ fontSize: 'var(--font-xs)', color: '#3a3a3a', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{buildWorkDir}</span>
              <button onClick={() => setBuildWorkDir(buildId, null)} style={{ background: 'transparent', border: 'none', color: '#3a3a3a', cursor: 'pointer', fontSize: 'var(--font-xs)', padding: 0, flexShrink: 0 }}>✕</button>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'flex-end' }}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={e => { e.preventDefault(); setDragOver(false) }}
              onDrop={e => {
                e.preventDefault()
                setDragOver(false)
                const file = e.dataTransfer.files?.[0]
                if (file) handleDropFile(file)
              }}>
              {dragOver && (
                <div style={{
                  position: 'absolute', inset: 0, zIndex: 20,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(34,34,34,0.92)', border: '2px dashed #888', borderRadius: 10,
                  fontSize: 'var(--font-lg)', color: '#e0e0e6', fontWeight: 500, pointerEvents: 'none',
                }}>
                  Drop file here
                </div>
              )}
               <>
                 <input ref={fileInputRef} type="file" accept="image/*,.pdf,.txt" style={{ display: 'none' }}
                   onChange={handleFileSelect} />
                 <button onClick={() => fileInputRef.current?.click()}
                   style={{
                     position: 'absolute', left: 4, bottom: 8,
                     width: 24, height: 24, borderRadius: 6, border: 'none',
                     background: 'transparent', color: '#555', cursor: 'pointer',
                     display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1,
                   }}
                   title="Attach file">
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                 </button>
               </>
               <button onClick={handleClear}
                 style={{
                   position: 'absolute', left: 28, bottom: 8,
                   width: 24, height: 24, borderRadius: 6, border: 'none',
                   background: 'transparent', color: '#555', cursor: 'pointer',
                   display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1,
                 }}
                 title="Clear chat">
                 <SvgIcon name="clear" size={12} />
               </button>
               <button onClick={() => setShowSettings(true)}
                 style={{
                   position: 'absolute', left: 54, bottom: 8,
                   width: 24, height: 24, borderRadius: 6, border: 'none',
                   background: 'transparent', color: '#555', cursor: 'pointer',
                   display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1,
                 }}
                 title="API Settings">
                 <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
               </button>
               {apiSettings.connected && apiSettings.availableModels && apiSettings.availableModels.length > 0 && (
                 <div style={{ position: 'absolute', left: 80, bottom: 8 }}>
                   <button onClick={() => setShowModelPicker(p => !p)}
                     style={{
                       height: 24, borderRadius: 6, border: '1px solid #333',
                       background: '#121212', color: '#aaa', cursor: 'pointer',
                       display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px',
                       fontSize: 'var(--font-sm)', fontFamily: 'inherit', whiteSpace: 'nowrap',
                     }}>
                     <span style={{ maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis' }}>{apiSettings.model.split('/').pop()}</span>
                     <span style={{ fontSize: 'var(--font-xxs)' }}>▼</span>
                   </button>
                   {showModelPicker && (
                     <>
                       <div onClick={() => setShowModelPicker(false)}
                         style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
                       <div style={{
                         position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
                         background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
                         maxHeight: 200, overflow: 'auto', zIndex: 1000, minWidth: 140,
                       }}>
                         {apiSettings.availableModels.map(m => (
                           <div key={m} onClick={() => { setApiModel(m); setShowModelPicker(false) }}
                             style={{
                               padding: '6px 10px', fontSize: 'var(--font-md)', cursor: 'pointer', color: m === apiSettings.model ? '#fff' : '#aaa',
                               background: m === apiSettings.model ? '#333' : 'transparent',
                               borderBottom: '1px solid #2a2a2a',
                             }}
                             onMouseEnter={e => { if (m !== apiSettings.model) (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
                             onMouseLeave={e => { if (m !== apiSettings.model) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                             {m}
                           </div>
                         ))}
                       </div>
                     </>
                   )}
                 </div>
               )}
              <textarea ref={textareaRef} value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                rows={1}
                placeholder={buildWorkDir ? 'Describe what to build in ' + buildWorkDir.split(/[\\/]/).pop() + '…' : 'Ask anything... '}
                style={{
                  flex: 1, width: '100%', background: '#121212', border: '1px solid #333', borderRadius: 10, color: '#e0e0e6',
                   fontSize: 'var(--font-md)', padding: '10px 42px 10px 20px', minHeight: 110, outline: 'none', resize: 'none', fontFamily: 'inherit',
                   lineHeight: 1.9, boxSizing: 'border-box', textAlign: 'left' as const,
                }}
              />
              {attachmentsRef.current.size > 0 && attachVersion >= 0 && (
                <div style={{
                  position: 'absolute', bottom: '100%', left: 4, marginBottom: 4,
                  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, zIndex: 1,
                }}>
                  {Array.from(attachmentsRef.current.keys()).map(marker => (
                    <span key={marker} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 'var(--font-sm)', color: '#ccc', background: '#121212',
                      border: '1px solid #444', borderRadius: 4, padding: '2px 6px',
                    }}>
                      {marker.slice(1)}
                      <span onClick={() => {
                        attachmentsRef.current.delete(marker)
                        setAttachVersion(v => v + 1)
                      }}
                        style={{ cursor: 'pointer', color: '#888', fontSize: 'var(--font-md)', lineHeight: 1, marginLeft: 2 }}>×</span>
                    </span>
                  ))}
                </div>
              )}
              {isRunning ? (
                <button onClick={handleStop} title="Stop"
                  style={{
                    position: 'absolute', right: 8, bottom: 8,
                    width: 30, height: 30, borderRadius: 6, border: 'none',
                    background: '#3a3a3a', color: '#f87171', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
                </button>
              ) : (
                <button onClick={handleBuild} disabled={!input.trim() && attachmentsRef.current.size === 0} title="Send"
                  style={{
                    position: 'absolute', right: 8, bottom: 8,
                    width: 30, height: 30, borderRadius: 6, border: 'none',
                    background: input.trim() || attachmentsRef.current.size > 0 ? '#444' : '#333',
                    color: input.trim() || attachmentsRef.current.size > 0 ? '#fff' : '#fff', cursor: input.trim() || attachmentsRef.current.size > 0 ? 'pointer' : 'default',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    transition: 'background 0.15s',
                  }}>
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      {diffViewerContent && (
        <DiffViewer diffContent={diffViewerContent} onClose={() => setDiffViewerContent(null)} />
      )}
      {showInfo && (
        <div className="import-overlay" onClick={() => setShowInfo(false)}>
          <div className="info-modal" onClick={e => e.stopPropagation()}>
            <div className="import-header">
              <h2 className="import-title">About</h2>
              <button className="import-close" onClick={() => setShowInfo(false)}>✕</button>
            </div>
            <div className="import-body" style={{ alignItems: 'center', textAlign: 'center', gap: 16 }}>
              <img src={yasserPic} alt="Yasser" draggable={false}
                style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', border: '2px solid #888' }} />
              <div>
                <div style={{ fontWeight: 700, color: '#888', fontSize: 'var(--font-lg)', marginBottom: 4 }}>Bowow Beta</div>
                <div style={{ fontSize: 'var(--font-sm)', color: '#888', lineHeight: 1.6 }}>
                   creates and edits files automatically.
                </div>
              </div>
              <div style={{ fontSize: 'var(--font-sm)', color: '#666', lineHeight: 1.6 }}>
                Built by <a href="https://github.com/YASSER-27" target="_blank" rel="noopener noreferrer"
                  style={{ color: '#999', textDecoration: 'none' }}>YASSER-27</a>
              </div>
              <div style={{ fontSize: 'var(--font-xs)', color: '#555' }}>
                Sponsor this project
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  )
}