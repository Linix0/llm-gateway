'use strict';
/**
 * Responses API  <->  Chat Completions 适配层
 *
 * Codex CLI(0.16x) 只会说 Responses 协议，而 DeepSeek / GLM / Kimi 这类上游
 * 只提供 /v1/chat/completions。本模块负责双向翻译：
 *   请求：responses(input/tools/...)  ->  chat(messages/tools/...)
 *   响应：chat(choices/...)           ->  responses(output/usage/...)
 *   流式：chat chunk  ->  responses SSE events
 */

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/* ---------------- 内容 -> messages ---------------- */

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') return p.text || '';
      if (p.type === 'refusal') return p.refusal || '';
      return p.text || '';
    })
    .join('');
}

function toChatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  let hasImage = false;
  for (const p of content) {
    if (typeof p === 'string') {
      parts.push({ type: 'text', text: p });
      continue;
    }
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'input_image') {
      const url = p.image_url || p.url || '';
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
        hasImage = true;
      }
      continue;
    }
    const t = p.text || '';
    if (t) parts.push({ type: 'text', text: t });
  }
  if (!hasImage) return parts.map((x) => x.text || '').join('');
  return parts;
}

function pushAssistantToolCall(msgs, call) {
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'assistant' && Array.isArray(last.tool_calls) && !last.content) {
    last.tool_calls.push(call);
    return;
  }
  msgs.push({ role: 'assistant', content: null, tool_calls: [call] });
}

function buildMessages(body) {
  const msgs = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    msgs.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;
  const items = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : (Array.isArray(input) ? input : []);

  for (const it of items) {
    if (typeof it === 'string') {
      msgs.push({ role: 'user', content: it });
      continue;
    }
    if (!it || typeof it !== 'object') continue;
    const t = it.type;

    if (t === 'function_call') {
      pushAssistantToolCall(msgs, {
        id: it.call_id || it.id || uid('call'),
        type: 'function',
        function: {
          name: it.name || '',
          arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {})
        }
      });
      continue;
    }

    if (t === 'custom_tool_call') {
      pushAssistantToolCall(msgs, {
        id: it.call_id || it.id || uid('call'),
        type: 'function',
        function: { name: it.name || '', arguments: JSON.stringify({ input: it.input || '' }) }
      });
      continue;
    }

    if (t === 'function_call_output' || t === 'custom_tool_call_output' || t === 'local_shell_call_output') {
      let out = it.output;
      if (out && typeof out === 'object') {
        if (typeof out.content === 'string') out = out.content;
        else if (Array.isArray(out.content)) out = textOfContent(out.content);
        else out = JSON.stringify(out);
      }
      if (out === undefined || out === null) out = '';
      msgs.push({
        role: 'tool',
        tool_call_id: it.call_id || it.id || '',
        content: typeof out === 'string' ? out : String(out)
      });
      continue;
    }

    // reasoning / web_search_call 等宿主侧条目：chat 协议无对应结构，丢弃
    if (t === 'reasoning' || t === 'web_search_call' || t === 'file_search_call') continue;

    // 普通消息
    let role = it.role || 'user';
    if (role === 'developer') role = 'system';
    const content = toChatContent(it.content);
    if (content === '' || (Array.isArray(content) && content.length === 0)) continue;
    msgs.push({ role, content });
  }

  return msgs;
}

/* ---------------- tools ---------------- */

function buildTools(body) {
  const tools = [];
  const custom = new Set();
  for (const t of body.tools || []) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function' && t.name) {
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} }
        }
      });
    } else if (t.type === 'custom' && t.name) {
      // 自由文本工具（如 apply_patch）映射成只有一个 input 字符串参数的 function
      custom.add(t.name);
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: (t.description || '') + '\n\n调用方式：把要交给该工具的完整原始文本放进 input 字段。',
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string', description: '该工具的完整原始文本输入（不要做转义以外的二次包装）' }
            },
            required: ['input']
          }
        }
      });
    }
    // 其余宿主内置工具（web_search_preview 等）上游不支持，忽略
  }
  return { tools, custom };
}

function mapToolChoice(choice) {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (choice && typeof choice === 'object' && choice.type === 'function' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

/* ---------------- 请求：responses -> chat ---------------- */

function toChatRequest(body, model) {
  const messages = buildMessages(body);
  const { tools, custom } = buildTools(body);

  const chat = { model, messages, stream: !!body.stream };

  const maxTokens = body.max_output_tokens || body.max_tokens;
  if (maxTokens) chat.max_tokens = maxTokens;
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;

  if (tools.length) {
    chat.tools = tools;
    const tc = mapToolChoice(body.tool_choice);
    if (tc) chat.tool_choice = tc;
    if (body.parallel_tool_calls === false) chat.parallel_tool_calls = false;
  }

  const fmt = body.text && body.text.format;
  if (fmt && fmt.type === 'json_schema' && fmt.schema) {
    chat.response_format = {
      type: 'json_schema',
      json_schema: { name: fmt.name || 'result', schema: fmt.schema, strict: !!fmt.strict }
    };
  } else if (fmt && fmt.type === 'json_object') {
    chat.response_format = { type: 'json_object' };
  }

  return { chat, custom };
}

/* ---------------- 响应：chat -> responses ---------------- */

function toolCallItem(tc, custom) {
  const name = (tc.function && tc.function.name) || '';
  const args = (tc.function && tc.function.arguments) || '';
  if (custom && custom.has(name)) {
    let input = args;
    try {
      const o = JSON.parse(args);
      if (o && typeof o.input === 'string') input = o.input;
    } catch (_) { /* 保持原样 */ }
    return {
      id: uid('ctc'), type: 'custom_tool_call', status: 'completed',
      call_id: tc.id || uid('call'), name, input
    };
  }
  return {
    id: uid('fc'), type: 'function_call', status: 'completed',
    call_id: tc.id || uid('call'), name, arguments: args
  };
}

function baseResponse(id, model, status) {
  return {
    id,
    object: 'response',
    created_at: nowSec(),
    status,
    model,
    output: [],
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    max_output_tokens: null,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    text: { format: { type: 'text' } },
    truncation: 'disabled',
    usage: null,
    user: null
  };
}

function usageOf(cu) {
  if (!cu) return { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  const inTok = cu.prompt_tokens || cu.input_tokens || 0;
  const outTok = cu.completion_tokens || cu.output_tokens || 0;
  return {
    input_tokens: inTok,
    output_tokens: outTok,
    total_tokens: cu.total_tokens || inTok + outTok,
    input_tokens_details: { cached_tokens: (cu.prompt_tokens_details && cu.prompt_tokens_details.cached_tokens) || 0 },
    output_tokens_details: { reasoning_tokens: (cu.completion_tokens_details && cu.completion_tokens_details.reasoning_tokens) || 0 }
  };
}

function chatToResponses(json, model, custom) {
  const choice = (json.choices && json.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];

  const text = typeof msg.content === 'string' ? msg.content : textOfContent(msg.content);
  if (text) {
    output.push({
      id: uid('msg'),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }]
    });
  }
  for (const tc of msg.tool_calls || []) output.push(toolCallItem(tc, custom));

  const r = baseResponse(uid('resp'), model, 'completed');
  r.output = output;
  r.usage = usageOf(json.usage);
  return r;
}

/* ---------------- 流式翻译 ---------------- */

class StreamTranslator {
  constructor(send, model, custom) {
    this.send = send;               // (event, payload) => void
    this.model = model;
    this.custom = custom || new Set();
    this.seq = 0;
    this.id = uid('resp');

    this.text = null;               // { itemId, index, buf }
    this.output = [];               // 已完成的 item
    this.tools = new Map();         // chat index -> 状态
    this.nextIndex = 0;
    this.usage = null;
    this.closed = false;
  }

  emit(event, data) {
    data.type = event;
    data.sequence_number = this.seq++;
    this.send(event, data);
  }

  start() {
    const snap = baseResponse(this.id, this.model, 'in_progress');
    this.emit('response.created', { response: snap });
    this.emit('response.in_progress', { response: snap });
  }

  /* --- 文本 --- */
  openText() {
    if (this.text) return;
    const itemId = uid('msg');
    const index = this.nextIndex++;
    this.text = { itemId, index, buf: '' };
    this.emit('response.output_item.added', {
      output_index: index,
      item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
    });
    this.emit('response.content_part.added', {
      item_id: itemId, output_index: index, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
  }

  closeText() {
    if (!this.text) return;
    const { itemId, index, buf } = this.text;
    this.emit('response.output_text.done', { item_id: itemId, output_index: index, content_index: 0, text: buf });
    this.emit('response.content_part.done', {
      item_id: itemId, output_index: index, content_index: 0,
      part: { type: 'output_text', text: buf, annotations: [] }
    });
    const item = {
      id: itemId, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: buf, annotations: [] }]
    };
    this.emit('response.output_item.done', { output_index: index, item });
    this.output.push({ index, item });
    this.text = null;
  }

  textDelta(delta) {
    if (!delta) return;
    this.openText();
    this.text.buf += delta;
    this.emit('response.output_text.delta', {
      item_id: this.text.itemId, output_index: this.text.index, content_index: 0, delta
    });
  }

  /* --- 工具调用 --- */
  toolDelta(tc) {
    const idx = typeof tc.index === 'number' ? tc.index : 0;
    let st = this.tools.get(idx);
    if (!st) {
      st = { chatIndex: idx, itemId: null, callId: tc.id || uid('call'), name: '', args: '', index: -1, open: false, isCustom: false };
      this.tools.set(idx, st);
    }
    if (tc.id) st.callId = tc.id;
    if (tc.function && tc.function.name) st.name = tc.function.name;

    // 名字到了才能决定用 function_call 还是 custom_tool_call
    if (!st.open && st.name) this.openTool(st);

    const delta = tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : '';
    if (delta && st.open) {
      st.args += delta;
      if (!st.isCustom) {
        this.emit('response.function_call_arguments.delta', {
          item_id: st.itemId, output_index: st.index, delta
        });
      }
    }
  }

  openTool(st) {
    this.closeText();
    st.isCustom = this.custom.has(st.name);
    st.index = this.nextIndex++;
    st.itemId = st.isCustom ? uid('ctc') : uid('fc');
    st.open = true;
    const item = st.isCustom
      ? { id: st.itemId, type: 'custom_tool_call', status: 'in_progress', call_id: st.callId, name: st.name, input: '' }
      : { id: st.itemId, type: 'function_call', status: 'in_progress', call_id: st.callId, name: st.name, arguments: '' };
    this.emit('response.output_item.added', { output_index: st.index, item });
  }

  closeTool(st) {
    if (!st.open) return;
    let item;
    if (st.isCustom) {
      let input = st.args;
      try {
        const o = JSON.parse(st.args);
        if (o && typeof o.input === 'string') input = o.input;
      } catch (_) { /* 原样 */ }
      this.emit('response.custom_tool_call_input.delta', { item_id: st.itemId, output_index: st.index, delta: input });
      this.emit('response.custom_tool_call_input.done', { item_id: st.itemId, output_index: st.index, input });
      item = {
        id: st.itemId, type: 'custom_tool_call', status: 'completed',
        call_id: st.callId, name: st.name, input
      };
    } else {
      this.emit('response.function_call_arguments.done', {
        item_id: st.itemId, output_index: st.index, arguments: st.args
      });
      item = {
        id: st.itemId, type: 'function_call', status: 'completed',
        call_id: st.callId, name: st.name, arguments: st.args
      };
    }
    this.emit('response.output_item.done', { output_index: st.index, item });
    this.output.push({ index: st.index, item });
    st.open = false;
  }

  finish(usage) {
    if (this.closed) return;
    this.closed = true;
    this.closeText();
    for (const st of Array.from(this.tools.values())) {
      if (!st.open && st.name && st.index < 0) this.openTool(st);
      this.closeTool(st);
    }
    const r = baseResponse(this.id, this.model, 'completed');
    r.output = this.output.sort((a, b) => a.index - b.index).map((x) => x.item);
    r.usage = usageOf(usage || this.usage);
    this.emit('response.completed', { response: r });
  }

  fail(message) {
    if (this.closed) return;
    this.closed = true;
    const r = baseResponse(this.id, this.model, 'failed');
    r.error = { code: 'upstream_error', message: String(message || 'upstream error') };
    this.emit('response.failed', { response: r });
  }

  /** 处理一条 chat 流式 chunk */
  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return;
    if (chunk.usage) this.usage = chunk.usage;
    const choice = (chunk.choices && chunk.choices[0]) || null;
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) this.textDelta(delta.content);
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) this.toolDelta(tc);
    }
  }
}

module.exports = {
  toChatRequest,
  chatToResponses,
  StreamTranslator,
  buildMessages,
  buildTools
};
