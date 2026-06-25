// src/adapters/azure_openai.js
const axios = require('axios');

/**
 * Proxies OpenAI-style chat completions to Azure OpenAI.
 * Azure uses the same request format as OpenAI including response_format,
 * so structured outputs pass through unchanged.
 */
async function complete(backendConfig, requestBody) {
  const { endpoint, api_key, deployment, api_version } = backendConfig;

  if (requestBody.stream) throw new Error('Streaming not yet supported.');

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${api_version}`;

  const start = Date.now();
  const response = await axios.post(url, requestBody, {
    headers: {
      'api-key': api_key,
      'content-type': 'application/json'
    },
    timeout: 120000
  });

  const latency = Date.now() - start;
  const data = response.data;

  // Normalize to ensure consistent shape across API versions
  const normalized = {
    id: data.id,
    object: 'chat.completion',
    created: data.created,
    model: data.model,
    system_fingerprint: data.system_fingerprint ?? null,
    choices: (data.choices || []).map(c => ({
      index: c.index,
      message: {
        role: c.message?.role ?? 'assistant',
        content: c.message?.content ?? '',
        refusal: c.message?.refusal ?? null
      },
      logprobs: c.logprobs ?? null,
      finish_reason: c.finish_reason ?? 'stop'
    })),
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
      prompt_tokens_details: data.usage?.prompt_tokens_details ?? { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: data.usage?.completion_tokens_details ?? { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 }
    }
  };

  return { _raw: data, _latency: latency, normalized };
}

module.exports = { complete };
