// src/adapters/claude.js
const axios = require('axios');

/**
 * Translates OpenAI-style chat completion request -> Claude Messages API
 * Handles: tools/function calling, structured outputs, message history with tool results
 *
 * Tool translation:
 *   OpenAI tools[]:  { type:"function", function:{ name, description, parameters } }
 *   Claude tools[]:  { name, description, input_schema }
 *
 *   OpenAI tool_choice: "auto"|"none"|"required"|{ type:"function", function:{ name } }
 *   Claude tool_choice: { type:"auto"|"none"|"any" }|{ type:"tool", name }
 *
 *   OpenAI response: choices[0].message.tool_calls[]: { id, type:"function", function:{ name, arguments(string) } }
 *   Claude response: content[]: { type:"tool_use", id, name, input(object) }
 *
 *   OpenAI tool result message: { role:"tool", tool_call_id, content }
 *   Claude tool result message: { role:"user", content:[{ type:"tool_result", tool_use_id, content }] }
 */
async function complete(backendConfig, requestBody) {
  const { api_key, model, max_tokens = 4096 } = backendConfig;
  const { messages, temperature, max_tokens: reqMaxTokens, stream,
          top_p, stop, response_format, tools, tool_choice } = requestBody;

  if (stream) throw new Error('Streaming not yet supported.');

  // ── Translate messages ──────────────────────────────────────────────────────
  const systemMessages = messages.filter(m => m.role === 'system');
  const systemPrompt = systemMessages.map(m => m.content).join('\n') || undefined;

  // Convert all non-system messages, handling tool calls and tool results
  const claudeMessages = translateMessages(messages.filter(m => m.role !== 'system'));

  // ── Build payload ───────────────────────────────────────────────────────────
  const payload = {
    model: requestBody.model || model,
    max_tokens: reqMaxTokens || max_tokens,
    messages: claudeMessages,
    ...(systemPrompt && { system: systemPrompt }),
    ...(temperature !== undefined && { temperature }),
    ...(top_p !== undefined && { top_p }),
    ...(stop && { stop_sequences: Array.isArray(stop) ? stop : [stop] })
  };

  // ── Translate tools ─────────────────────────────────────────────────────────
  if (tools && tools.length > 0) {
    payload.tools = tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} }
    }));

    // Translate tool_choice
    if (tool_choice !== undefined) {
      payload.tool_choice = translateToolChoice(tool_choice);
    }
  }

  // ── Translate response_format (structured output) ───────────────────────────
  if (response_format && response_format.type !== 'text') {
    if (response_format.type === 'json_object') {
      payload.output_config = { format: { type: 'json_object' } };
    } else if (response_format.type === 'json_schema') {
      const schema = response_format.json_schema?.schema;
      if (!schema) throw new Error('response_format.json_schema.schema is required.');
      payload.output_config = { format: { type: 'json_schema', schema } };
    } else {
      throw new Error(`Unsupported response_format.type: "${response_format.type}".`);
    }
  }

  // ── Call Anthropic API ──────────────────────────────────────────────────────
  const start = Date.now();
  const response = await axios.post('https://api.anthropic.com/v1/messages', payload, {
    headers: {
      'x-api-key': api_key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 120000
  });

  const latency = Date.now() - start;
  const data = response.data;

  // ── Normalize response to OpenAI format ─────────────────────────────────────
  const normalized = normalizeResponse(data);
  return { _raw: data, _latency: latency, normalized };
}

// ── Message translation ───────────────────────────────────────────────────────

function translateMessages(messages) {
  const result = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // Assistant message may include tool_calls
      const content = [];

      // Text content
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }

      // Tool calls -> Claude tool_use blocks
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: safeParseJson(tc.function.arguments)
          });
        }
      }

      result.push({ role: 'assistant', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content });

    } else if (msg.role === 'tool') {
      // OpenAI tool result -> Claude tool_result block wrapped in user message
      // Group consecutive tool results into a single user message
      const last = result[result.length - 1];
      const toolResultBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      };

      if (last && last.role === 'user' && Array.isArray(last.content) && last._isToolResults) {
        last.content.push(toolResultBlock);
      } else {
        const userMsg = { role: 'user', content: [toolResultBlock], _isToolResults: true };
        result.push(userMsg);
      }

    } else {
      // Regular user message
      result.push({ role: 'user', content: msg.content });
    }
  }

  // Clean up internal marker before sending
  return result.map(({ _isToolResults, ...msg }) => msg);
}

function translateToolChoice(toolChoice) {
  if (toolChoice === 'auto')     return { type: 'auto' };
  if (toolChoice === 'none')     return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice === 'object' && toolChoice.function?.name) {
    return { type: 'tool', name: toolChoice.function.name };
  }
  return { type: 'auto' };
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return str; }
}

// ── Response normalization ────────────────────────────────────────────────────

function normalizeResponse(data) {
  const promptTokens = data.usage?.input_tokens || 0;
  const completionTokens = data.usage?.output_tokens || 0;

  // Check if response contains tool calls
  const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use');
  const textBlocks = (data.content || []).filter(b => b.type === 'text');
  const textContent = textBlocks.map(b => b.text).join('') || null;

  let message;
  if (toolUseBlocks.length > 0) {
    // Claude returned tool calls — translate to OpenAI format
    message = {
      role: 'assistant',
      content: textContent,
      refusal: null,
      tool_calls: toolUseBlocks.map(b => ({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input)  // OpenAI expects a JSON string
        }
      }))
    };
  } else {
    message = {
      role: 'assistant',
      content: textContent ?? '',
      refusal: null
    };
  }

  return {
    id: `chatcmpl-${data.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    system_fingerprint: null,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: mapFinishReason(data.stop_reason)
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 }
    }
  };
}

function mapFinishReason(stopReason) {
  const map = {
    'end_turn':      'stop',
    'max_tokens':    'length',
    'stop_sequence': 'stop',
    'tool_use':      'tool_calls'
  };
  return map[stopReason] ?? 'stop';
}

module.exports = { complete };
