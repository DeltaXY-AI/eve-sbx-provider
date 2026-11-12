import test from 'node:test';
import assert from 'node:assert/strict';
import { SbxSandbox } from '../../dist/index.js';
import { validateOptions, openNetworkPolicy } from '../../dist/internal/options.js';
import { createSbxEnvironment } from '../../dist/internal/sbx-sandbox.js';
import { poolFor, disposePools } from '../../dist/internal/sbx-pool.js';

test('runtime policy is deny-all unless explicitly allow-all; no unsupported shape is weakened', async () => {
  assert.equal(validateOptions({ namespace: 'policy-test' }).networkPolicy, 'deny-all');
  assert.equal(validateOptions({ namespace: 'policy-test', networkPolicy: 'allow-all' }).networkPolicy, 'allow-all');
  for (const invalid of [null, '', false, 'balanced', 'ALLOW-ALL', [], { allow: ['example.com'] }]) {
    assert.throws(() => SbxSandbox.environment({ namespace: 'policy-test', networkPolicy: invalid }), /networkPolicy/);
    const env = createSbxEnvironment(validateOptions({ namespace: 'policy-test' }));
    // Invalid input fails before ctx access, artifact checks, storage, VM or CLI.
    await assert.rejects(() => env.start(null, { networkPolicy: invalid }, null), /networkPolicy/);
  }
  assert.equal(openNetworkPolicy({}, 'deny-all'), 'deny-all');
  assert.equal(openNetworkPolicy({ networkPolicy: 'allow-all' }, 'deny-all'), 'allow-all');
  assert.throws(() => openNetworkPolicy({ egress: 'allow-all' }, 'deny-all'), /networkPolicy/);
});

test('ready pools partition by effective network policy, not by session identity', async () => {
  const options = validateOptions({ namespace: 'policy-partition', poolSize: 0 });
  const deny = poolFor('eve-dsb-tpl:unit-test', options);
  const allow = poolFor('eve-dsb-tpl:unit-test', { ...options, networkPolicy: 'allow-all' });
  assert.notEqual(deny, allow);
  assert.equal(poolFor('eve-dsb-tpl:unit-test', options), deny);
  assert.equal(deny.diagnostics().networkPolicy, 'deny-all');
  assert.equal(allow.diagnostics().networkPolicy, 'allow-all');
  await disposePools(options.namespace);
});
