// src/adapters/azure_openai.js
const axios = require('axios');

/**
 * Proxies OpenAI-style chat completions to Azure OpenAI.
 * Azure uses the same request/response format as OpenAI, so minimal translation needed.
 */
async function complete(backendConfig, requestBody) {
  const { endpoint, api_key, deployment, api_version } = backendConfig;
  const { stream } = requestBody;

  if (stream) throw new Error('Streaming not yet supported.');

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${api_version}`;

  // Pass through the request body, removing any gateway-specific fields
  const payload = { ...requestBody };

  const start = Date.now();
  const response = await axios.post(url, payload, {
    headers: {
      'api-key': api_key,
      'content-type': 'application/json'
    },
    timeout: 120000
  });

  const latency = Date.now() - start;
  const data = response.data;

  return {
    _raw: data,
    _latency: latency,
    normalized: data  // Azure OpenAI already returns OpenAI-compatible format
  };
}

module.exports = { complete };
