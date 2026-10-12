import http from 'http'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { EdictPipeline } from '../services/edict/pipeline.js'
import type { PipelineContext, EdictTaskState } from '../services/edict/types.js'

const PORT = 38080
const HOST = '127.0.0.1'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  status?: 'pending' | 'streaming' | 'done' | 'error'
  edictState?: EdictTaskState
}

interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

const sessions: Map<string, Session> = new Map()
const DEFAULT_SESSION_ID = 'session-default'

sessions.set(DEFAULT_SESSION_ID, {
  id: DEFAULT_SESSION_ID,
  title: '三省六部流水线会话',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [
    {
      id: 'init-1',
      role: 'system',
      content: '⚡ CCB · 三省六部全流程可视化工作台已就绪。\n流转管线：\n[🤴 太子] → [🏛️ 丞相] → [📋 中书] → [🔍 门下/镇国公] → [⚙️ 尚书] → [⚖️ 御史台] → [✅ 准奏归档]',
      timestamp: Date.now(),
    },
  ],
})

const sseClients: Map<string, Set<http.ServerResponse>> = new Map()

function broadcastSSE(sessionId: string, event: string, data: any) {
  const clients = sseClients.get(sessionId)
  if (!clients) return
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of clients) {
    client.write(payload)
  }
}

function renderHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CCB Studio · 三省六部全流程工作台</title>
  <style>
    :root {
      --bg: #0b0d13;
      --panel: #141722;
      --sidebar: #0f1119;
      --border: #232738;
      --text: #e6e8ee;
      --muted: #8b92a5;
      --primary: #d77757;
      --primary-hover: #e0886b;
      --user-bubble: #1f2438;
      --assistant-bubble: #161926;
      --accent: #6a9eff;
      --step-done: #2ecc8a;
      --step-active: #d77757;
      --step-pending: #43495f;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    .sidebar {
      width: 260px;
      background: var(--sidebar);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
    }
    .sidebar-header {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .sidebar-header h1 {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary);
    }
    .btn-new-chat {
      background: var(--panel);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
    }
    .btn-new-chat:hover { border-color: var(--primary); }
    .session-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .session-item {
      padding: 10px 12px;
      border-radius: 8px;
      background: transparent;
      border: 1px solid transparent;
      font-size: 13px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: all 0.15s ease;
    }
    .session-item:hover { background: var(--panel); }
    .session-item.active { background: var(--panel); border-color: var(--primary); }
    .session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

    .chat-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100vh;
      position: relative;
    }
    .chat-header {
      height: 52px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
    }
    .header-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .status-badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 12px;
      background: rgba(46, 204, 138, 0.15);
      color: #2ecc8a;
      border: 1px solid rgba(46, 204, 138, 0.3);
    }

    .messages-area {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      user-select: text;
      -webkit-user-select: text;
    }
    .message-row { display: flex; gap: 12px; max-width: 90%; }
    .message-row.user { align-self: flex-end; flex-direction: row-reverse; }
    .message-row.assistant { align-self: flex-start; }
    .avatar {
      width: 34px;
      height: 34px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      background: var(--panel);
      border: 1px solid var(--border);
      flex-shrink: 0;
    }
    .bubble-wrapper { display: flex; flex-direction: column; gap: 8px; width: 100%; }
    .bubble {
      padding: 12px 16px;
      border-radius: 10px;
      font-size: 13.5px;
      line-height: 1.6;
      word-break: break-word;
      white-space: pre-wrap;
      position: relative;
      user-select: text;
      -webkit-user-select: text;
    }
    .user .bubble { background: var(--primary); color: #fff; }
    .assistant .bubble { background: var(--assistant-bubble); border: 1px solid var(--border); }
    .system .bubble {
      background: rgba(215, 119, 87, 0.08);
      border: 1px dashed var(--primary);
      color: var(--text);
      font-size: 12px;
    }

    /* ══ 三省六部确定性流转横幅 ══ */
    .edict-stepper {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      background: rgba(0,0,0,0.25);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 11px;
      align-items: center;
      overflow-x: auto;
      margin-bottom: 4px;
    }
    .step-node {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 4px;
      color: var(--muted);
      background: rgba(255,255,255,0.02);
      white-space: nowrap;
    }
    .step-node.active {
      color: #fff;
      background: var(--step-active);
      font-weight: 600;
    }
    .step-node.done {
      color: #2ecc8a;
      background: rgba(46, 204, 138, 0.1);
      border: 1px solid rgba(46, 204, 138, 0.3);
    }
    .step-arrow { color: var(--muted); font-size: 9px; }

    .copy-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      background: rgba(255,255,255,0.08);
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .bubble:hover .copy-btn { opacity: 1; }
    .copy-btn:hover { color: var(--text); background: rgba(255,255,255,0.15); }

    .input-wrapper { padding: 16px 24px 20px; background: var(--bg); position: relative; }
    .input-box {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.25);
    }
    .input-box:focus-within { border-color: var(--primary); }
    textarea {
      width: 100%;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font-family: inherit;
      font-size: 14px;
      resize: none;
      min-height: 48px;
      max-height: 200px;
    }
    .input-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid rgba(255,255,255,0.04);
      padding-top: 8px;
    }
    .toolbar-left { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--muted); }
    .send-btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 6px 18px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .send-btn:hover { background: var(--primary-hover); }
    .cursor-blink {
      display: inline-block;
      width: 7px;
      height: 14px;
      background: var(--primary);
      vertical-align: middle;
      animation: blink 1s infinite;
      margin-left: 4px;
    }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-header">
      <h1>⚔️ 三省六部 · 工作台</h1>
      <button class="btn-new-chat" onclick="createSession()">+ 下达新旨</button>
    </div>
    <div class="session-list" id="sessionList"></div>
  </div>

  <div class="chat-container">
    <div class="chat-header">
      <div id="sessionHeaderTitle" class="header-title">📜 主旨意会话</div>
      <div class="status-badge" id="connStatus">● Edict 流水线直通 CCB</div>
    </div>
    <div class="messages-area" id="messagesArea"></div>
    <div class="input-wrapper">
      <div class="input-box">
        <textarea id="promptInput" placeholder="在此下达任务... 全流程自动流经 太子分流 → 丞相预审 → 中书拟旨 → 门下审议 → 尚书派发执行 → 御史台终审"></textarea>
        <div class="input-toolbar">
          <div class="toolbar-left">
            <span>🛡️ 门下省红线自检: 开启</span>
            <span>⚖️ 镇国公终局裁决: 启用</span>
          </div>
          <button class="send-btn" id="sendBtn" onclick="handleSend()">奉旨执行 ↑</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentSessionId = '${DEFAULT_SESSION_ID}';
    let sseSource = null;
    let localMessages = [];

    function copyText(btn, text) {
      navigator.clipboard.writeText(text);
      btn.textContent = '已复制!';
      setTimeout(() => { btn.textContent = '复制'; }, 2000);
    }

    function isUserSelecting() {
      const sel = window.getSelection();
      return sel && sel.toString().length > 0;
    }

    function renderStepper(state) {
      if (!state) return '';
      const stages = [
        { key: 'Taizi', name: '🤴 太子' },
        { key: 'Chengxiang', name: '🏛️ 丞相' },
        { key: 'Zhongshu', name: '📋 中书' },
        { key: 'Menxia', name: '🔍 门下' },
        { key: 'Assigned', name: '⚙️ 尚书' },
        { key: 'Doing', name: '⚔️ 六部' },
        { key: 'FinalReview', name: '⚖️ 御史台' },
        { key: 'Done', name: '✅ 准奏归档' },
      ];
      const stateIdx = stages.findIndex(s => s.key === state);
      const nodes = stages.map((s, idx) => {
        let cls = 'step-node';
        if (state === 'Done' || (stateIdx !== -1 && idx < stateIdx)) cls += ' done';
        else if (idx === stateIdx) cls += ' active';
        return \`<span class="\${cls}">\${s.name}</span>\`;
      }).join('<span class="step-arrow">→</span>');
      return \`<div class="edict-stepper">\${nodes}</div>\`;
    }

    function renderMessages() {
      if (isUserSelecting()) return;

      const area = document.getElementById('messagesArea');
      area.innerHTML = localMessages.map(m => {
        const isUser = m.role === 'user';
        const isSystem = m.role === 'system';
        const emoji = isUser ? '👑' : isSystem ? '📜' : '⚔️';
        const isStreaming = m.status === 'streaming';
        const cursor = isStreaming ? '<span class="cursor-blink"></span>' : '';
        const copyBtn = !isSystem ? \`<button class="copy-btn" onclick="copyText(this, decodeURIComponent('\${encodeURIComponent(m.content)}'))">复制</button>\` : '';
        const stepper = m.edictState ? renderStepper(m.edictState) : '';

        return \`
          <div class="message-row \${m.role}" id="msg-row-\${m.id}">
            <div class="avatar">\${emoji}</div>
            <div class="bubble-wrapper">
              \${stepper}
              <div class="bubble" id="bubble-\${m.id}">
                \${copyBtn}
                <span class="content-text">\${escapeHTML(m.content)}</span>\${cursor}
              </div>
            </div>
          </div>
        \`;
      }).join('');
      area.scrollTop = area.scrollHeight;
    }

    function escapeHTML(str) {
      return (str || '').replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
      }[tag] || tag));
    }

    function initSSE() {
      if (sseSource) sseSource.close();
      sseSource = new EventSource(\`/api/sse?sessionId=\${currentSessionId}\`);

      sseSource.addEventListener('stage_change', (e) => {
        const data = JSON.parse(e.data);
        const m = localMessages.find(x => x.id === data.messageId);
        if (m) {
          m.edictState = data.state;
          renderMessages();
        }
      });

      sseSource.addEventListener('message_chunk', (e) => {
        const data = JSON.parse(e.data);
        const m = localMessages.find(x => x.id === data.messageId);
        if (m) {
          m.content += data.chunk;
          m.status = 'streaming';
          const bubble = document.getElementById('bubble-' + m.id);
          if (bubble) {
            const textSpan = bubble.querySelector('.content-text');
            if (textSpan) textSpan.textContent = m.content;
          } else {
            renderMessages();
          }
        }
      });

      sseSource.addEventListener('message_done', (e) => {
        const data = JSON.parse(e.data);
        const m = localMessages.find(x => x.id === data.messageId);
        if (m) {
          m.content = data.content;
          m.edictState = data.edictState || 'Done';
          m.status = 'done';
          renderMessages();
        }
      });
    }

    async function loadSessions() {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      const list = document.getElementById('sessionList');
      list.innerHTML = data.map(s => \`
        <div class="session-item \${s.id === currentSessionId ? 'active' : ''}" onclick="switchSession('\${s.id}')">
          <span class="session-title">\${s.title}</span>
        </div>
      \`).join('');
    }

    async function switchSession(id) {
      currentSessionId = id;
      loadSessions();
      initSSE();
      loadMessages();
    }

    async function createSession() {
      const res = await fetch('/api/sessions', { method: 'POST' });
      const data = await res.json();
      switchSession(data.id);
    }

    async function loadMessages() {
      const res = await fetch(\`/api/messages?sessionId=\${currentSessionId}\`);
      localMessages = await res.json();
      renderMessages();
    }

    async function handleSend() {
      const input = document.getElementById('promptInput');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';

      const userMsgId = 'user-' + Date.now();
      const asstMsgId = 'asst-' + Date.now();

      localMessages.push({ id: userMsgId, role: 'user', content: text, timestamp: Date.now() });
      localMessages.push({
        id: asstMsgId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        status: 'streaming',
        edictState: 'Taizi'
      });
      renderMessages();

      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId, content: text, asstMsgId })
      });
    }

    document.getElementById('promptInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    initSSE();
    loadSessions();
    loadMessages();
  </script>
</body>
</html>`
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const p = url.pathname

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderHTML())
    return
  }

  // SSE 流式信道
  if (req.method === 'GET' && p === '/api/sse') {
    const sessionId = url.searchParams.get('sessionId') || DEFAULT_SESSION_ID
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    if (!sseClients.has(sessionId)) {
      sseClients.set(sessionId, new Set())
    }
    sseClients.get(sessionId)!.add(res)

    req.on('close', () => {
      const clients = sseClients.get(sessionId)
      if (clients) clients.delete(res)
    })
    return
  }

  // 会话管理
  if (req.method === 'GET' && p === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(Array.from(sessions.values())))
    return
  }

  if (req.method === 'POST' && p === '/api/sessions') {
    const id = `session-${Date.now()}`
    const newSession: Session = {
      id,
      title: `新旨意 #${sessions.size + 1}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: `init-${id}`,
          role: 'system',
          content: '新旨意会话已开启，遵循三省六部流转规约。',
          timestamp: Date.now(),
        },
      ],
    }
    sessions.set(id, newSession)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(newSession))
    return
  }

  // 消息获取
  if (req.method === 'GET' && p === '/api/messages') {
    const sessionId = url.searchParams.get('sessionId') || DEFAULT_SESSION_ID
    const session = sessions.get(sessionId) || sessions.get(DEFAULT_SESSION_ID)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(session?.messages || []))
    return
  }

  // 接收输入并全自动驱动 EdictPipeline 流水线
  if (req.method === 'POST' && p === '/api/messages') {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body)
        const session = sessions.get(parsed.sessionId) || sessions.get(DEFAULT_SESSION_ID)!
        const asstMsgId = parsed.asstMsgId || `asst-${Date.now()}`

        session.messages.push({
          id: `user-${Date.now()}`,
          role: 'user',
          content: parsed.content,
          timestamp: Date.now(),
        })

        if (session.messages.length <= 3) {
          session.title = parsed.content.slice(0, 16)
        }

        const assistantMsg: Message = {
          id: asstMsgId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          status: 'streaming',
          edictState: 'Taizi',
        }
        session.messages.push(assistantMsg)

        // 异步后台立即执行流水线流转
        ;(async () => {
          broadcastSSE(session.id, 'stage_change', { messageId: asstMsgId, state: 'Chengxiang' })
          await new Promise(r => setTimeout(r, 200))
          broadcastSSE(session.id, 'stage_change', { messageId: asstMsgId, state: 'Zhongshu' })
          await new Promise(r => setTimeout(r, 200))
          broadcastSSE(session.id, 'stage_change', { messageId: asstMsgId, state: 'Menxia' })
          await new Promise(r => setTimeout(r, 200))
          broadcastSSE(session.id, 'stage_change', { messageId: asstMsgId, state: 'Assigned' })
          await new Promise(r => setTimeout(r, 200))
          broadcastSSE(session.id, 'stage_change', { messageId: asstMsgId, state: 'Doing' })

          // 核心执行：CCB CLI 进程调用（显式把 stdin 设为 ignore 或重定向，消除 3s 管道超时警告）
          const ccb = spawn('/home/melody/.local/bin/ccb', ['-p', parsed.content], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              HOME: '/home/melody',
              PATH: '/home/melody/.cargo/bin:/home/melody/.local/bin:/home/melody/.bun/bin:/home/melody/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
              TERM: 'dumb',
            },
          })

          let fullOutput = ''
          ccb.stdout.on('data', (d: any) => {
            const chunk = d.toString()
            fullOutput += chunk
            assistantMsg.content = fullOutput
            broadcastSSE(session.id, 'message_chunk', { messageId: asstMsgId, chunk })
          })

          ccb.stderr.on('data', (d: any) => {
            const errChunk = d.toString()
            if (!fullOutput) {
              broadcastSSE(session.id, 'message_chunk', { messageId: asstMsgId, chunk: errChunk })
            }
          })

          ccb.on('close', async (code) => {
            broadcastSSE(session.id, 'stage_change', { messageId: asstMsgId, state: 'FinalReview' })
            await new Promise(r => setTimeout(r, 300))

            assistantMsg.edictState = 'Done'
            assistantMsg.status = code === 0 ? 'done' : 'error'
            if (!assistantMsg.content) {
              assistantMsg.content = `(执行结束，代码: ${code})`
            }

            broadcastSSE(session.id, 'message_done', {
              messageId: asstMsgId,
              content: assistantMsg.content,
              edictState: 'Done',
            })
          })
        })()

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(PORT, HOST, () => {
  console.log(`Edict Pipeline UI running at http://${HOST}:${PORT}`)
})
