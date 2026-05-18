// =================================================================================
//  项目: perfectassistant-2api (Cloudflare Worker 单文件版)
//  版本: 1.0.0 (代号: Chimera Synthesis - Perfect)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
//  日期: 2025-11-23
//
//  描述:
//  本文件是一个完全自包含、可一键部署的 Cloudflare Worker。它将 perfectassistant.ai
//  的免费 AI 服务 (/ai/free)，无损地转换为一个高性能、兼容 OpenAI 标准的 API。
//  由于上游服务是非流式的，本 Worker 内置了智能伪流式 (Pseudo-Streaming) 引擎，
//  为客户端提供流畅的打字机体验。
//
//  [核心特性]
//  1. 伪流式生成: 将上游的一次性 JSON 响应转换为标准的 SSE 流。
//  2. 自动会话管理: 自动生成 chatId，无需用户干预。
//  3. 开发者驾驶舱: 内置全功能 Web UI，支持实时测试和配置生成。
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "perfectassistant-2api",
  PROJECT_VERSION: "1.0.0",
  
  // 安全配置 (请在 Cloudflare 环境变量中设置 API_MASTER_KEY，或修改此处)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_URL: "https://perfectassistant.ai/ai/free",
  ORIGIN_URL: "https://perfectassistant.ai",
  
  // 伪装配置
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  
  // 模型列表 (映射到上游的 id 参数)
  // 实际上 upstream 只接受 id 参数，这里我们做个映射
  MODELS: [
    "brainstorm-tool",      // 头脑风暴 (默认)
    "blog-post-generator",  // 博客生成
    "social-media-post",    // 社交媒体
    "email-writer",         // 邮件编写
    "essay-writer",         // 文章编写
    "paragraph-writer"      // 段落编写
  ],
  DEFAULT_MODEL: "brainstorm-tool",
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    // 优先读取环境变量
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);

    // 路由分发
    if (url.pathname === '/') {
      return handleUI(request, apiKey);
    } else if (url.pathname === '/v1/chat/completions') {
      return handleChatCompletions(request, apiKey);
    } else if (url.pathname === '/v1/models') {
      return handleModels(request, apiKey);
    } else if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    } else {
      return createErrorResponse(`未找到路径: ${url.pathname}`, 404, 'not_found');
    }
  }
};

// --- [第三部分: API 代理逻辑] ---

/**
 * 处理 /v1/chat/completions 请求
 */
async function handleChatCompletions(request, apiKey) {
  if (!verifyAuth(request, apiKey)) return createErrorResponse('未授权 (Unauthorized)', 401, 'unauthorized');

  let requestData;
  try {
    requestData = await request.json();
  } catch (e) {
    return createErrorResponse('无效的 JSON 请求体', 400, 'invalid_json');
  }

  const messages = requestData.messages || [];
  if (messages.length === 0) {
    return createErrorResponse('messages 不能为空', 400, 'invalid_request');
  }

  // 提取最后一条用户消息作为 prompt
  const lastUserMsg = messages.reverse().find(m => m.role === 'user');
  const prompt = lastUserMsg ? lastUserMsg.content : "Hello";
  
  // 模型映射
  const model = requestData.model || CONFIG.DEFAULT_MODEL;
  // 如果请求的模型不在列表中，默认使用 brainstorm-tool，或者直接透传
  const toolId = CONFIG.MODELS.includes(model) ? model : "brainstorm-tool";

  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  try {
    // 1. 构造上游请求
    // 上游 API 是非流式的，我们需要等待完整响应
    const upstreamPayload = {
      tone: "professional",
      language: "chinese", // 默认中文，也可以根据 prompt 检测
      text: prompt,
      chatId: crypto.randomUUID(), // 每次生成新的 chatId
      id: toolId
    };

    const response = await fetch(CONFIG.UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Origin': CONFIG.ORIGIN_URL,
        'Referer': `${CONFIG.ORIGIN_URL}/iframe/${toolId}?lang=en`,
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        // 尝试添加一些常见的指纹头
        'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'priority': 'u=1, i'
      },
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
      const errText = await response.text();
      return createErrorResponse(`上游服务错误: ${response.status} - ${errText}`, 502, 'upstream_error');
    }

    const data = await response.json();
    
    // 解析上游响应
    // 上游返回格式: { response: "...", responses: ["..."] }
    let content = "";
    if (data.response) {
      content = data.response;
    } else if (data.responses && data.responses.length > 0) {
      content = data.responses[0];
    } else {
      content = "无法获取有效回复。";
    }

    // 2. 处理流式响应 (Pseudo-Streaming)
    if (requestData.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // 异步执行伪流式推送
      (async () => {
        try {
          // 模拟打字机效果
          const chunkSize = 5; // 每次发送的字符数
          const delay = 20;    // 毫秒延迟

          for (let i = 0; i < content.length; i += chunkSize) {
            const chunkContent = content.slice(i, i + chunkSize);
            const chunk = {
              id: requestId,
              object: 'chat.completion.chunk',
              created: created,
              model: model,
              choices: [{
                index: 0,
                delta: { content: chunkContent },
                finish_reason: null
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            await new Promise(r => setTimeout(r, delay));
          }

          // 发送结束标记
          const finalChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: created,
            model: model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }]
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch (e) {
          // 流处理错误忽略
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: corsHeaders({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Worker-Trace-ID': requestId
        })
      });

    } else {
      // 3. 处理非流式响应
      const completion = {
        id: requestId,
        object: 'chat.completion',
        created: created,
        model: model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: content
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: prompt.length,
          completion_tokens: content.length,
          total_tokens: prompt.length + content.length
        }
      };

      return new Response(JSON.stringify(completion), {
        headers: corsHeaders({
          'Content-Type': 'application/json',
          'X-Worker-Trace-ID': requestId
        })
      });
    }

  } catch (e) {
    return createErrorResponse(`内部处理错误: ${e.message}`, 500, 'internal_error');
  }
}

/**
 * 处理 /v1/models 请求
 */
function handleModels(request, apiKey) {
  if (!verifyAuth(request, apiKey)) return createErrorResponse('未授权', 401, 'unauthorized');

  const models = CONFIG.MODELS.map(id => ({
    id: id,
    object: "model",
    created: 1677610602,
    owned_by: "perfectassistant-2api"
  }));

  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

// --- [辅助函数] ---

function verifyAuth(request, validKey) {
  if (validKey === "1") return true; // 允许弱密码模式
  const auth = request.headers.get('Authorization');
  return auth && auth === `Bearer ${validKey}`;
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const modelsJson = JSON.stringify(CONFIG.MODELS);
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root {
        --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; 
        --text-sec: #888; --primary: #FFBF00; --primary-hover: #FFD700;
        --input-bg: #2A2A2A; --success: #66BB6A; --error: #CF6679;
        --font: 'Segoe UI', system-ui, sans-serif; --mono: 'Fira Code', monospace;
      }
      * { box-sizing: border-box; }
      body { font-family: var(--font); background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      
      /* 布局 */
      .layout { display: flex; width: 100%; height: 100%; }
      .sidebar { width: 360px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; overflow: hidden; }
      
      /* 组件 */
      .header { border-bottom: 1px solid var(--border); padding-bottom: 15px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
      h1 { margin: 0; font-size: 18px; font-weight: 600; }
      .version { font-size: 12px; color: var(--text-sec); margin-left: 8px; font-weight: normal; }
      
      .card { background: #252525; border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 15px; }
      .card-label { font-size: 12px; color: var(--text-sec); margin-bottom: 6px; display: block; }
      .code-box { background: #111; padding: 8px; border-radius: 4px; font-family: var(--mono); font-size: 12px; color: var(--primary); word-break: break-all; cursor: pointer; position: relative; }
      .code-box:hover { background: #000; }
      .code-box::after { content: '点击复制'; position: absolute; right: 5px; top: 5px; font-size: 10px; color: #555; opacity: 0; transition: opacity 0.2s; }
      .code-box:hover::after { opacity: 1; }

      /* 状态指示器 */
      .status { display: flex; align-items: center; gap: 6px; font-size: 12px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #555; }
      .dot.ok { background: var(--success); box-shadow: 0 0 5px var(--success); }
      .dot.err { background: var(--error); }
      
      /* 终端 */
      .terminal { flex: 1; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; }
      .term-out { flex: 1; padding: 15px; overflow-y: auto; font-family: var(--font); font-size: 14px; line-height: 1.6; }
      .term-in { border-top: 1px solid var(--border); padding: 15px; display: flex; gap: 10px; background: #252525; }
      
      textarea { flex: 1; background: var(--input-bg); border: 1px solid var(--border); color: var(--text); padding: 10px; border-radius: 4px; resize: none; height: 50px; font-family: var(--font); }
      textarea:focus { outline: none; border-color: var(--primary); }
      
      button { background: var(--primary); color: #000; border: none; padding: 0 20px; border-radius: 4px; font-weight: bold; cursor: pointer; transition: background 0.2s; }
      button:hover { background: var(--primary-hover); }
      button:disabled { background: #555; cursor: not-allowed; }
      
      /* 消息样式 */
      .msg { margin-bottom: 12px; }
      .msg.user { color: var(--primary); font-weight: bold; }
      .msg.ai { color: var(--text); white-space: pre-wrap; }
      .msg.sys { color: var(--text-sec); font-size: 12px; font-style: italic; }
      .msg.err { color: var(--error); }
      
      /* 详情折叠 */
      details { margin-top: 10px; }
      summary { cursor: pointer; color: var(--text-sec); font-size: 13px; user-select: none; }
      summary:hover { color: var(--text); }
      .guide-content { margin-top: 10px; background: var(--input-bg); padding: 10px; border-radius: 4px; font-size: 12px; }
      
      @media (max-width: 768px) { .layout { flex-direction: column; } .sidebar { width: 100%; height: auto; border-right: none; border-bottom: 1px solid var(--border); } }
    </style>
</head>
<body>
    <div class="layout">
        <aside class="sidebar">
            <div class="header">
                <h1>${CONFIG.PROJECT_NAME} <span class="version">v${CONFIG.PROJECT_VERSION}</span></h1>
                <div class="status" id="status-indicator">
                    <div class="dot"></div><span id="status-text">检查中...</span>
                </div>
            </div>
            
            <div class="card">
                <span class="card-label">API 端点 (Endpoint)</span>
                <div class="code-box" onclick="copyText('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
            </div>
            
            <div class="card">
                <span class="card-label">API 密钥 (Master Key)</span>
                <div class="code-box" onclick="copyText('${apiKey}')">${apiKey}</div>
            </div>

            <div class="card">
                <span class="card-label">默认模型 (Default Model)</span>
                <div class="code-box" onclick="copyText('${CONFIG.DEFAULT_MODEL}')">${CONFIG.DEFAULT_MODEL}</div>
            </div>

            <details open>
                <summary>⚙️ 客户端集成指南</summary>
                <div class="guide-content">
                    <strong>OpenAI Python SDK:</strong>
                    <pre style="color:var(--text-sec); overflow-x:auto;">
import openai
client = openai.OpenAI(
    base_url="${origin}/v1",
    api_key="${apiKey}"
)
resp = client.chat.completions.create(
    model="${CONFIG.DEFAULT_MODEL}",
    messages=[{"role":"user", "content":"你好"}],
    stream=True
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
                    </pre>
                </div>
            </details>
        </aside>

        <main class="main">
            <div class="terminal">
                <div class="term-out" id="output">
                    <div class="msg sys">系统已就绪。上游服务: ${CONFIG.UPSTREAM_URL}</div>
                    <div class="msg sys">提示: 本服务使用伪流式 (Pseudo-Streaming) 技术，响应会有轻微延迟以模拟打字机效果。</div>
                </div>
                <div class="term-in">
                    <textarea id="input" placeholder="输入指令... (Enter 发送, Shift+Enter 换行)"></textarea>
                    <button id="send-btn">发送</button>
                </div>
            </div>
        </main>
    </div>

    <script>
        const CONFIG = {
            API_KEY: '${apiKey}',
            ENDPOINT: '${origin}/v1/chat/completions',
            MODELS: ${modelsJson},
            DEFAULT_MODEL: '${CONFIG.DEFAULT_MODEL}'
        };

        const output = document.getElementById('output');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('send-btn');
        const statusDot = document.querySelector('.dot');
        const statusText = document.getElementById('status-text');

        // 复制功能
        function copyText(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert('已复制到剪贴板');
            });
        }

        // 健康检查
        async function checkHealth() {
            try {
                const res = await fetch('${origin}/v1/models', {
                    headers: { 'Authorization': 'Bearer ' + CONFIG.API_KEY }
                });
                if (res.ok) {
                    statusDot.className = 'dot ok';
                    statusText.textContent = '服务正常';
                } else {
                    throw new Error('Status ' + res.status);
                }
            } catch (e) {
                statusDot.className = 'dot err';
                statusText.textContent = '服务异常';
            }
        }
        checkHealth();

        // 消息追加
        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = 'msg ' + role;
            div.textContent = text;
            output.appendChild(div);
            output.scrollTop = output.scrollHeight;
            return div;
        }

        // 发送逻辑
        async function send() {
            const text = input.value.trim();
            if (!text) return;
            
            input.value = '';
            input.disabled = true;
            sendBtn.disabled = true;
            
            appendMsg('user', text);
            const aiMsg = appendMsg('ai', '');
            
            try {
                const res = await fetch(CONFIG.ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + CONFIG.API_KEY
                    },
                    body: JSON.stringify({
                        model: CONFIG.DEFAULT_MODEL,
                        messages: [{ role: 'user', content: text }],
                        stream: true
                    })
                });

                if (!res.ok) throw new Error(await res.text());

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') continue;
                            try {
                                const data = JSON.parse(dataStr);
                                const content = data.choices[0].delta.content;
                                if (content) {
                                    aiMsg.textContent += content;
                                    output.scrollTop = output.scrollHeight;
                                }
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) {
                appendMsg('err', '错误: ' + e.message);
            } finally {
                input.disabled = false;
                sendBtn.disabled = false;
                input.focus();
            }
        }

        sendBtn.addEventListener('click', send);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    }
  });
}
