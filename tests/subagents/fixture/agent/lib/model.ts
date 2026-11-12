import { createOpenRouter } from '@openrouter/ai-sdk-provider';

// Real hosted model, used only for delegation/tool selection and returning the
// deterministic tool value. No scripted/fake language-model adapter is used.
export function fixtureModel() {
  return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })(process.env.SBX12_MODEL || 'openai/gpt-6-luna');
}
export const modelSettings = {
  reasoning: 'low' as const,
  modelContextWindowTokens: 1000000,
  experimental: { workflow: { retention: 'default' as const } },
};
