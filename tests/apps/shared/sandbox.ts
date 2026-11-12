import { defineSandbox } from 'eve/sandbox';
import { SbxSandbox } from '@deltaxy.ai/eve-sbx-provider';

export const environment = SbxSandbox.environment({
  namespace: process.env.SBX10_NAMESPACE!, poolSize: 1, trace: true,
});
export default defineSandbox(() => {
  // The public Eve API generates session IDs. During the supervisor's initial
  // quiescent-store bootstrap, leave the selector unsatisfied so no native VM
  // identity is copied to the other independent app. Normal starts retry it.
  if (process.env.SBX10_BOOTSTRAP === '1') throw new Error('SBX10 bootstrap: sandbox opening intentionally deferred');
  return environment.open();
});
