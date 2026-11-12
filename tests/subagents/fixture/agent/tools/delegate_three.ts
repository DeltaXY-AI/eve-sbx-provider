import { defineWorkflowTool } from 'eve/tools';
import { z } from 'zod';

const workerResultSchema = {
  type: 'object', additionalProperties: false,
  required: ['workerId', 'sessionId', 'sandboxOwnerSessionId', 'nativeVm', 'clause', 'marker', 'siblingProbes'],
  properties: {
    workerId: { type: 'string' }, sessionId: { type: 'string' }, sandboxOwnerSessionId: { type: 'string' }, nativeVm: { type: 'string' },
    clause: { type: 'object', additionalProperties: false, required: ['id', 'sentence'], properties: { id: { type: 'string' }, sentence: { type: 'string' } } },
    marker: { type: ['string', 'null'] },
    siblingProbes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['workerId', 'path', 'readable'],
      properties: { workerId: { type: 'string' }, path: { type: 'string' }, readable: { type: 'boolean' } } } },
  },
};

export default defineWorkflowTool({
  description: 'Delegate the fixed fixture to exactly three declared workers through Eve, concurrently. Call exactly once for the initial job, then call verify_parent. Do not perform extraction yourself.',
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    'use workflow';
    const results = await Promise.all([
      run('worker_001', 'clause-001'), run('worker_002', 'clause-002'), run('worker_003', 'clause-003'),
    ]);
    return { workers: results };

    async function run(name: string, clauseId: string) {
      const response = await ctx.agent(name).send(
        `Process only ${clauseId}. Call process_fixture once with {}. Do not read/write using any other tool. Return the complete tool JSON exactly as your structured result, without changing any values.`,
        { outputSchema: workerResultSchema, signal: ctx.abortSignal },
      );
      const result = await response.result();
      if (result.status !== 'completed' || !result.data) throw new Error(`${name} did not return its structured fixture result`);
      return result.data;
    }
  },
});
