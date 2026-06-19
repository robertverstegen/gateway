// src/adapters/claude.js
const axios = require('axios');

/**
 * Translates OpenAI-style chat completion request -> Claude Messages API
 * and maps the response back to OpenAI format.
 */
async function complete(backendConfig, requestBody) {
  const { api_key, model, max_tokens = 4096 } = backendConfig;
  const { messages, temperature, max_tokens: reqMaxTokens, stream } = requestBody;

  if (stream) throw new Error('Streaming not yet supported.');

  // Extract system message if present
  const systemMessages = messages.filter(m => m.role === 'system');
  const userMessages = messages.filter(m => m.role !== 'system');
  const systemPrompt = systemMessages.map(m => m.content).join('\n') || undefined;

  // Map roles: OpenAI uses 'assistant', Claude uses 'assistant' — compatible
  const claudeMessages = userMessages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  const payload = {
    model: requestBody.model || model,
    max_tokens: reqMaxTokens || max_tokens,
    messages: claudeMessages,
    ...(systemPrompt && { system: systemPrompt }),
    ...(temperature !== undefined && { temperature })
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

  // Normalize to OpenAI format
  return {
    _raw: data,
    _latency: latency,
    normalized: {
      id: data.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: data.content?.[0]?.text || ''
        },
        finish_reason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason
      }],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      }
    }
  };
}

module.exports = { complete };
