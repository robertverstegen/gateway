// src/adapters/claude.js
const axios = require('axios');

/**
 * Translates OpenAI-style chat completion request -> Claude Messages API
 * and maps the response back to a strict OpenAI-compatible format.
 *
 * Structured output translation:
 *   OpenAI:  response_format: { type: "json_schema", json_schema: { name, schema, strict } }
 *   Claude:  output_config: { format: { type: "json_schema", schema: { ... } } }
 *            + anthropic-beta: structured-outputs-2025-11-13
 */
async function complete(backendConfig, requestBody) {
  const { api_key, model, max_tokens = 4096 } = backendConfig;
  const { messages, temperature, max_tokens: reqMaxTokens, stream,
          top_p, stop, response_format } = requestBody;

  if (stream) throw new Error('Streaming not yet supported.');

  // Separate system messages from conversation
  const systemMessages = messages.filter(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');
  const systemPrompt = systemMessages.map(m => m.content).join('\n') || undefined;

  const claudeMessages = conversationMessages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  const payload = {
    model: requestBody.model || model,
    max_tokens: reqMaxTokens || max_tokens,
    messages: claudeMessages,
    ...(systemPrompt && { system: systemPrompt }),
    ...(temperature !== undefined && { temperature }),
    ...(top_p !== undefined && { top_p }),
    ...(stop && { stop_sequences: Array.isArray(stop) ? stop : [stop] })
  };

  // Translate OpenAI response_format -> Claude output_config
  const extraHeaders = {};
  if (response_format) {
    if (response_format.type === 'json_object') {
      // Simple JSON mode — Claude supports this via output_config
      payload.output_config = { format: { type: 'json_object' } };
      extraHeaders['anthropic-beta'] = 'structured-outputs-2025-11-13';
    } else if (response_format.type === 'json_schema') {
      const schema = response_format.json_schema?.schema;
      if (!schema) throw new Error('response_format.json_schema.schema is required for type "json_schema".');
      payload.output_config = {
        format: {
          type: 'json_schema',
          schema
        }
      };
      extraHeaders['anthropic-beta'] = 'structured-outputs-2025-11-13';
    } else if (response_format.type !== 'text') {
      throw new Error(`Unsupported response_format.type: "${response_format.type}". Supported: "text", "json_object", "json_schema".`);
    }
  }

  const start = Date.now();
  const response = await axios.post('https://api.anthropic.com/v1/messages', payload, {
    headers: {
      'x-api-key': api_key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      ...extraHeaders
    },
    timeout: 120000
  });

  const latency = Date.now() - start;
  const data = response.data;

  const promptTokens = data.usage?.input_tokens || 0;
  const completionTokens = data.usage?.output_tokens || 0;

  // Strict OpenAI chat.completion format
  const normalized = {
    id: `chatcmpl-${data.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    system_fingerprint: null,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: data.content?.[0]?.text ?? '',
        refusal: null
      },
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

  return { _raw: data, _latency: latency, normalized };
}

function mapFinishReason(stopReason) {
  const map = {
    'end_turn': 'stop',
    'max_tokens': 'length',
    'stop_sequence': 'stop',
    'tool_use': 'tool_calls'
  };
  return map[stopReason] ?? 'stop';
}

module.exports = { complete };
