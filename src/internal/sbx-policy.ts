import { SandboxSessionGoneError } from "eve/sandbox/provider";
import { runSbx } from "./sbx-cli.js";
import type { SbxNetworkPolicy } from "./options.js";

export async function assertNoHostMounts(name: string, executable: string) {
  const result = await runSbx(["inspect", name, "--json"], undefined, executable);
  if (result.exitCode !== 0) {
    if (result.stderr.split(/\r?\n/).some(line => line.trim() === `error: sandbox '${name}' not found`)) {
      throw new SandboxSessionGoneError("Session sandbox is gone.");
    }
    throw new Error(`Sandbox mount inspection failed (${result.exitCode})`);
  }
  let info;
  try { info = JSON.parse(result.stdout); } catch { throw new Error("Invalid sandbox mount inspection response"); }
  if (!Array.isArray(info.host_mounts) || !Array.isArray(info.runtime_mounts) ||
    info.host_mounts.length || info.runtime_mounts.length) {
    throw new Error("SbxSandbox refuses native host/runtime filesystem mounts");
  }
}

/** Read only. Never rewrites policy on an existing claimed VM. */
export async function readVmNetworkPolicy(name: string, executable: string): Promise<SbxNetworkPolicy> {
  const result = await runSbx(["policy", "ls", name, "--json"], undefined, executable);
  if (result.exitCode !== 0) {
    if (result.stderr.split(/\r?\n/).some(line => line.trim() === `error: sandbox '${name}' not found`)) {
      throw new SandboxSessionGoneError("Session sandbox is gone.");
    }
    throw new Error(`Sandbox network policy inspection failed (${result.exitCode})`);
  }
  let rules;
  try { rules = JSON.parse(result.stdout).rules; } catch { throw new Error("Invalid sandbox policy response"); }
  if (!Array.isArray(rules)) throw new Error("Invalid sandbox policy rules");
  const wildcard = rules.filter(rule => rule.sandbox_id === name && rule.scope === `sandbox:${name}` &&
    rule.status === "active" && rule.resource_type === "network" && rule.resources?.includes("**") &&
    rule.actions?.includes("net:connect:tcp") && rule.actions?.includes("net:connect:udp"));
  if (wildcard.some(rule => rule.decision === "deny")) return "deny-all";
  if (wildcard.some(rule => rule.decision === "allow")) return "allow-all";
  // Old pre-security VMs must not be silently described as runtime deny-all.
  throw new Error("Sandbox has no verified provider network policy; end this legacy session and create a new one");
}
