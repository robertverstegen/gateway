// src/adapters/mistral.js
const axios = require('axios');

/**
 * Proxies OpenAI-style chat completions to the Mistral API.
 *
 * Mistral's /v1/chat/completions endpoint is near-fully OpenAI-compatible:
 *   - messages, temperature, top_p, max_tokens, stop, n, presence_penalty,
 *     frequency_penalty all pass through unchanged
 *   - tools / tool_choice use the same shape as OpenAI (type:"function",
 *     function:{ name, description, parameters }) — no translation needed
 *   - response_format supports "text" | "json_object" | "json_schema" with
 *     the same { json_schema: { name, schema, strict } } structure as OpenAI
 *
 * The only normalization needed is on the response side: Mistral's
 * tool_calls[].function.arguments has been observed both as a JSON string
 * (matching OpenAI) and as a raw object depending on API version, so we
 * normalize it to always be a string to guarantee consistent gateway output.
 */
async function complete(backendConfig, requestBody) {
  const { api_key, model } = backendConfig;

  if (requestBody.stream) throw new Error('Streaming not yet supported.');

  const payload = {
    ...requestBody,
    model: requestBody.model || model
  };

  const start = Date.now();
  const response = await axios.post('https://api.mistral.ai/v1/chat/completions', payload, {
    headers: {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json'
    },
    timeout: 120000
  });

  const latency = Date.now() - start;
  const data = response.data;

  const normalized = {
    id: data.id,
    object: 'chat.completion',
    created: typeof data.created === 'string' ? parseInt(data.created, 10) : data.created,
    model: data.model,
    system_fingerprint: data.system_fingerprint ?? null,
    choices: (data.choices || []).map(c => ({
      index: c.index,
      message: {
        role: c.message?.role ?? 'assistant',
        content: c.message?.content ?? null,
        refusal: c.message?.refusal ?? null,
        ...(c.message?.tool_calls && {
          tool_calls: c.message.tool_calls.map(tc => ({
            id: tc.id,
            type: tc.type || 'function',
            function: {
              name: tc.function.name,
              // Normalize to a JSON string regardless of what Mistral returned
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments)
            }
          }))
        })
      },
      logprobs: c.logprobs ?? null,
      finish_reason: c.finish_reason ?? 'stop'
    })),
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 }
    }
  };

  return { _raw: data, _latency: latency, normalized };
}

module.exports = { complete };
