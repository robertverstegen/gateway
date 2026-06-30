// src/adapters/index.js
const claude = require('./claude');
const azure_openai = require('./azure_openai');
const mistral = require('./mistral');

const adapters = {
  claude,
  azure_openai,
  mistral
};

function getAdapter(type) {
  const adapter = adapters[type];
  if (!adapter) throw new Error(`Unknown backend type: "${type}". Available: ${Object.keys(adapters).join(', ')}`);
  return adapter;
}

function getAvailableTypes() {
  return Object.keys(adapters);
}

module.exports = { getAdapter, getAvailableTypes };
