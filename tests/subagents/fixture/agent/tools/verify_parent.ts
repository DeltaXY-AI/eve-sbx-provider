import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { clauseIds, normalized } from '../lib/clauses';
import { ownership } from '../lib/ownership';

export default defineTool({
  description: 'After delegate_three, mechanically verify the parent sandbox and its exact fixture artifacts. Also use this tool alone for a verification-only follow-up. A successful check ends the turn.',
  inputSchema: z.object({}),
  endsTurn: true,
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const own = await ownership(sandbox);
    if (own.ownerSessionId !== ctx.session.id) throw new Error('Parent must own its sandbox');
    const expected = JSON.parse((await sandbox.readTextFile({ path: 'expected.json' }))!);
    const listing = await sandbox.run({ command: `node -e 'const fs=require("node:fs");console.log(JSON.stringify(fs.existsSync("results")?fs.readdirSync("results").sort():[]))'` });
    if (listing.exitCode !== 0) throw new Error('Cannot enumerate fixture artifacts');
    const files = JSON.parse(listing.stdout) as string[];
    const actual = [];
    const probes = [];
    if (process.env.SBX12_MODE === 'shared') {
      if (normalized(files) !== normalized(clauseIds.map(id => `${id}.json`))) throw new Error('Expected exactly three distinct output files');
      for (const id of clauseIds) actual.push(JSON.parse((await sandbox.readTextFile({ path: `results/${id}.json` }))!));
      if (normalized(actual) !== normalized(expected)) throw new Error('Shared JSON artifacts differ from checked-in expectations');
    } else {
      if (files.length) throw new Error('Private worker result files are visible in parent');
      for (const path of ['private/marker.txt', ...clauseIds.map(id => `private/${id}-only.txt`), ...clauseIds.map(id => `results/${id}.json`)]) {
        const readable = await sandbox.readTextFile({ path }) !== null;
        probes.push({ path, readable });
        if (readable) throw new Error('Isolated worker files must not be visible to parent');
      }
    }
    const path = 'parent-still-usable.txt', marker = `${process.env.SBX12_RUN}-parent-survives`;
    const existing = await sandbox.readTextFile({ path });
    if (existing !== null && existing !== marker) throw new Error('Parent marker was changed');
    if (existing === null) await sandbox.writeTextFile({ path, content: marker });
    const command = await sandbox.run({ command: 'cat /workspace/parent-still-usable.txt' });
    if (command.exitCode !== 0 || command.stdout !== marker) throw new Error('Parent sandbox command failed after delegation');
    const result = { mode: process.env.SBX12_MODE, sessionId: ctx.session.id, sandboxOwnerSessionId: own.ownerSessionId,
      nativeVm: own.nativeVm, expected, actual, files, probes, parentMarker: marker, parentCommandExitCode: command.exitCode };
    console.log(JSON.stringify({ event: 'sbx12.parent', result, claimFile: own.claimFile, nativeInspect: own.inspect }));
    return result;
  },
});
