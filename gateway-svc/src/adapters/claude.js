// src/adapters/claude.js
const axios = require('axios');

/**
 * Translates OpenAI-style chat completion request -> Claude Messages API
 * and maps the response back to a strict OpenAI-compatible format.
 */
async function complete(backendConfig, requestBody) {
  const { api_key, model, max_tokens = 4096 } = backendConfig;
  const { messages, temperature, max_tokens: reqMaxTokens, stream,
          top_p, frequency_penalty, presence_penalty, stop, n } = requestBody;

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
