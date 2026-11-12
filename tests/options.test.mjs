import test from "node:test";
import assert from "node:assert/strict";
import { SbxSandbox } from "../dist/index.js";
import { validateOptions } from "../dist/internal/options.js";
import { claimFile, nameFor, validVmName } from "../dist/internal/sbx-claims.js";

test("documented defaults and pool-off option validate", () => {
  assert.deepEqual(validateOptions({ namespace: " demo " }), {
    namespace: "demo", baseImage: "node:22-alpine", networkPolicy: "deny-all", poolSize: 2, sbxPath: "sbx", trace: false,
  });
  assert.equal(validateOptions({ namespace: "demo", poolSize: 0 }).poolSize, 0);
  assert.equal(typeof SbxSandbox.environment({ namespace: "demo", poolSize: 0 }), "object");
});

test("namespace scopes claims and fallback identity even for identical session IDs", () => {
  assert.notEqual(claimFile("/store", "app-a", "same-session"), claimFile("/store", "app-b", "same-session"));
  assert.notEqual(nameFor("app-a", "same-session"), nameFor("app-b", "same-session"));
});

test("provider VM UUIDs validate against their namespace", () => {
  const name = "eve-dsb-p-6d0eaf4e-4bab04a2-983f-4a40-bdce-592fe8385268";
  assert.equal(validVmName(name, "sbx9-contract-5b7e668169cf"), true);
  assert.equal(validVmName(name, "another-namespace"), false);
  assert.equal(validVmName(name.slice(0, -1), "sbx9-contract-5b7e668169cf"), false);
});

test("invalid options reject synchronously before a CLI can be invoked", () => {
  const invalid = [
    [{}, /namespace/],
    [{ namespace: "  " }, /namespace/],
    [{ namespace: "demo", poolSize: -1 }, /poolSize/],
    [{ namespace: "demo", poolSize: 1.5 }, /poolSize/],
    [{ namespace: "demo", poolSize: "2" }, /poolSize/],
    [{ namespace: "demo", poolSize: Number.NaN }, /poolSize/],
    [{ namespace: "demo", baseImage: " " }, /baseImage/],
    [{ namespace: "demo", sbxPath: " " }, /sbxPath/],
    [{ namespace: "demo", trace: "yes" }, /trace/],
    [{ namespace: "demo", unexpected: true }, /Unknown/],
  ];
  for (const [options, message] of invalid) {
    assert.throws(() => SbxSandbox.environment(options), message);
  }
});
