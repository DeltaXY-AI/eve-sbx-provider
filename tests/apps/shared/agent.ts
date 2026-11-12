import { defineAgent } from 'eve';

// No paid model calls: the probe hook exercises ctx.getSandbox(), then cancels
// the turn before model execution. Any accidental model call fails loudly.
export default defineAgent({
  model: {
    specificationVersion: 'v3', provider: 'sbx10-fixture', modelId: 'never-called',
    supportedUrls: {},
    async doGenerate() { throw new Error('SBX10 fixture must not call a model'); },
    async doStream() { throw new Error('SBX10 fixture must not call a model'); },
  },
  modelContextWindowTokens: 32000,
  experimental: { workflow: { retention: 'default' } },
});
