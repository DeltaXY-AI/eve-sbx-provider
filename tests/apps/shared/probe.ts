import { defineHook } from 'eve/hooks';

export default defineHook({
  events: {
    async 'turn.started'(_event, ctx) {
      const sandbox = await ctx.getSandbox();
      const path = 'ownership-marker.txt';
      let marker = await sandbox.readTextFile({ path });
      if (marker === null) {
        marker = process.env.SBX10_MARKER!;
        await sandbox.writeTextFile({ path, content: marker });
      }
      const command = await sandbox.run({ command: 'cat /workspace/ownership-marker.txt' });
      if (command.exitCode !== 0 || command.stdout !== marker) throw new Error('Native marker check failed');
      console.log(JSON.stringify({ event: 'fixture.probe', app: process.env.SBX10_APP,
        namespace: process.env.SBX10_NAMESPACE, hostPid: process.pid,
        sessionId: ctx.session.id, marker, command }));
      ctx.cancel('Deterministic SBX-10 probe complete; no model call required');
    },
  },
});
