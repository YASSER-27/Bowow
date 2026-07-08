import { useState, useRef, useCallback, useEffect, useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import JSZip from 'jszip'
import { useAppStore, buildAbortControllers, loadSavedConversation, loadAllSavedConversations } from '../store'
import type { BuildFile, BuildFileEvent, BuildToolCall, BuildTimelineItem } from '../types'
import { BuildError, BuildErrorReason } from '../types'
import { SvgIcon, fileSvgName } from '../data/svg/icons'
import { parse as incrementalParseJson } from 'partial-json'
import { diffLines, diffArrays, type Change } from 'diff'
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
import { executeTask } from '../tool/task'
import { registerBuiltins, toolRegistry } from '../tool/builtins'
import { assert, reply as permissionReply, listPending, type PermissionRequest } from '../permission/permission'
import { applyConfig } from '../config/config'
import { publishTimelineEvent, SessionEvents, subscribe, type EventPayload } from '../event/event'
import { FileSystem } from '../filesystem/filesystem'
import { FileMutation } from '../filesystem/file-mutation'
import { init as formatInit, formatFile } from '../format/format'
import { init as snapshotInit, track as snapshotTrack } from '../snapshot/snapshot'
import { defaultMCPServerManager, MCPServerConfig } from '../mcp/mcp'
import { startServer as lspStartServer, getServerForFile, stopAll as lspStopAll } from '../lsp/lsp'
import { execCommand as ptyExec, create as ptyCreate } from '../pty/pty'
import { defaultSkillManager } from '../skill/skill'
import { defaultTodoManager } from '../session/todo'
import { SessionManager } from '../session/index'
import { ACPClient } from '../acp/acp'
import { estimate as tokenEstimate } from '../util/token'
import { streamLLM } from '../provider/llm-client'
import { parse as patchParse, type Hunk } from '../patch/patch'
import { grep as rgGrep, glob as rgGlob } from '../ripgrep/ripgrep'

function isRTL(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)
}

function processInline(text: string, parts: { type: string; content: string }[]): void {
  // Split into lines to handle block-level elements
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) { parts.push({ type: 'text', content: '\n' }); continue }
    
    // Headers: ## or ###
    const headerMatch = trimmed.match(/^(#{1,3})\s+(.+)/)
    if (headerMatch) {
      parts.push({ type: 'header', content: headerMatch[2] })
      if (line !== trimmed) parts.push({ type: 'text', content: '\n' }) // preserve trailing newline
      continue
    }
    
    // Bullet lists: - or *
    if (/^[-*]\s+/.test(trimmed)) {
      parts.push({ type: 'bullet', content: trimmed.replace(/^[-*]\s+/, '') })
      continue
    }
    
    // Ordered lists: 1. 2. etc
    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)/)
    if (orderedMatch) {
      parts.push({ type: 'ordered', content: orderedMatch[1] })
      continue
    }
    
    // Inline formatting: **bold** and *italic*
    let remaining = line
    const inlineParts: { bold?: string; italic?: string; text: string }[] = []
    const inlineRegex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g
    let m, last = 0
    while ((m = inlineRegex.exec(remaining)) !== null) {
      if (m.index > last) inlineParts.push({ text: remaining.slice(last, m.index) })
      if (m[2]) inlineParts.push({ bold: m[2] })
      else if (m[3]) inlineParts.push({ italic: m[3] })
      last = m.index + m[0].length
    }
    if (last < remaining.length) inlineParts.push({ text: remaining.slice(last) })
    
    for (const ip of inlineParts) {
      if (ip.bold) parts.push({ type: 'bold', content: ip.bold })
      else if (ip.italic) parts.push({ type: 'italic', content: ip.italic })
      else if (ip.text) parts.push({ type: 'text', content: ip.text })
    }
    parts.push({ type: 'text', content: '\n' })
  }
  // Remove trailing newline if added
  if (parts.length > 0 && parts[parts.length - 1].content === '\n') parts.pop()
}

const MarkdownContent = memo(({ content, color }: { content: string; color: string }) => {
  const cleaned = content.replace(/<\/?plan>/gi, '').trim()
  if (!cleaned) return null

  return (
    <div style={{ color: '#ccc', lineHeight: 1.7, fontSize: '13.5px', wordBreak: 'break-word', overflowWrap: 'anywhere', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <ReactMarkdown
        components={{
          p: ({ node, ...props }) => <div style={{ margin: '8px 0' }} {...props} />,
          h1: ({ node, ...props }) => <div style={{ fontWeight: 700, fontSize: '1.2rem', margin: '16px 0 6px', color: '#ddd', borderBottom: '1px solid #333', paddingBottom: '4px' }} {...props} />,
          h3: ({ node, ...props }) => <div style={{ fontWeight: 600, fontSize: '1rem', margin: '12px 0 4px', color: '#bbb' }} {...props} />,
          ul: ({ node, ...props }) => <ul style={{ paddingLeft: 20, margin: '6px 0', listStyleType: 'disc', gap: '4px', display: 'flex', flexDirection: 'column' }} {...props} />,
          ol: ({ node, ...props }) => <ol style={{ paddingLeft: 20, margin: '6px 0', listStyleType: 'decimal', gap: '4px', display: 'flex', flexDirection: 'column' }} {...props} />,
          li: ({ node, ...props }) => <li style={{ margin: '1px 0', color: '#bbb' }} {...props} />,
          code: ({ node, inline, ...props }) => {
            if (inline) {
              return <code style={{ background: '#222', color: '#bbb', borderRadius: 4, padding: '2px 6px', fontSize: '12px', fontFamily: 'Consolas, Menlo, monospace', border: '1px solid #333' }} {...props} />
            }
            return (
              <pre style={{ background: '#1a1a1a', color: '#ccc', borderRadius: 6, padding: 14, margin: '10px 0', fontSize: '12.5px', overflow: 'auto', lineHeight: 1.5, fontFamily: 'Consolas, Menlo, monospace', border: '1px solid #2e2e2e' }}>
                <code {...props} />
              </pre>
            )
          },
          blockquote: ({ node, ...props }) => <blockquote style={{ borderLeft: '3px solid #444', margin: '8px 0', paddingLeft: 12, color: '#888', fontStyle: 'italic' }} {...props} />,
          strong: ({ node, ...props }) => <strong style={{ fontWeight: 700, color: '#ddd' }} {...props} />,
          em: ({ node, ...props }) => <em style={{ fontStyle: 'italic', color: '#aaa' }} {...props} />,
          a: ({ node, ...props }) => <a style={{ color: '#888', textDecoration: 'underline' }} {...props} />,
          hr: ({ node, ...props }) => <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '12px 0' }} {...props} />,
        }}
      >
        {cleaned}
      </ReactMarkdown>
    </div>
  )
})

// Register built-in tools at module level
registerBuiltins()

// Tool definitions — generated from registry with fallback for tools not yet registered
function getToolDefs() {
  const registryDefs = toolRegistry.toToolDefs()
  const registryNames = new Set(registryDefs.map(d => d.function.name))
  const fallback: Record<string, any> = {
    ls: { type: 'function', function: { name: 'ls', description: 'List files and directories inside a project directory path.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path, e.g. src/' } }, required: ['path'] } } },
    semantic_search: { type: 'function', function: { name: 'semantic_search', description: 'Search for relevant files based on semantic meaning and project dependencies.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query, e.g. "auth logic" or "navigation component"' } }, required: ['query'] } } },
    create_zip: { type: 'function', function: { name: 'create_zip', description: 'Compress all current project files into a .zip archive for download.', parameters: { type: 'object', properties: { fileName: { type: 'string', description: 'Name of the zip file, e.g. project.zip' } }, required: ['fileName'] } } },
    generate_project_map: { type: 'function', function: { name: 'generate_project_map', description: 'Scan the project files and generate a project_map.json file.', parameters: { type: 'object', properties: {}, required: [] } } },
    git_status: { type: 'function', function: { name: 'git_status', description: 'Show git status — modified, untracked, staged files.', parameters: { type: 'object', properties: {}, required: [] } } },
    git_diff: { type: 'function', function: { name: 'git_diff', description: 'Show git diff — uncommitted changes.', parameters: { type: 'object', properties: {}, required: [] } } },
    git_log: { type: 'function', function: { name: 'git_log', description: 'Show recent git commit history (last 10).', parameters: { type: 'object', properties: {}, required: [] } } },
    git_commit: { type: 'function', function: { name: 'git_commit', description: 'Stage all changes and commit with a given message.', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Commit message' } }, required: ['message'] } } },
    generate_image: { type: 'function', function: { name: 'generate_image', description: 'Generate an image based on a prompt.', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } } },
    edit_image: { type: 'function', function: { name: 'edit_image', description: 'Edit an existing image based on a prompt.', parameters: { type: 'object', properties: { prompt: { type: 'string' }, imageBase64: { type: 'string' } }, required: ['prompt'] } } },
    mcp_list_servers: { type: 'function', function: { name: 'mcp_list_servers', description: 'List all connected MCP servers.', parameters: { type: 'object', properties: {}, required: [] } } },
    mcp_add_server: { type: 'function', function: { name: 'mcp_add_server', description: 'Add and connect a new MCP server.', parameters: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, args: { type: 'string' }, url: { type: 'string' } }, required: ['name'] } } },
    mcp_remove_server: { type: 'function', function: { name: 'mcp_remove_server', description: 'Disconnect and remove an MCP server.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    mcp_list_server_tools: { type: 'function', function: { name: 'mcp_list_server_tools', description: 'List tools on a specific MCP server.', parameters: { type: 'object', properties: { server: { type: 'string' } }, required: [] } } },
    mcp_call_tool: { type: 'function', function: { name: 'mcp_call_tool', description: 'Call a tool on an MCP server.', parameters: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' } }, required: ['server', 'tool'] } } },
    mcp_list_resources: { type: 'function', function: { name: 'mcp_list_resources', description: 'List resources on an MCP server.', parameters: { type: 'object', properties: { server: { type: 'string' } }, required: [] } } },
    lsp_go_to_definition: { type: 'function', function: { name: 'lsp_go_to_definition', description: 'Go to the definition of a symbol at a specific file location.', parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['path', 'line', 'character'] } } },
    lsp_find_references: { type: 'function', function: { name: 'lsp_find_references', description: 'Find all references to a symbol at a specific file location.', parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['path', 'line', 'character'] } } },
    lsp_hover: { type: 'function', function: { name: 'lsp_hover', description: 'Get hover information for a symbol at a specific file location.', parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['path', 'line', 'character'] } } },
    lsp_document_symbols: { type: 'function', function: { name: 'lsp_document_symbols', description: 'List all symbols in a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    pty_exec: { type: 'function', function: { name: 'pty_exec', description: 'Execute a command in a pseudo-terminal.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] } } },
    list_skills: { type: 'function', function: { name: 'list_skills', description: 'List available skill guides discovered in the project.', parameters: { type: 'object', properties: {}, required: [] } } },
    todo_add: { type: 'function', function: { name: 'todo_add', description: 'Add a todo item to the current task list.', parameters: { type: 'object', properties: { content: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['content'] } } },
    todo_list: { type: 'function', function: { name: 'todo_list', description: 'List all todo items for the current session.', parameters: { type: 'object', properties: {}, required: [] } } },
    todo_mark_done: { type: 'function', function: { name: 'todo_mark_done', description: 'Mark a todo item as done.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    acp_connect: { type: 'function', function: { name: 'acp_connect', description: 'Connect to a remote agent via ACP.', parameters: { type: 'object', properties: { url: { type: 'string' }, token: { type: 'string' } }, required: ['url'] } } },
    acp_prompt: { type: 'function', function: { name: 'acp_prompt', description: 'Send a prompt to a connected ACP agent session.', parameters: { type: 'object', properties: { session_id: { type: 'string' }, message: { type: 'string' }, model: { type: 'string' } }, required: ['message'] } } },
    patch_apply: { type: 'function', function: { name: 'patch_apply', description: 'Apply a structured patch using Begin Patch / End Patch format.', parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] } } },
  }
  const fallbackDefs = Object.values(fallback).filter(d => !registryNames.has(d.function.name))
  return [...registryDefs, ...fallbackDefs]
}
const TOOL_DEFS = getToolDefs()

function buildSystemPrompt(provider: string, customPrompt?: string): string {
  const base = `You are a coding agent. Your job is to use tools to complete tasks. You have 30+ tools available.

CRITICAL RULES:
1. STRICT CHATTER SILENCE: NEVER explain what you are about to do. Do NOT write plans, explanations, apologies, intro phrases, or transitional text.
2. If you need to read a file, call read_file. If you need to edit, call edit_file. Do NOT say "I will now read..." or "May I proceed with this change?". Just output the tool call.
3. NEVER repeat claims or send generic update messages. Once a task is done, write exactly 1 concise sentence summarizing what changed.
4. For greetings or questions: answer in exactly one short sentence. No boilerplate.
5. DO NOT narrate. Output only tool calls. Minimize all text to absolute zero if possible.

WORKFLOW RULES:
- For tasks that require 3+ files or complex changes: Before starting, output a SHORT numbered plan (max 5 items), then immediately begin executing.
- For simple single-file changes: skip the plan, just do it.
- After modifying Python (.py) files: always run: python -m py_compile <filename> to verify syntax.
- After modifying JS/TS files: if node is available, run: node --check <filename>
- After modifying HTML files: verify opening/closing tag integrity.
- After ALL work: write 1 concise sentence summary (what was done, nothing else).

TOOL USAGE RULES:
- Always read a file (or part of it) using read_file before editing it.
- Files might be very large. The read_file tool supports start_line and end_line. Only read the relevant segment or first 100 lines at a time.
- Before modifying or overwriting any file, you must obtain permission first. Keep the permission request to exactly 1 short sentence stating what you will edit.
- Avoid commands that destroy or delete project files unless explicitly asked. Check files first.

For Windows: Use 'dir', 'type', 'python', 'node'. Paths use forward slashes (/).`

  const customNote = customPrompt ? `\n\nUSER INSTRUCTIONS:\n${customPrompt}` : ''

  const jsonFallbackNote = (provider === 'llama' || provider === 'ollama')
    ? `\n\nOUTPUT FORMAT (one tool call per response):\n{"name":"create_file","args":{"path":"src/index.html","content":"<h1>Hello</h1>"}}`
    : ''

  const taskNote = `\n\nSUB-AGENTS (task tool):
You have a 'task' tool to delegate work to sub-agents. Use it for:
- Complex multi-step research that can run in parallel
- Exploring large codebases when you need focused analysis
- Tasks that require specialized handling (e.g., security audit, dependency analysis)

Available sub-agent types:
- explore: Fast codebase exploration (search, read files, answer code questions)
- general: Multi-step research and complex tasks

Usage: task description="3-5 word summary" prompt="Detailed task instructions" subagent_type="explore"
For parallel work, call task multiple times in the same response (max 3 concurrent).`

  return base + customNote + jsonFallbackNote + taskNote
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
// - Before modifying an existing file (create_file with existing path or edit_file), FIRST ask the user for permission by stating what you want to change and why, then wait for approval before proceeding
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

// ── Helpers ──

function wrapContent(content: string, ext: string, path: string): string {
  return `<!DOCTYPE html><html><head><style>
body{margin:0;background:#121212;color:#e0e0e6;font-family:'CustomEnglish', 'CustomArabic', 'Consolas', 'Courier New', monospace;font-size:12px;padding:12px;white-space:pre-wrap;word-break:break-word;overflow:auto;height:100vh;box-sizing:border-box;}
.fn{position:sticky;top:0;background:#121212;padding:4px 0 8px;font-size:10px;color:#666;border-bottom:1px solid #2e2e2e;margin-bottom:8px;}
@font-face { font-family: 'CustomArabic'; src: url('/font/AR.otf'); }
@font-face { font-family: 'CustomEnglish'; src: url('/font/EN.otf'); }
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
  const buildData = useAppStore(s => s.builds[buildId])
  const activeBuild = useAppStore(s => s.activeBuild)
  const buildProjectFiles = buildData?.projectFiles ?? []
  const timeline = buildData?.timeline ?? []
  const addBuildFile = useAppStore(s => s.addBuildFile)
  const updateBuildFile = useAppStore(s => s.updateBuildFile)
  const setBuildIsRunning = useAppStore(s => s.setBuildIsRunning)
  const addCanvasElement = useAppStore(s => s.addCanvasElement)
  const updateCanvasElement = useAppStore(s => s.updateCanvasElement)
  const addConnection = useAppStore(s => s.addConnection)
  const setBuildEditingPaths = useAppStore(s => s.setBuildEditingPaths)
  const globalApiSettings = useAppStore(s => s.apiSettings)
  const [localModel, setLocalModel] = useState<string | undefined>(undefined)
  const [localEffort, setLocalEffort] = useState<string | undefined>(undefined)
  const apiSettings = useMemo(() => ({
    ...globalApiSettings,
    model: localModel ?? globalApiSettings.model,
    thinkingEffort: localEffort ?? globalApiSettings.thinkingEffort,
  }), [globalApiSettings, localModel, localEffort])
  const buildWorkDir = useAppStore(s => s.builds[buildId]?.workDir ?? null)
  const setBuildWorkDir = useAppStore(s => s.setBuildWorkDir)
  const userPrompts = useAppStore(s => s.userPrompts)
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
  const userTimeline = useMemo(() => timeline.filter(i => i.type === 'user'), [timeline])
  const addTimelineItem = useCallback((id: number, item: BuildTimelineItem) => {
    useAppStore.getState().addBuildTimelineItem(id, item)
    publishTimelineEvent(id, SessionEvents.MessageAdded, { type: item.type, id: item.id, path: item.path })
  }, [])
  const updateTimelineItem = useCallback((id: number, itemId: string, updates: Partial<BuildTimelineItem>) => {
    useAppStore.getState().updateBuildTimelineItem(id, itemId, updates)
  }, [])
  const removeTimelineItem = useCallback((id: number, itemId: string) => {
    useAppStore.getState().removeBuildTimelineItem(id, itemId)
  }, [])
  const clearTimeline = useAppStore(s => s.clearBuildTimeline)
  const saveImport = useAppStore(s => s.saveImport)
  const updateApiSettings = useAppStore(s => s.updateApiSettings)

  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [isAutoRetrying, setIsAutoRetrying] = useState(false)
  const [isShellRunning, setIsShellRunning] = useState(false)
  const [runningCommand, setRunningCommand] = useState('')
  const [currentAction, setCurrentAction] = useState<string>('')
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
  const [fullImage, setFullImage] = useState<string | null>(null)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [expandedItems, setCollapsedItems] = useState<Set<string>>(new Set())
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

  // ── Register built-in tools on mount (once) ──
  const toolsRegistered = useRef(false)
  if (!toolsRegistered.current) {
    toolsRegistered.current = true
  }

  // ── Permission request state ──
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const pendingPermRef = useRef<PermissionRequest | null>(null)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as PermissionRequest
      if (detail.sessionID !== String(buildId)) return
      pendingPermRef.current = detail
      setPendingPermission(detail)
    }
    window.addEventListener('permission-request', handler)
    return () => window.removeEventListener('permission-request', handler)
  }, [buildId])

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

  /** Scan real filesystem and sync file paths into store (no content) */
  const syncFromDisk = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const store = useAppStore.getState()
      const workDir = store.builds[buildId]?.workDir
      const buildDir = (workDir || await window.electronAPI.getBuildDirectory()).replace(/\\/g, '/')
      const files = await window.electronAPI.readDirRecursive(buildDir)
      const relPaths: string[] = []
      for (const rawPath of files) {
        const normalized = rawPath.replace(/\\/g, '/')
        const relPath = normalized.startsWith(buildDir + '/')
          ? normalized.slice(buildDir.length + 1)
          : normalized
        if (!relPath) continue
        relPaths.push(relPath)
      }
      useAppStore.getState().syncBuildFileListing(buildId, relPaths)
    } catch (e) {
      console.debug('[BuildAgent] syncFromDisk:', e)
    }
  }, [buildId])

  const execTool = useCallback(async (tc: BuildToolCall): Promise<BuildFileEvent> => {
    try {
    tc.arguments = tc.arguments || {}
    const path = tc.arguments.path || ''

    // ── Schema validation: ensure required arguments are present ──
    const toolDef = TOOL_DEFS.find(d => d.function.name === tc.name)
    if (toolDef) {
      const required = toolDef.function.parameters.required || []
      for (const key of required) {
        if (tc.arguments[key] === undefined || tc.arguments[key] === null || tc.arguments[key] === '') {
          return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `Missing required argument: ${key}` }
        }
      }
    }

    // ── Try tool registry for registered tools first ──
    {
      const store = useAppStore.getState()
      if (tc.name === 'run_command') {
        const cmd = tc.arguments.command || ''
        setIsShellRunning(true)
        setRunningCommand(cmd)
      }
      const materialization = toolRegistry.materialize()
      const knownTool = materialization.definitions.find(d => d.name === tc.name)
      if (knownTool) {
        const actionLabel = tc.name === 'create_file' ? 'Creating file: ' + path : tc.name === 'edit_file' ? 'Editing file: ' + path : tc.name === 'read_file' ? 'Reading file: ' + path : tc.name === 'run_command' ? 'Running command: ' + (tc.arguments.command || '') : 'Executing ' + tc.name;
        setCurrentAction(actionLabel)
        if (tc.name === 'create_file' || tc.name === 'edit_file') {
          const existingFile = useAppStore.getState().builds[buildId]?.projectFiles.find(f => f.path === path)
          if (existingFile) {
            let oldContent = existingFile.content || ''
            if (!existingFile.contentLoaded) oldContent = await useAppStore.getState().loadBuildFileContent(buildId, path)
            saveCheckpoint(buildId, path, oldContent)
            const _store = useAppStore.getState()
            const wd = _store.builds[buildId]?.workDir
            if (wd) { try { snapshotInit(wd); snapshotTrack(wd) } catch {} }
          }
        }
        const result = await materialization.settle({
          sessionID: String(buildId),
          agent: 'default',
          assistantMessageID: 'msg_' + (tc.id || Date.now()),
          call: { id: tc.id || String(Date.now()), name: tc.name, input: tc.arguments },
          context: { buildId, apiSettings: store.apiSettings },
        })
        setCurrentAction('')
        setIsShellRunning(false)
          if (result.result.type === 'success' && (tc.arguments.command || '').includes('error')) {
            const autoFixMsg = `The command '${tc.arguments.command}' failed. Please analyze the files involved and fix the issue immediately.`
            conversationRef.current.push({ role: 'user', content: autoFixMsg })
          }
        if (result.result.type === 'success') {
          const action =
            tc.name === 'create_file' ? 'create' :
            tc.name === 'edit_file' ? 'edit' :
            tc.name === 'run_command' ? 'run' :
            tc.name === 'read_file' ? 'read' : 'read'
          const stats = tc.name === 'create_file' ? { added: (tc.arguments.content || '').split('\n').filter(Boolean).length, removed: 0 } :
                        tc.name === 'edit_file' ? { added: (tc.arguments.new_str || '').split('\n').length, removed: (tc.arguments.old_str || '').split('\n').length } :
                        { added: 0, removed: 0 }
          return {
            action, path: path || '/', stats,
            status: 'success',
            content: typeof result.result.value === 'string' ? result.result.value : JSON.stringify(result.result.value),
          }
        }
        return {
          action: 'read', path: path || '/', stats: { added: 0, removed: 0 },
          status: 'error', error: String(result.result.value),
        }
      }
      if (tc.name === 'run_command') {
        setIsShellRunning(false)
        setRunningCommand('')
      }
    }

    // ── mcp: Model Context Protocol ──
    if (tc.name.startsWith('mcp_')) {
      const mcp = defaultMCPServerManager
      if (tc.name === 'mcp_list_servers') {
        const servers = mcp.list()
        return {
          action: 'read', path: '/', stats: { added: 0, removed: 0 },
          status: 'success',
          content: servers.length === 0 ? 'No MCP servers connected.' : servers.map(s => `- ${s.name}`).join('\n'),
        }
      }
      if (tc.name === 'mcp_add_server') {
        const config: MCPServerConfig = { name: tc.arguments.name }
        if (tc.arguments.command) { config.command = tc.arguments.command; config.args = (tc.arguments.args || '').split(/\s+/).filter(Boolean) }
        if (tc.arguments.url) config.url = tc.arguments.url
        const client = mcp.add(config)
        try {
          await client.connect()
          return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: `Connected MCP server: ${client.name}` }
        } catch (e: any) {
          return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `MCP connect failed: ${e.message}` }
        }
      }
      if (tc.name === 'mcp_remove_server') {
        mcp.remove(tc.arguments.name)
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: `Removed MCP server: ${tc.arguments.name}` }
      }
      if (tc.name === 'mcp_list_server_tools') {
        const serverName = tc.arguments.server
        const clients = serverName ? [mcp.get(serverName)].filter(Boolean) : mcp.list()
        if (clients.length === 0) return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: 'No tools found.' }
        const lines: string[] = []
        for (const client of clients) {
          for (const tool of client!.getTools()) {
            lines.push(`[${client!.name}] ${tool.name}: ${tool.description}`)
          }
        }
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: lines.join('\n') || 'No tools found.' }
      }
      if (tc.name === 'mcp_call_tool') {
        const client = mcp.get(tc.arguments.server)
        if (!client) return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `MCP server not found: ${tc.arguments.server}` }
        try {
          const result = await client.callTool(tc.arguments.tool, tc.arguments.args || {})
          return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
        } catch (e: any) {
          return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `MCP tool call failed: ${e.message}` }
        }
      }
      if (tc.name === 'mcp_list_resources') {
        const serverName = tc.arguments.server
        const clients = serverName ? [mcp.get(serverName)].filter(Boolean) : mcp.list()
        const lines: string[] = []
        for (const client of clients) {
          for (const resource of client!.getResources()) {
            lines.push(`[${client!.name}] ${resource.uri} — ${resource.name || resource.description || ''}`)
          }
        }
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: lines.join('\n') || 'No resources found.' }
      }
    }

    // ── lsp: Language Server Protocol ──
    if (tc.name.startsWith('lsp_')) {
      const store = useAppStore.getState()
      const workDir = store.builds[buildId]?.workDir || ''
      if (!workDir) return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: 'No working directory set' }
      try {
        if (tc.name === 'lsp_go_to_definition' || tc.name === 'lsp_find_references' || tc.name === 'lsp_hover' || tc.name === 'lsp_document_symbols') {
          const filePath = tc.arguments.path
          const config = getServerForFile(filePath)
          if (!config) return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `No LSP server configured for file type: ${filePath}` }
          const client = await lspStartServer(config, 'file://' + workDir.replace(/\\/g, '/'))
          const fileUri = 'file:///' + workDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + filePath.replace(/^\/+/, '').replace(/\\/g, '/')
          try {
            const storeFs = useAppStore.getState().builds[buildId]?.projectFiles?.find(f => f.path === filePath)
            if (storeFs) await client.openDocument(fileUri, config.language, storeFs.content)
          } catch {}
          if (tc.name === 'lsp_go_to_definition') {
            const loc = await client.goToDefinition(fileUri, tc.arguments.line, tc.arguments.character)
            return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: loc ? `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}` : 'No definition found.' }
          }
          if (tc.name === 'lsp_find_references') {
            const refs = await client.findReferences(fileUri, tc.arguments.line, tc.arguments.character)
            return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: refs.length === 0 ? 'No references found.' : refs.map(r => `${r.uri}:${r.range.start.line}:${r.range.start.character}`).join('\n') }
          }
          if (tc.name === 'lsp_hover') {
            const hov = await client.hover(fileUri, tc.arguments.line, tc.arguments.character)
            return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: hov?.contents || 'No hover information.' }
          }
          if (tc.name === 'lsp_document_symbols') {
            const syms = await client.documentSymbols(fileUri)
            return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: syms.length === 0 ? 'No symbols found.' : syms.map(s => `${s.kind}: ${s.name}${s.range ? ` (${s.range.start.line}:${s.range.start.character})` : ''}`).join('\n') }
          }
        }
      } catch (e: any) {
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `LSP error: ${e.message}` }
      }
    }

    // ── pty: Pseudo-terminal execution ──
    if (tc.name === 'pty_exec') {
      const store = useAppStore.getState()
      const workDir = store.builds[buildId]?.workDir || tc.arguments.cwd
      const signal = new AbortController()
      try {
        const result = await ptyExec(tc.arguments.command, { cwd: workDir, timeout: tc.arguments.timeout, signal: signal.signal })
        return {
          action: 'read', path: '/', stats: { added: 0, removed: 0 },
          status: result.code === 0 ? 'success' : 'error',
          content: `Exit code: ${result.code}\n${result.stdout}${result.stderr ? '\nSTDERR:\n' + result.stderr : ''}`,
        }
      } catch (e: any) {
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `PTY error: ${e.message}` }
      }
    }

    // ── list_skills: Show discovered skills ──
    if (tc.name === 'list_skills') {
      const skills = defaultSkillManager.list()
      return {
        action: 'read', path: '/', stats: { added: 0, removed: 0 },
        status: 'success',
        content: skills.length === 0 ? 'No skills discovered.' : skills.map(s => `- ${s.name}${s.description ? ': ' + s.description : ''}`).join('\n'),
      }
    }

    // ── todo: Session task tracking ──
    if (tc.name.startsWith('todo_')) {
      const sessionId = String(buildId)
      const todo = defaultTodoManager
      if (tc.name === 'todo_add') {
        todo.add(sessionId, tc.arguments.content, tc.arguments.priority || 'medium')
        const pending = todo.pendingCount(sessionId)
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: `Added: ${tc.arguments.content}. Pending: ${pending}` }
      }
      if (tc.name === 'todo_list') {
        const items = todo.get(sessionId)
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: items.length === 0 ? 'No todos.' : items.map(i => `[${i.status}] ${i.id}: ${i.content} (${i.priority})`).join('\n') }
      }
      if (tc.name === 'todo_mark_done') {
        todo.markDone(sessionId, tc.arguments.id)
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: `Done: ${tc.arguments.id}` }
      }
    }

    // ── acp: Agent-to-Agent Communication ──
    if (tc.name.startsWith('acp_')) {
      if (tc.name === 'acp_connect') {
        const client = new ACPClient(tc.arguments.url)
        try {
          await client.initialize()
          if (tc.arguments.token) await client.authenticate('token', { token: tc.arguments.token })
          return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: `Connected to ACP agent at ${tc.arguments.url}` }
        } catch (e: any) {
          return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `ACP connect failed: ${e.message}` }
        }
      }
      if (tc.name === 'acp_prompt') {
        const url = useAppStore.getState().apiSettings.baseUrl
        if (!url) return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: 'No API URL configured for ACP' }
        const client = new ACPClient(url)
        try {
          await client.initialize()
          let sessionId = tc.arguments.session_id
          if (!sessionId) {
            const sess = await client.newSession({ model: tc.arguments.model })
            sessionId = sess.id
          }
          const resp = await client.prompt({ sessionId, message: tc.arguments.message })
          return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: resp.text }
        } catch (e: any) {
          return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `ACP prompt failed: ${e.message}` }
        }
      }
    }

    // ── patch_apply: Apply structured patch ──
    if (tc.name === 'patch_apply') {
      try {
        const hunks = patchParse(tc.arguments.patch)
        const results: string[] = []
        for (const hunk of hunks) {
          if (hunk.type === 'add') {
            const store = useAppStore.getState()
            store.addBuildFile(buildId, { path: hunk.path, content: hunk.contents })
            results.push(`+ ${hunk.path} (created)`)
          } else if (hunk.type === 'delete') {
            const store = useAppStore.getState()
            store.removeBuildFile(buildId, hunk.path)
            results.push(`- ${hunk.path} (deleted)`)
          } else if (hunk.type === 'update') {
            const store = useAppStore.getState()
            const existing = store.builds[buildId]?.projectFiles?.find(f => f.path === hunk.path)
            if (existing) {
              let content = existing.content
              for (const chunk of hunk.chunks) {
                const oldStr = chunk.oldLines.join('\n')
                const newStr = chunk.newLines.join('\n')
                if (content.includes(oldStr)) {
                  content = content.replace(oldStr, newStr)
                }
              }
              store.updateBuildFile(buildId, hunk.path, content)
              results.push(`~ ${hunk.path} (updated)`)
            } else {
              results.push(`~ ${hunk.path} (not found, skipped)`)
            }
          }
        }
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'success', content: `Patch applied:\n${results.join('\n')}` }
      } catch (e: any) {
        return { action: 'read', path: '/', stats: { added: 0, removed: 0 }, status: 'error', error: `Patch error: ${e.message}` }
      }
    }

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

    // ── zip: archive build to zip ──
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
          let fc = file.content || ''
          if (!file.contentLoaded) {
            fc = await useAppStore.getState().loadBuildFileContent(buildId, file.path)
          }
          zip.file(file.path, fc)
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
      
      const loadContent = (f: BuildFile) =>
        f.contentLoaded ? f.content || '' : state.loadBuildFileContent(buildId, f.path)

      let map: Record<string, string[]> = {}
      const mapFile = files.find(f => f.path === 'project_map.json')
      if (mapFile) {
        const mapContent = await loadContent(mapFile)
        try { map = JSON.parse(mapContent) } catch {}
      }

      const results: string[] = []
      for (const file of files) {
        const fc = file.path.toLowerCase().includes(query) ? '' : await loadContent(file)
        if (file.path.toLowerCase().includes(query) || fc.toLowerCase().includes(query)) {
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
        let fc = file.content || ''
        if (!file.contentLoaded) {
          fc = await state.loadBuildFileContent(buildId, file.path)
        }
        const imports = [...fc.matchAll(/(?:import|require)[\s\S]+?["']\.\/?([^"']+)["']/g)].map(m => m[1])
        map[file.path] = imports
      }
      
      const content = JSON.stringify(map, null, 2)
      await execTool({ name: 'create_file', arguments: { path: 'project_map.json', content } } as any)
      return { action: 'run', path: 'project_map.json', stats: { added: 0, removed: 0 }, status: 'success', content: 'Project map generated.' }
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
    } else if (provider === 'deepseek') {
      url = `${(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/v1/chat/completions`
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    } else if (provider === 'gemini') {
      const cleanModel = modelName.replace(/^models\//, '')
      url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent`
      if (apiKey) headers['x-goog-api-key'] = apiKey
    }

    const isGemini = provider === 'gemini'
    ;(globalThis as any).thinkingEffort = apiSettings.thinkingEffort || 'default'
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
    if (modelName.includes('o1') || modelName.includes('o3-mini')) {
      bodyObj.reasoning_effort = apiSettings.thinkingEffort === 'default' ? 'medium' : apiSettings.thinkingEffort
      delete bodyObj.temperature
    }
    // Apply tool overrides per provider
    const override = TOOL_OVERRIDES[provider]
    const toolsForRequest = override
      ? TOOL_DEFS.map(t => ({
          ...t,
          function: { ...t.function, ...override, parameters: t.function.parameters },
        }))
      : TOOL_DEFS
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
              // Only check the TAIL of the text for tool-call JSON.
              // Checking fullText caused false triggers when a plan was written before the JSON.
              const tail = fullText.slice(-300)
              if (!isFallbackToolMode && looksLikeToolCallJson(tail)) {
                isFallbackToolMode = true
                // The tool JSON starts somewhere in the tail — split text from JSON
                const jsonStart = Math.max(0, fullText.length - 300) +
                  Math.max(tail.indexOf('[{"name'), tail.indexOf('{"name'))
                fallbackToolText = fullText.slice(jsonStart)
                // The text before the JSON is clean — flush it if not already sent
                const cleanPreamble = fullText.slice(0, jsonStart).trim()
                if (cleanPreamble && textBuffer) {
                  // already streamed via onText — no action needed
                  textBuffer = ''
                }
              } else if (isFallbackToolMode) {
                fallbackToolText += delta.content
              } else {
                textBuffer += delta.content
                onText(delta.content)
              }
              if (!isFallbackToolMode && textBuffer.length > 1000) {
                textBuffer = ''
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
        console.warn('[streamWithCallbacks] tool call text could not be parsed:', fallbackToolText.slice(0, 200))
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

      let lastToolSig = ''
      let repeatSigCount = 0

      // 1. FULL PROJECT SNAPSHOT: Save state before starting the turn
      const state = useAppStore.getState()
      const projectSnapshot = state.builds[buildId]?.projectFiles.map(f => ({ ...f })) || []
      saveCheckpoint(buildId, 'PROJECT_SNAPSHOT', JSON.stringify(projectSnapshot))

      await syncFromDisk()

      while (stepCount < MAX_STEPS) {
        // Per-step guards — reset every iteration
        let codeFileTouchedThisTurn = false
        let ranCommandThisTurn = false
        let verifyNudged = false
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
        // Only stream text that isn't a tool call JSON — suppress raw JSON in real-time
        if (!looksLikeToolCallJson(chunk)) {
          const cleanChunk = chunk.replace(/<plan>[\s\S]*?<\/plan>/gi, '')
                                  .replace(/\[\{"name":[\s\S]*?\}\]/gi, '')
                                  .replace(/\{"name"\s*:\s*"[^"]+"[\s\S]*?"args"\s*:\s*\{[\s\S]*?\}\}/g, '')
          
          const cur = useAppStore.getState().builds[buildId].timeline
          const target = cur.find(t => t.id === assistantId)
          if (!target) return
          const newContent = (target.content || '') + cleanChunk
          updateTimelineItem(buildId, assistantId, { content: newContent })
          tokenCountRef.current = calcTokens(newContent)
          setTokenCount(tokenCountRef.current)
        }
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

      // After streaming: replace timeline item with cleaned text (overwrite raw streamed content)
      const displayText = cleanText.replace(/\[\{"name":[\s\S]*?\}\]/gi, '')
                                   .replace(/\{"name"\s*:\s*"[^"]+"[\s\S]*?"args"\s*:\s*\{[\s\S]*?\}\}/g, '')
                                   .replace(/```[\w]*\n?[\s\S]*?```/g, '')
                                   .trim()
       if (displayText || hasTools) {
         updateTimelineItem(buildId, assistantId, { content: displayText })
       } else {
         removeTimelineItem(buildId, assistantId)
       }

      if (!hasTools) {
        if (cleanText) {
          conversation.push({ role: 'assistant', content: cleanText })
        }
        break
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

      // Execute reads in parallel — mark each as 'loading' immediately so user sees activity
      const readResults = await Promise.all(readOps.map(async (tc) => {
        const idx = pendingIds[toolCalls.indexOf(tc)]
        if (idx) updateTimelineItem(buildId, idx, { status: 'loading' as any })
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
          diffPreview = lines.map(l => `+${l}`).join('\n').slice(0, 100000)
        }
        if (tc.name === 'edit_file' && ev.status === 'success') {
          const oldStr = (args.old_str as string) || ''
          const newStr = (args.new_str as string) || ''
          
          // Build line-level diff preview from oldStr → newStr using proper diff
          const oldLines = oldStr.split('\n')
          const newLines = newStr.split('\n')
          const parts: string[] = []
          const changes = diffArrays(oldLines, newLines)
          for (const change of changes) {
            if (change.added) {
              for (const line of change.value) parts.push(`+${line}`)
            } else if (change.removed) {
              for (const line of change.value) parts.push(`-${line}`)
            } else {
              for (const line of change.value) parts.push(` ${line}`)
            }
          }
          
          diffPreview = parts.length > 0 ? parts.join('\n').slice(0, 100000) : `Modified ${ev.path}`
        }
        if (tc.name === 'run_command' && ev.content) {
          const lines = ev.content.split('\n')
          previewContent = lines.slice(0, 30).join('\n')
          if (lines.length > 30) previewContent += '\n...'
        }
        const isHtml = ev.path?.endsWith('.html')
        const fullContent = isHtml && (tc.name === 'create_file' || tc.name === 'edit_file' || tc.name === 'read_file') ? (ev.content || '')
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
       if (repeatSigCount === 5) {
         toolResultMsg += `\n\n⚠ NOTICE: You just called the exact same tool with identical arguments 5 times in a row with no new information. Do NOT repeat it again — try a different command, or explain the problem instead.`
       }
       conversation.push({ role: 'user', content: toolResultMsg })
       if (repeatSigCount === 5) {
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
        // List files from the new directory (paths only — content loaded on demand)
        const dirNorm = dir.replace(/\\/g, '/')
        const rawFiles = await window.electronAPI.readDirRecursive(dir)
        const relPaths: string[] = []
        for (const rawPath of rawFiles) {
          const normPath = rawPath.replace(/\\/g, '/')
          const relPath = normPath.startsWith(dirNorm + '/') ? normPath.slice(dirNorm.length + 1) : normPath
          if (!relPath || relPath.startsWith('.git/') || relPath.startsWith('node_modules/')) continue
          relPaths.push(relPath)
        }
        const state = useAppStore.getState()
        state.syncBuildFileListing(buildId, relPaths)
        // Load config from the new directory
        applyConfig(dir).catch(() => {})
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
    setUserScrolledUp(false)

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

    // ── Discover skills for system prompt guidance ──
    const workDir = state.builds[buildId]?.workDir
    if (workDir) defaultSkillManager.discover(workDir)
    const skillGuidance = defaultSkillManager.buildGuidance(defaultSkillManager.list())
    const skillBlock = skillGuidance ? `\n\nSKILL GUIDES:\n${skillGuidance}` : ''

    // ── Build session context (reminders, todos) ──
    const sessionMgr = new SessionManager(String(buildId))
    const sessionPrompt = sessionMgr.buildSystemPrompt()
    const sessionBlock = sessionPrompt ? `\n\n${sessionPrompt}` : ''

    // ── Rebuild conversation only on first message; afterwards just append ──
    const isFirstMessage = conversationRef.current.length === 0
    if (isFirstMessage) {
      conversationRef.current = [
        { role: 'system', content: buildSystemPrompt(apiSettings.provider, useAppStore.getState().systemPrompt) + skillBlock + sessionBlock + '\n\n' + fileList },
        { role: 'user', content: conversationContent },
      ]
    } else {
      // Refresh only the system prompt (first message) with updated file list, then append new user turn
      if (conversationRef.current[0]?.role === 'system') {
        conversationRef.current[0].content = buildSystemPrompt(apiSettings.provider, useAppStore.getState().systemPrompt) + skillBlock + sessionBlock + '\n\n' + fileList
      }
      conversationRef.current.push({ role: 'user', content: conversationContent })
    }

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
  const handleClear = () => { 
    clearTimeline(buildId)
    setContextPercent(0) 
    setUserScrolledUp(false)
    setTimeout(() => {
      if (buildOutputRef.current) {
        buildOutputRef.current.scrollTop = buildOutputRef.current.scrollHeight
      }
    }, 0)
  }
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
    let data = content
    if (!data && file) {
      data = file.contentLoaded ? file.content : await state.loadBuildFileContent(buildId, path)
    }
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

  // Load saved conversation on mount — exactly once per buildId
  useEffect(() => {
    const key = `conv-loaded-${buildId}`
    if (sessionStorage.getItem(key)) return

    // Restore ALL saved builds when the first BuildAgent mounts
    if (buildId === 0) {
      const savedBuilds = loadAllSavedConversations()
      if (savedBuilds) {
        const state = useAppStore.getState()
        for (const [id, saved] of Object.entries(savedBuilds)) {
          const bId = Number(id)
          const existing = state.builds[bId]
          if (!existing) {
            state.addBuild(bId)
          }
          if (saved.timeline && saved.timeline.length > 0) {
            const existingTimeline = useAppStore.getState().builds[bId]?.timeline ?? []
            if (existingTimeline.length === 0) {
              for (const item of saved.timeline) {
                useAppStore.getState().addBuildTimelineItem(bId, item as BuildTimelineItem)
              }
            }
          }
          if (saved.workDir) {
            useAppStore.getState().setBuildWorkDir(bId, saved.workDir)
          }
        }
        // Ensure splitPaneBuildIds includes all restored builds
        const updatedState = useAppStore.getState()
        const allIds = Object.keys(savedBuilds).map(Number).sort((a, b) => a - b)
        if (allIds.length > 1) {
          updatedState.setSplitPaneBuildIds(allIds)
        }
        sessionStorage.setItem(key, '1')
        return
      }
    }

    // Fallback: load single build from legacy key
    const saved = loadSavedConversation(buildId)
    if (saved && saved.timeline && saved.timeline.length > 0) {
      const state = useAppStore.getState()
      const existing = state.builds[buildId]?.timeline ?? []
      if (existing.length > 0) return
      for (const item of saved.timeline) {
        state.addBuildTimelineItem(buildId, item as BuildTimelineItem)
      }
    }
    sessionStorage.setItem(key, '1')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId])

  const handleRevert = async (item: BuildTimelineItem) => {
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
    const prevVersions = new Map<string, string | null>()
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
        // File existed before session — try to read original from disk
        try {
          const diskContent = window.electronAPI
            ? await window.electronAPI.readBuildFile(path)
            : null
          if (diskContent !== null && diskContent !== undefined) {
            prevVersions.set(path, diskContent)
          } else {
            prevVersions.set(path, null) // null = file genuinely didn't exist
          }
        } catch {
          prevVersions.set(path, null)
        }
      }
    }

    // Remove all items from the clicked index onward
    for (let i = index; i < timeline.length; i++) {
      state.removeBuildTimelineItem(buildId, timeline[i].id)
    }

    // Restore files to their previous state (store + actual filesystem)
    const workDir = build.workDir
    for (const [path, content] of prevVersions) {
      if (content === null) {
        // File didn't exist before — remove it
        state.removeBuildFile(buildId, path)
      } else {
        state.updateBuildFile(buildId, path, content)
        if (workDir) {
          window.electronAPI?.writeBuildFile({ filePath: path, content }).catch(() => {})
        }
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
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`
        .build-agent-root {
          --font-xxs: clamp(7px, 0.9vw, 10px);
          --font-xs: clamp(8px, 1vw, 12px);
          --font-sm: clamp(10px, 1.3vw, 14px);
          --font-md: clamp(12px, 1.6vw, 17px);
          --font-lg: clamp(14px, 2vw, 22px);
          --font-xl: clamp(16px, 2.5vw, 28px);
        }
        .build-agent-root .ba-scroll::-webkit-scrollbar{width:6px;height:6px}
        .build-agent-root .ba-scroll::-webkit-scrollbar-track{background:transparent}
        .build-agent-root .ba-scroll::-webkit-scrollbar-thumb{background:#444;border-radius:3px}
        .build-agent-root .ba-scroll::-webkit-scrollbar-thumb:hover{background:#555}
        .build-agent-root .ba-scroll{scrollbar-width:thin;scrollbar-color:#444 transparent;overscroll-behavior:contain}
      `}</style>
      <div className="build-agent-root" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: 28, WebkitAppRegion: 'drag' as any, background: '#121212', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, padding: '0 4px' }}>
        <div style={{ flex: 1 }} />
        <span style={{ color: '#999', fontSize: 11, fontWeight: 600, letterSpacing: 2.5, userSelect: 'none' }}>BOWOW</span>
        <div style={{ display: 'flex', gap: 4, flex: 1, justifyContent: 'flex-end' }}>
        <button onClick={() => window.electronAPI?.windowMinimize()}
          style={{ WebkitAppRegion: 'no-drag' as any, border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '2px 6px', borderRadius: 3 }}
          title="Minimize">─</button>
        <button onClick={() => window.electronAPI?.windowMaximize()}
          style={{ WebkitAppRegion: 'no-drag' as any, border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '2px 6px', borderRadius: 3 }}
          title="Maximize">□</button>
        <button onClick={() => { if (window.confirm('Are you sure you want to exit?')) window.electronAPI?.windowClose() }}
          style={{ WebkitAppRegion: 'no-drag' as any, border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '2px 6px', borderRadius: 3 }}
          title="Close">✕</button>
      </div>
      </div>
      <div ref={buildOutputRef} className="ba-scroll" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: showSettings ? 0 : '4px 0', position: 'relative', width: '100%', maxHeight: '100%' }}>
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
                            fontWeight: 700, fontSize: 'var(--font-sm)', padding: '2px 6px', borderRadius: 3,
                            letterSpacing: 0.3,
                         }}>+{item.stats.added}</span>
                       )}
                       {item.stats && item.stats.removed > 0 && (
                         <span style={{
                            background: 'rgba(18, 18, 18, 0.15)', color: '#f44336',
                            fontWeight: 700, fontSize: 'var(--font-sm)', padding: '2px 6px', borderRadius: 3,
                            letterSpacing: 0.3,
                         }}>-{item.stats.removed}</span>
                       )}
                      {item.tokenCount !== undefined && <span style={{ color: '#444', fontSize: 'var(--font-xs)' }}>({item.tokenCount}t)</span>}
                      {item.status === 'pending' && (!item.stats || item.stats.added === 0) && <span className="thinking-shimmer" style={{ fontSize: 'var(--font-xs)', marginLeft: 2 }}>…</span>}
                    {item.status === 'error' && <span className="thinking-shimmer" style={{ color: '#f87171', fontSize: 'var(--font-sm)' }} title={item.error || ''}>⚠ {item.error}</span>}
                        <button onClick={e => { e.stopPropagation(); toggleCollapse(item.id) }}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#666', fontSize: 'var(--font-sm)', padding: '2px 4px', marginLeft: 'auto', transform: expandedItems.has(item.id) ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', display: item.toolName === 'run_command' ? 'none' : 'inline-flex' }}>
                          ▶
                        </button>
                   </div>
                   {expandedItems.has(item.id) && (<>
                  {item.iframeSrcDoc ? (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', paddingTop: 4 }}>
                      <div style={{ border: '1px solid #444', borderRadius: 4, overflow: 'hidden', background: '#fff', height: 180 }}>
                        <iframe srcDoc={item.iframeSrcDoc} sandbox="allow-scripts" style={{ width: '100%', height: '100%', border: 'none' }} />
                      </div>
                    </div>
                  ) : item.diffPreview ? (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', maxHeight: 200, overflow: 'auto' }}>
                      <ColoredDiff diffContent={item.diffPreview} />
                      <button onClick={() => setDiffViewerContent(item.diffPreview ?? null)}
                        style={{ marginTop: 4, border: '1px solid #444', background: '#121212', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '2px 8px', borderRadius: 4, color: '#888' }}>
                        View Full Diff
                      </button>
                    </div>
                  ) : undefined}

                  {!item.iframeSrcDoc && !item.diffPreview && item.toolName === 'run_command' && !!item.content && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a' }}>
                      <ToolResultSummary toolName="run_command" content={String(item.content)} />
                    </div>
                  )}
                  {!item.iframeSrcDoc && !item.diffPreview && ['grep_search', 'glob_search', 'semantic_search', 'ls'].includes(item.toolName || '') && !!item.content && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', maxHeight: 150, overflow: 'auto' }}>
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#ccc', fontSize: 'var(--font-sm)', fontFamily: 'Consolas, monospace' }}>{item.content}</pre>
                    </div>
                  )}
                  {!item.iframeSrcDoc && !item.diffPreview && item.toolName === 'read_file' && !!item.content && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', paddingTop: 6 }}>
                      <ToolResultSummary toolName="read_file" content={String(item.content)} />
                      <pre style={{
                        marginTop: 6, margin: '6px 0 0', padding: '10px 14px', background: '#1a1a1a',
                        borderRadius: 6, maxHeight: 200, overflow: 'auto', fontSize: '12px',
                        fontFamily: 'Consolas, monospace', border: '1px solid #2e2e2e', color: '#aaa',
                        whiteSpace: 'pre'
                      }}>{String(item.content)}</pre>
                    </div>
                  )}
                  {!item.iframeSrcDoc && !item.diffPreview && item.content && (
                    item.path && /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(item.path) && (
                      <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', paddingTop: 4 }}>
                        <img src={item.content.startsWith('data:') ? item.content : `data:image/${item.path.split('.').pop()?.toLowerCase() === 'svg' ? 'svg+xml' : item.path.split('.').pop()?.toLowerCase() || 'png'};base64,${item.content}`}
                          onClick={() => setFullImage(item.content.startsWith('data:') ? item.content : `data:image/${item.path.split('.').pop()?.toLowerCase() === 'svg' ? 'svg+xml' : item.path.split('.').pop()?.toLowerCase() || 'png'};base64,${item.content}`)}
                          style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 4, display: 'block', cursor: 'pointer' }} />
                      </div>
                    )
                  )}
                  {!item.iframeSrcDoc && !item.diffPreview && item.path && /\.(mp3|wav|ogg|aac|flac)$/i.test(item.path) && item.content && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #2a2a2a', paddingTop: 4 }}>
                      <audio controls style={{ width: '100%', height: 36 }}
                        src={item.content.startsWith('data:') ? item.content : `data:audio/${item.path.split('.').pop()?.toLowerCase()};base64,${item.content}`} />
                    </div>
                  )}
                  {!item.iframeSrcDoc && !item.diffPreview && item.previewContent && item.toolName !== 'run_command' && item.toolName !== 'read_file' && !/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|mp3|wav|ogg|aac|flac)$/i.test(item.path || '') && (
                    <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', color: '#888', fontSize: 'var(--font-sm)', fontFamily: 'Consolas, monospace', lineHeight: 1.4, maxHeight: 200, overflow: 'auto' }}>{truncateHead(item.previewContent, { maxLines: 200 }).content}</pre>
                  )}
                      {item.toolName !== 'read_file' && item.toolName !== 'run_command' && (
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
                      )}
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
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#f87171', fontSize: 'var(--font-sm)', padding: 0, transform: expandedItems.has(item.id) ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                           ▶
                         </button>
                         <div style={{ color: '#f87171', fontWeight: 600, marginBottom: 4 }}>Error</div>
                       </div>
                       {expandedItems.has(item.id) && <div style={{ color: '#c0c0c6', whiteSpace: 'pre-wrap', fontSize: 'var(--font-md)', marginBottom: 8 }}>{item.content}</div>}
                       <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                         <button onClick={() => { navigator.clipboard.writeText(item.content || ''); }}
                           style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#666', fontSize: 'var(--font-sm)', padding: '0 4px' }}>Copy</button>
                         {isRunning || isAutoRetrying ? (
                           <button onClick={handleStop} style={{
                             padding: '3px 10px', fontSize: 'var(--font-sm)', cursor: 'pointer',
                             border: '1px solid #f44336', borderRadius: 4, background: '#2a1010', color: '#f87171',
                           }}>Stop</button>
                         ) : (
                           <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4 }}>
                             <button onClick={() => setShowModelPicker(true)}
                               style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '3px 6px', fontSize: 'var(--font-xs)', cursor: 'pointer', border: '1px solid #444', borderRadius: 4, background: '#121212', color: '#aaa' }}>
                               <span style={{ maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis' }}>{apiSettings.model.split('/').pop()}</span>
                               <span style={{ fontSize: 'var(--font-xxs)' }}>▼</span>
                             </button>
                             {showModelPicker && (
                               <>
                                 <div onClick={() => setShowModelPicker(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
                                 <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, background: '#121212', border: '1px solid #333', borderRadius: 8, maxHeight: 200, overflow: 'auto', zIndex: 1000, minWidth: 140 }}>
                                   {apiSettings.availableModels.map(m => (
                                     <div key={m} onClick={() => { setLocalModel(m); setShowModelPicker(false) }}
                                       style={{ padding: '6px 10px', fontSize: 'var(--font-md)', cursor: 'pointer', color: m === apiSettings.model ? '#fff' : '#aaa', background: m === apiSettings.model ? '#333' : 'transparent', borderBottom: '1px solid #2a2a2a' }}
                                       onMouseEnter={e => { if (m !== apiSettings.model) (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
                                       onMouseLeave={e => { if (m !== apiSettings.model) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                                       {m.split('/').pop()}
                                     </div>
                                   ))}
                                 </div>
                               </>
                             )}
                             <button onClick={handleContinueBuild} style={{
                               padding: '3px 10px', fontSize: 'var(--font-sm)', cursor: 'pointer',
                               border: '1px solid #444', borderRadius: 4, background: '#121212', color: '#e0e0e6',
                             }}>{item.content?.includes('getBuildDirectory') ? 'Continue' : 'Retry'}</button>
                           </div>
                         )}
                       </div>
                      </div>
                    ) : (
                      item.content && (
                        <div style={{ margin: '6px 12px', padding: '4px 12px', fontSize: 'var(--font-md)', lineHeight: 1.6 }}>
                           <MarkdownContent content={item.content} color="#ccc" />
                        </div>
                      )
                    )
                ) : (
              <div dir={isRTL(item.content || '') ? 'rtl' : 'ltr'} style={{
                      margin: '6px 12px', padding: item.type === 'user' ? '12px 16px' : '4px 12px', borderRadius: 8, fontSize: 'var(--font-md)', lineHeight: 1.6,
                      border: item.type === 'user' ? '1px solid #363636' : 'none',
                      background: item.type === 'user' ? '#1e1e1e' : 'transparent', height: 'auto',
                      width: 'fit-content', marginLeft: item.type === 'user' ? 'auto' : '12px', marginRight: item.type === 'user' ? '12px' : 'auto',
                      textAlign: isRTL(item.content || '') ? 'right' as const : 'left' as const,
                      boxShadow: item.type === 'user' ? '0 2px 8px rgba(0,0,0,0.2)' : 'none'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                         <button onClick={e => { e.stopPropagation(); toggleCollapse(item.id) }}
                           style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#666', fontSize: 'var(--font-sm)', padding: 0, transform: (item.type === 'user' ? !expandedItems.has(item.id) : expandedItems.has(item.id)) ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                           ▶
                         </button>
                         <span style={{ color: item.type === 'user' ? '#999' : '#666', fontSize: 'var(--font-xs)', fontWeight: 600 }}>{item.type === 'user' ? 'You' : 'Assistant'}</span>
                       </div>
                       {(item.type === 'user' ? !expandedItems.has(item.id) : expandedItems.has(item.id)) && (item.content || item.previewContent) && (<>
                      {item.content?.startsWith('data:image/') ? (
                       <>
                          <img src={item.content} onClick={() => setFullImage(item.content)} style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 4, display: 'block', cursor: 'pointer' }} />
                         {item.previewContent && (
                           <div style={{ marginTop: 6, color: '#888', fontSize: 'var(--font-md)', whiteSpace: 'pre-wrap' }}>{item.previewContent}</div>
                         )}
                       </>
                     ) : item.type === 'user' ? (
                       <div style={{ color: '#e0e0e6', whiteSpace: 'pre-wrap', fontSize: 'var(--font-md)', wordBreak: 'break-word', fontFamily: 'system-ui, -apple-system, sans-serif' }}>{item.content}</div>
                     ) : (
                      <MarkdownContent content={item.content || ''} color="#ccc" />
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
              {currentAction ? ('Thinking (' + currentAction + ')') : (isShellRunning ? ('Shell' + (runningCommand ? ': ' + runningCommand : '')) : 'Thinking')}
            </span>
          </div>
        )}
         {isRunning && userScrolledUp && (
           <button onClick={() => { if (buildOutputRef.current) { buildOutputRef.current.scrollTop = buildOutputRef.current.scrollHeight; setUserScrolledUp(false) } }}
              style={{ position: 'sticky', bottom: 4, left: '50%', transform: 'translateX(calc(-50% - 10px))', padding: '4px 14px', fontSize: 'var(--font-sm)', color: '#ccc', background: '#121212', border: '1px solid #444', borderRadius: 12, cursor: 'pointer', zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}>
             ↓ Scroll to bottom
           </button>
         )}
         {!isRunning && userScrolledUp && timeline.length > 0 && (
           <button onClick={() => { if (buildOutputRef.current) { buildOutputRef.current.scrollTop = buildOutputRef.current.scrollHeight; setUserScrolledUp(false) } }}
              style={{ position: 'sticky', bottom: 4, left: '50%', transform: 'translateX(calc(-50% - 10px))', padding: '4px 14px', fontSize: 'var(--font-sm)', color: '#ccc', background: '#121212', border: '1px solid #444', borderRadius: 12, cursor: 'pointer', zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}>
             ↓ Scroll to bottom
           </button>
         )}
        <div ref={messagesEndRef} />
        </>)}
      </div>

      <style>{`.sd{display:flex;align-items:center;justify-content:center;width:18px;height:18px;cursor:pointer;pointer-events:auto}.sd::after{content:'';display:block;width:6px;height:2px;border-radius:2px;background:var(--sd-bg,#aaa);transition:all .2s ease}.sd:hover::after{width:14px;height:3px;background:#fff}.sd[data-has]{--sd-bg:#22c55e}.sd[data-active]::after{width:10px;height:3px;background:var(--sd-bg,#fff)}*{scrollbar-width:thin;scrollbar-color:#444 transparent}*::-webkit-scrollbar{width:6px;height:6px}*::-webkit-scrollbar-track{background:transparent}*::-webkit-scrollbar-thumb{background:#444;border-radius:3px}*::-webkit-scrollbar-thumb:hover{background:#555}.info-modal{width:380px;max-width:90vw;background:#121212;border:1px solid #2a2a2a;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6)}@keyframes shimmerBg{0%{background-position:200% 0}100%{background-position:-200% 0}}.import-overlay{position:fixed;inset:0;z-index:50000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)}`}</style>
      {/* Scroll indicators — user messages only, hidden when settings open */}
      {!showSettings && userTimeline.length > 1 && (
        <div style={{
          position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
          display: 'flex', flexDirection: 'column', gap: 4,
          padding: '6px 2px', pointerEvents: 'none', zIndex: 15,
        }}>
          {userTimeline.map(item => {
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

      {pendingPermission && (
        <div style={{
          margin: '0 8px', padding: '8px 12px', fontSize: 'var(--font-md)',
          background: '#121212', borderRadius: 6, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{
              display: 'inline-block', fontWeight: 'bold',
              backgroundImage: 'linear-gradient(90deg, #555, #fff, #555)',
              backgroundSize: '200% 100%', backgroundRepeat: 'no-repeat',
              WebkitBackgroundClip: 'text', backgroundClip: 'text',
              color: 'transparent', animation: 'shimmerBg 1.2s infinite linear',
              fontFamily: 'monospace', fontSize: 'var(--font-sm)',
            }}>Tool Permission: {pendingPermission.action}: {pendingPermission.resources.join(', ')}</span>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={() => { permissionReply({ requestID: pendingPermission.id, reply: 'reject' }); setPendingPermission(null) }}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '0 4px', color: '#999' }}>Reject</button>
              <button onClick={() => { permissionReply({ requestID: pendingPermission.id, reply: 'always' }); setPendingPermission(null) }}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '0 4px', color: '#999' }}>Always</button>
              <button onClick={() => { permissionReply({ requestID: pendingPermission.id, reply: 'allow' }); setPendingPermission(null) }}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '0 4px', color: '#999' }}>Allow</button>
            </div>
          </div>
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
          width: '100%',
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
               <input ref={fileInputRef} type="file" accept="image/*,.pdf,.txt" style={{ display: 'none' }} onChange={handleFileSelect} />
               {userPrompts.length > 0 && (
                 <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                   {userPrompts.map((p, i) => (
                     <button key={i} onClick={() => { setInput(p); textareaRef.current?.focus() }}
                       style={{ fontSize: 'var(--font-xxs)', padding: '3px 8px', borderRadius: 4, border: '1px solid #333', background: '#121212', color: '#888', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}
                       title={p}>{p}</button>
                   ))}
                 </div>
               )}
                                <div style={{ flex: 1, width: '100%', background: '#121212', border: '1px solid #333', borderRadius: 10, display: 'flex', flexDirection: 'column', padding: '6px 8px 36px 8px', position: 'relative' }}>
                <textarea ref={textareaRef} value={input} onChange={e => setInput(e.target.value)}
                 onKeyDown={handleKeyDown}
                 onPaste={handlePaste}
                 rows={1}
                 dir={isRTL(input) ? 'rtl' : 'ltr'}
                 placeholder={buildWorkDir ? 'Describe what to build in ' + buildWorkDir.split(/[\\\/]/).pop() + '...' : 'Ask anything...'}
                  style={{
                    width: '100%', background: 'transparent', border: 'none', color: '#e0e0e6',
                    fontSize: 'var(--font-md)', padding: 0, minHeight: 74, outline: 'none', resize: 'none', fontFamily: 'inherit',
                    lineHeight: 1.9, boxSizing: 'border-box', textAlign: isRTL(input) ? 'right' as const : 'left' as const,
                  }} />
               {/* Buttons row � absolute at bottom of textarea */}
               <div style={{ position: 'absolute', left: 4, bottom: 8, display: 'flex', alignItems: 'center', gap: 4, zIndex: 1 }}>
                 <button onClick={() => fileInputRef.current?.click()}
                   style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', color: '#555', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                   title="Attach file">
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                 </button>
                 <button onClick={handleClear}
                   style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', color: '#555', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                   title="Clear chat">
                   <SvgIcon name="clear" size={12} />
                 </button>
                 <button onClick={() => setShowSettings(true)}
                   style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', color: '#555', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                   title="API Settings">
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                 </button>
                 {apiSettings.connected && apiSettings.availableModels && apiSettings.availableModels.length > 0 && (
                   <div style={{ position: 'relative' }}>
                     <button onClick={() => setShowModelPicker(p => !p)}
                       style={{ height: 24, borderRadius: 6, border: '1px solid #333', background: '#121212', color: '#aaa', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', fontSize: 'var(--font-sm)', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                       <span style={{ maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis' }}>{apiSettings.model.split('/').pop()}</span>
                       <span style={{ fontSize: 'var(--font-xxs)' }}>&#x25BC;</span>
                     </button>
                     {showModelPicker && (
                       <>
                         <div onClick={() => setShowModelPicker(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
                         <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, background: '#121212', border: '1px solid #333', borderRadius: 8, maxHeight: 200, overflow: 'auto', zIndex: 1000, minWidth: 140 }}>
                           {apiSettings.availableModels.map(m => (
                             <div key={m} onClick={() => { setLocalModel(m); setShowModelPicker(false) }}
                               style={{ padding: '6px 10px', fontSize: 'var(--font-md)', cursor: 'pointer', color: m === apiSettings.model ? '#fff' : '#aaa', background: m === apiSettings.model ? '#333' : 'transparent', borderBottom: '1px solid #2a2a2a' }}
                               onMouseEnter={e => { if (m !== apiSettings.model) (e.currentTarget as HTMLElement).style.background = '#2a2a2a' }}
                               onMouseLeave={e => { if (m !== apiSettings.model) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                               {m.split('/').pop()}
                             </div>
                           ))}
                         </div>
                       </>
                     )}
                   </div>
                 )}
                   {apiSettings.connected && (
                     <button onClick={() => {
                       const cycleMap: Record<string, string> = { 'default': 'low', 'low': 'high', 'high': 'default' };
                        const currentEffort = localEffort ?? (globalApiSettings.thinkingEffort || 'default');
                       const nextEffort = cycleMap[currentEffort] || 'default';
                       setLocalEffort(nextEffort);
                     }}
                       style={{ height: 24, borderRadius: 6, border: '1px solid #333', background: '#121212', color: '#aaa', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, padding: '0 8px', fontSize: 'var(--font-xs)', fontFamily: 'inherit', whiteSpace: 'nowrap', userSelect: 'none' }}
                       title="Cycle Thinking Effort">
                       <span>Effort: </span>
                       <span style={{ fontWeight: 'bold', color: (localEffort ?? globalApiSettings.thinkingEffort) === 'high' ? '#4caf50' : ((localEffort ?? globalApiSettings.thinkingEffort) === 'low' ? '#ff9800' : '#888') }}>{((localEffort ?? globalApiSettings.thinkingEffort) || 'default').toUpperCase()}</span>
                     </button>
                   )}
               </div>
                </div>
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
      {fullImage && (
        <div className="import-overlay" onClick={() => setFullImage(null)} style={{ zIndex: 100000, cursor: 'zoom-out' }}>
          <img src={fullImage} onClick={e => e.stopPropagation()}
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, objectFit: 'contain' }} />
        </div>
      )}
    </div>
    </div>
  )
}
