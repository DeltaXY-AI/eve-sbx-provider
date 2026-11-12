import assert from 'node:assert/strict';

export function assertShared(h) {
  assert.equal(h.workerProofs.length, 3, 'Exactly three worker tool executions');
  assert.equal(new Set(h.workerProofs.map(p => p.result.sessionId)).size, 3, 'Three actual Eve child sessions');
  const all = [h.parentProof.result, ...h.workerProofs.map(p => p.result)];
  assert.equal(new Set(all.map(p => p.nativeVm)).size, 1, 'Parent and all workers must use one native VM');
  for (const proof of all) assert.equal(proof.sandboxOwnerSessionId, h.session.id, 'Shared sandbox belongs to parent session');
  assert.equal(h.normalize(h.parentProof.result.actual), h.normalize(h.expected));
  assert.deepEqual(h.parentProof.result.files, h.expected.map(x => `${x.id}.json`));
  const workerResults = h.returned.workers.map(w => w.clause).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(h.normalize(workerResults), h.normalize(h.expected));
  assert.equal(new Set(h.workerProofs.map(p => p.outputPath)).size, 3, 'No output path collision');
  assert.equal(h.followupProof.result.nativeVm, h.parentProof.result.nativeVm);
  assert.equal(h.normalize(h.followupProof.result.actual), h.normalize(h.expected));
  assert.equal(h.followupProof.result.parentCommandExitCode, 0, 'Parent still executes commands after all child session ends');
  return { status: 'PASS', sharedNativeVm: all[0].nativeVm, sandboxOwnerSessionId: h.session.id,
    artifacts: h.parentProof.result.actual, files: h.parentProof.result.files,
    parentUsableAfterThreeChildEnds: true, expectedExactlyMatched: true };
}
