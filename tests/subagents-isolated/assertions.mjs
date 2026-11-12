import assert from 'node:assert/strict';

export function assertIsolated(h) {
  assert.equal(h.workerProofs.length, 3);
  const workers = h.workerProofs.map(p => p.result).sort((a, b) => a.workerId.localeCompare(b.workerId));
  assert.equal(new Set(workers.map(w => w.nativeVm)).size, 3, 'Exactly three distinct worker native VMs');
  assert.equal(new Set(workers.map(w => w.sessionId)).size, 3, 'Three real Eve child sessions');
  for (const worker of workers) {
    assert.equal(worker.sandboxOwnerSessionId, worker.sessionId);
    assert.notEqual(worker.nativeVm, h.parentProof.result.nativeVm, 'Parent is not reading another VM');
    assert.equal(worker.marker, h.markers[worker.workerId]);
    assert.equal(worker.siblingProbes.length, 2);
    assert.ok(worker.siblingProbes.every(p => p.readable === false));
    const proof = h.workerProofs.find(p => p.result.workerId === worker.workerId);
    assert.equal(proof.peers.length, 3, 'All sibling files existed before probing');
    for (const peer of proof.peers) {
      assert.equal(peer.createdAndRead, true);
      assert.equal(peer.nativeVm, workers.find(w => w.workerId === peer.workerId).nativeVm);
    }
  }
  const returned = [...h.returned.workers].sort((a, b) => a.workerId.localeCompare(b.workerId));
  assert.equal(h.normalize(returned), h.normalize(workers), 'Exact worker tool outputs returned through Eve, not reconstructed from files');
  assert.equal(h.normalize(returned.map(w => w.clause)), h.normalize(h.expected));
  assert.deepEqual(h.parentProof.result.files, []);
  assert.ok(h.parentProof.result.probes.every(p => !p.readable));
  assert.equal(h.followupProof.result.parentCommandExitCode, 0);
  return { status: 'PASS', workerNativeVms: workers.map(w => w.nativeVm), parentNativeVm: h.parentProof.result.nativeVm,
    exactMarkersReturnedThroughEve: true, allSixSiblingProbesUnreadable: true,
    siblingFilesPositivelyEstablishedByBarrier: true, expectedExactlyMatched: true };
}
