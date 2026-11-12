import { defineHook } from 'eve/hooks';
export default defineHook({ events: {
  'session.started'(_event, ctx) {
    console.log(JSON.stringify({ event: 'sbx12.session.started', mode: process.env.SBX12_MODE,
      sessionId: ctx.session.id, parent: ctx.session.parent ?? null }));
  },
  'session.ended'(event, ctx) {
    // Never open a sandbox from an end hook: doing so could resurrect it.
    console.log(JSON.stringify({ event: 'sbx12.session.ended', mode: process.env.SBX12_MODE,
      sessionId: ctx.session.id, parent: ctx.session.parent ?? null, outcome: event.data.outcome }));
  },
} });
