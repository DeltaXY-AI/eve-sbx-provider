import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clauseIds, markers, normalized, parseClause, type ClauseId } from './clauses';
import { ownership } from './ownership';

export function makeWorkerTool(assigned: ClauseId) {
  return defineTool({
    description: `Mechanically read inputs/${assigned}.txt, parse its exact ID/sentence, and write results/${assigned}.json. Also perform the fixed isolation probes. Call exactly once; return its complete JSON unchanged.`,
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const sandbox = await ctx.getSandbox();
      const input = await sandbox.readTextFile({ path: `inputs/${assigned}.txt` });
      if (input === null) throw new Error('Assigned input is missing');
      const clause = parseClause(input, assigned);
      const outputPath = `results/${assigned}.json`;
      await sandbox.writeTextFile({ path: outputPath, content: JSON.stringify(clause, null, 2) + '\n' });
      const artifactReadback = await sandbox.readTextFile({ path: outputPath });
      if (artifactReadback === null || normalized(JSON.parse(artifactReadback)) !== normalized(clause)) throw new Error('Worker artifact readback differs');
      const own = await ownership(sandbox);
      const isolated = process.env.SBX12_MODE === 'isolated';
      const marker = isolated ? markers[assigned] : null;
      const ownOnly = `private/${assigned}-only.txt`;
      if (isolated) {
        await sandbox.writeTextFile({ path: 'private/marker.txt', content: marker! });
        await sandbox.writeTextFile({ path: ownOnly, content: marker! });
        if (await sandbox.readTextFile({ path: 'private/marker.txt' }) !== marker ||
          await sandbox.readTextFile({ path: ownOnly }) !== marker) throw new Error('Own private marker readback failed');
      }
      // A test-only host barrier establishes that EVERY sibling has actually
      // created/read its own marker before negative visibility probes begin.
      // It is coordination/metadata only; clause results return through Eve.
      const parentId = ctx.session.parent?.sessionId;
      if (!parentId || !/^[a-zA-Z0-9_-]+$/.test(parentId)) throw new Error('Expected a real Eve parent session');
      const barrier = join(process.cwd(), '.sbx12-barrier', parentId);
      await mkdir(barrier, { recursive: true });
      const proof = { workerId: assigned, sessionId: ctx.session.id, ownerSessionId: own.ownerSessionId,
        nativeVm: own.nativeVm, markerPath: isolated ? ownOnly : outputPath, createdAndRead: true };
      const temporary = join(barrier, `${assigned}-${ctx.callId}.tmp`);
      await writeFile(temporary, JSON.stringify(proof)); await rename(temporary, join(barrier, `${assigned}.json`));
      const deadline = Date.now() + 120000;
      let peers: typeof proof[] = [];
      while (Date.now() < deadline) {
        ctx.abortSignal?.throwIfAborted();
        peers = await Promise.all(clauseIds.map(id => readFile(join(barrier, `${id}.json`), 'utf8').then(JSON.parse).catch(() => null)));
        if (peers.every(Boolean)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!peers.every(Boolean)) throw new Error('Three-worker marker barrier timed out');
      if (isolated && await sandbox.readTextFile({ path: 'private/marker.txt' }) !== marker) throw new Error('Own marker changed after all sibling writes');
      const siblingProbes: { workerId: string; path: string; readable: boolean }[] = [];
      if (isolated) for (const sibling of clauseIds.filter(id => id !== assigned)) {
        const path = `private/${sibling}-only.txt`;
        const readable = await sandbox.readTextFile({ path }) !== null;
        siblingProbes.push({ workerId: sibling, path, readable });
        if (readable) throw new Error('Sibling-only marker is visible from a private worker');
      }
      const result = { workerId: assigned, sessionId: ctx.session.id, sandboxOwnerSessionId: own.ownerSessionId,
        nativeVm: own.nativeVm, clause, marker, siblingProbes };
      console.log(JSON.stringify({ event: 'sbx12.worker', mode: process.env.SBX12_MODE, result, peers,
        outputPath, claimFile: own.claimFile, nativeInspect: own.inspect }));
      return result;
    },
  });
}
