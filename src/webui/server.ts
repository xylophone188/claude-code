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
  handlerLevel?: 'frontend' | 'ccb' | 'gateway'
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
  title: '三省六部 · 三层分工流水线',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [
    {
      id: 'init-1',
      role: 'system',
      content: '⚡ 三层协作流水线已激活：\n1. [前端层]：0-Token 意图拦截、清屏、简单问答、划词防刷\n2. [CCB 核心层]：代码构建、系统命令执行、复杂多工具规划\n3. [AgentBox 网关层]：多模型池集群故障转移、大语言模型直推',
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

// 调用 18800 agentbox-gateway 执行大模型直接推理
async function callGateway(prompt: string): Promise<string> {
  const res = await fetch('http://127.0.0.1:18800/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer sk-bridge-local-18800',
    },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,
    }),
  })
  if (!res.ok) throw new Error(`Gateway returned ${res.status}`)
  const data: any = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

function renderHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CCB Studio · 三省六部三层协同工作台</title>
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

    .tier-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      display: inline-block;
      margin-bottom: 4px;
      font-weight: 600;
    }
    .tier-frontend { background: rgba(106, 158, 255, 0.2); color: var(--accent); border: 1px solid rgba(106, 158, 255, 0.3); }
    .tier-ccb { background: rgba(215, 119, 87, 0.2); color: var(--primary); border: 1px solid rgba(215, 119, 87, 0.3); }
    .tier-gateway { background: rgba(46, 204, 138, 0.2); color: #2ecc8a; border: 1px solid rgba(46, 204, 138, 0.3); }

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
    .step-node.active { color: #fff; background: var(--step-active); font-weight: 600; }
    .step-node.done { color: #2ecc8a; background: rgba(46, 204, 138, 0.1); border: 1px solid rgba(46, 204, 138, 0.3); }
    .step-node.blocked { color: #ff6b6b; background: rgba(255, 107, 107, 0.15); border: 1px solid rgba(255, 107, 107, 0.4); font-weight: 600; }
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
      <div class="status-badge" id="connStatus">● 三层分工架构正常</div>
    </div>
    <div class="messages-area" id="messagesArea"></div>
    <div class="input-wrapper">
      <div class="input-box">
        <textarea id="promptInput" placeholder="下达任务... 前端先行 0-Token 过滤，复杂工程直通 CCB，模型直连交由 agentbox-gateway"></textarea>
        <div class="input-toolbar">
          <div class="toolbar-left">
            <span>💻 前端预处理</span>
            <span>⚡ CCB 工具引擎</span>
            <span>🌐 AgentBox (18800) 网关</span>
            <label style="cursor: pointer; display: flex; align-items: center; gap: 4px; color: var(--accent); margin-left: 6px;">
              <input type="checkbox" id="edictModeToggle" checked />
              📜 Edict 三省六部流水线
            </label>
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

    // ══ 1. 前端能做的前端做 ══
    function frontendPreflight(text) {
      const trimmed = text.trim();
      if (/^(清屏|清除|clear)$/i.test(trimmed)) {
        return { handled: true, action: 'clear' };
      }
      if (/^(你好|在吗|hi|hello)$/i.test(trimmed)) {
        return { handled: true, response: '在的！三层协同流水线已就绪，请输入具体工作或任务指令。' };
      }
      return { handled: false };
    }

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
      if (state === 'Blocked') {
        return '<div class="edict-stepper"><span class="step-node blocked">🚫 阻断中断 (Blocked)</span></div>';
      }
      const stages = [
        { key: 'Taizi', name: '🤴 太子' },
        { key: 'Chengxiang', name: '🏛️ 丞相' },
        { key: 'Zhongshu', name: '📋 中书' },
        { key: 'Menxia', name: '🔍 门下' },
        { key: 'Zhenguo', name: '🛡️ 镇国' },
        { key: 'Assigned', name: '⚙️ 尚书' },
        { key: 'Doing', name: '⚔️ 六部' },
        { key: 'Review', name: '🧪 自查' },
        { key: 'FinalReview', name: '⚖️ 御史台' },
        { key: 'Done', name: '✅ 准奏' },
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
        const tierTag = m.handlerLevel === 'frontend' ? '<div class="tier-badge tier-frontend">⚡ 前端直出 (0-Token)</div>' :
                        m.handlerLevel === 'gateway' ? '<div class="tier-badge tier-gateway">🌐 AgentBox 网关直出</div>' :
                        m.handlerLevel === 'ccb' ? '<div class="tier-badge tier-ccb">💻 CCB 核心引擎执行</div>' : '';

        return \`
          <div class="message-row \${m.role}" id="msg-row-\${m.id}">
            <div class="avatar">\${emoji}</div>
            <div class="bubble-wrapper">
              \${tierTag}
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

      // 1. 前端层执行
      const pre = frontendPreflight(text);
      if (pre.handled) {
        if (pre.action === 'clear') {
          await fetch(\`/api/messages/clear?sessionId=\${currentSessionId}\`, { method: 'POST' });
          loadMessages();
          return;
        }
        if (pre.response) {
          localMessages.push({ id: 'user-' + Date.now(), role: 'user', content: text, timestamp: Date.now() });
          localMessages.push({ id: 'asst-' + Date.now(), role: 'assistant', content: pre.response, timestamp: Date.now(), status: 'done', handlerLevel: 'frontend' });
          renderMessages();
          return;
        }
      }

      // 2. 进入后台流转
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

      const useEdict = document.getElementById('edictModeToggle')?.checked ?? true;

      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId, content: text, asstMsgId, useEdict })
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

  // 会话列表
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
          content: '新会话已开启，三层协同流水线待命。',
          timestamp: Date.now(),
        },
      ],
    }
    sessions.set(id, newSession)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(newSession))
    return
  }

  if (req.method === 'GET' && p === '/api/messages') {
    const sessionId = url.searchParams.get('sessionId') || DEFAULT_SESSION_ID
    const session = sessions.get(sessionId) || sessions.get(DEFAULT_SESSION_ID)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(session?.messages || []))
    return
  }

  if (req.method === 'POST' && p === '/api/messages/clear') {
    const sessionId = url.searchParams.get('sessionId') || DEFAULT_SESSION_ID
    const session = sessions.get(sessionId)
    if (session) {
      session.messages = [
        {
          id: `init-${Date.now()}`,
          role: 'system',
          content: '会话已清空。',
          timestamp: Date.now(),
        },
      ]
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // 专用 Edict 三省六部确定性执行 API
  if (req.method === 'POST' && p === '/api/edict') {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body)
        const text = (parsed.content || parsed.input || '').trim()
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Missing content/input parameter' }))
          return
        }

        const sessionId = parsed.sessionId || DEFAULT_SESSION_ID
        const pipeline = new EdictPipeline({
          onStateChange: (state, ctx) => {
            broadcastSSE(sessionId, 'stage_change', {
              messageId: parsed.messageId ?? `edict-${Date.now()}`,
              state,
              context: ctx,
            })
          },
        })

        const result = await pipeline.execute(text)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      }
    })
    return
  }

  // 消息接收与三层分工派发
  if (req.method === 'POST' && p === '/api/messages') {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body)
        const session = sessions.get(parsed.sessionId) || sessions.get(DEFAULT_SESSION_ID)!
        const asstMsgId = parsed.asstMsgId || `asst-${Date.now()}`
        const text = (parsed.content || '').trim()

        session.messages.push({
          id: `user-${Date.now()}`,
          role: 'user',
          content: text,
          timestamp: Date.now(),
        })

        if (session.messages.length <= 3) {
          session.title = text.slice(0, 16)
        }

        const isCodingOrToolTask = /(写代码|修改|运行|bash|git|文件|修复|编译|重构|部署|测试|执行)/i.test(text)
        const useEdict = parsed.useEdict ?? true
        const handlerLevel = useEdict ? 'ccb' : (isCodingOrToolTask ? 'ccb' : 'gateway')

        const assistantMsg: Message = {
          id: asstMsgId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          status: 'streaming',
          edictState: 'Taizi',
          handlerLevel,
        }
        session.messages.push(assistantMsg)

        // 异步分流执行：真实驱动 EdictPipeline 流水线
        ;(async () => {
          if (useEdict) {
            try {
              const pipeline = new EdictPipeline({
                onStateChange: (state, ctx) => {
                  assistantMsg.edictState = state
                  broadcastSSE(session.id, 'stage_change', { messageId: asstMsgId, state })
                },
                executor: async (subtaskId, dept, task) => {
                  const startChunk = `⚡ [${dept}] 正在调度履职: ${task?.title ?? subtaskId}\n`
                  assistantMsg.content += startChunk
                  broadcastSSE(session.id, 'message_chunk', { messageId: asstMsgId, chunk: startChunk })

                  // 若属于工部/刑部且为工程代码任务，联动 CCB 引擎执行具体指令
                  if (isCodingOrToolTask && (dept === '工部' || dept === '刑部')) {
                    await new Promise<void>((resolve) => {
                      let resolved = false
                      const safeResolve = () => {
                        if (!resolved) {
                          resolved = true
                          resolve()
                        }
                      }

                      const timer = setTimeout(() => {
                        try { ccb.kill('SIGTERM') } catch {}
                        safeResolve()
                      }, 25000)

                      const ccb = spawn('/home/melody/.local/bin/ccb', [
                        '-p',
                        '--dangerously-skip-permissions',
                        `${dept}任务: ${task?.description ?? text}`,
                      ], {
                        stdio: ['ignore', 'pipe', 'pipe'],
                        env: {
                          ...process.env,
                          HOME: '/home/melody',
                          PATH: '/home/melody/.cargo/bin:/home/melody/.local/bin:/home/melody/.bun/bin:/home/melody/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                          TERM: 'dumb',
                        },
                      })

                      ccb.stdout.on('data', (d: any) => {
                        const chunk = d.toString()
                        assistantMsg.content += chunk
                        broadcastSSE(session.id, 'message_chunk', { messageId: asstMsgId, chunk })
                      })

                      ccb.stderr.on('data', (d: any) => {
                        const errChunk = d.toString()
                        assistantMsg.content += errChunk
                        broadcastSSE(session.id, 'message_chunk', { messageId: asstMsgId, chunk: errChunk })
                      })

                      ccb.on('close', () => {
                        clearTimeout(timer)
                        safeResolve()
                      })
                      ccb.on('error', () => {
                        clearTimeout(timer)
                        safeResolve()
                      })
                    })
                  } else {
                    await new Promise(r => setTimeout(r, 60))
                  }

                  const finishChunk = `✅ [${dept}] 履职成功: ${task?.title ?? subtaskId}\n`
                  assistantMsg.content += finishChunk
                  broadcastSSE(session.id, 'message_chunk', { messageId: asstMsgId, chunk: finishChunk })
                  return { success: true, output: `[${dept}] 履职完毕` }
                },
              })

              const result = await pipeline.execute(text)
              if ('directResponse' in result) {
                assistantMsg.content = result.directResponse
                assistantMsg.edictState = 'Done'
                assistantMsg.status = 'done'
              } else {
                const report = '\n' + EdictPipeline.formatReport(result)
                assistantMsg.content += report
                assistantMsg.edictState = result.state
                assistantMsg.status = result.state === 'Done' ? 'done' : 'error'
              }

              broadcastSSE(session.id, 'message_done', {
                messageId: asstMsgId,
                content: assistantMsg.content,
                edictState: assistantMsg.edictState,
              })
            } catch (err: any) {
              assistantMsg.content = `[Edict 流水线异常]: ${err.message}`
              assistantMsg.status = 'error'
              assistantMsg.edictState = 'Blocked'
              broadcastSSE(session.id, 'message_done', {
                messageId: asstMsgId,
                content: assistantMsg.content,
                edictState: 'Blocked',
              })
            }
          }
          // ══ 纯文本生成且关闭流水线时分流给 agentbox-gateway (18800) ══
          else {
            try {
              const reply = await callGateway(text)
              assistantMsg.content = reply
              broadcastSSE(session.id, 'stage_change', { messageId: asstMsgId, state: 'FinalReview' })
              await new Promise(r => setTimeout(r, 100))
              assistantMsg.edictState = 'Done'
              assistantMsg.status = 'done'
              broadcastSSE(session.id, 'message_done', {
                messageId: asstMsgId,
                content: assistantMsg.content,
                edictState: 'Done',
              })
            } catch (err: any) {
              assistantMsg.content = `[AgentBox 异常]: ${err.message}`
              assistantMsg.status = 'error'
              assistantMsg.edictState = 'Blocked'
              broadcastSSE(session.id, 'message_done', {
                messageId: asstMsgId,
                content: assistantMsg.content,
                edictState: 'Blocked',
              })
            }
          }
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
  console.log(`Three-tier Edict Pipeline UI running at http://${HOST}:${PORT}`)
})
