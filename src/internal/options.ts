export type SbxNetworkPolicy = "deny-all" | "allow-all";
export interface SbxOpenOptions {
  /** Applies only when creating a new session VM. Domain lists are not supported. */
  readonly networkPolicy?: SbxNetworkPolicy;
}
export function validateNetworkPolicy(value: unknown): SbxNetworkPolicy {
  if (value === "deny-all" || value === "allow-all") return value;
  throw new TypeError("SbxSandbox networkPolicy supports only deny-all or allow-all");
}
export function openNetworkPolicy(value: unknown, fallback: SbxNetworkPolicy): SbxNetworkPolicy {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => key !== "networkPolicy")) {
    throw new TypeError("SbxSandbox.open() accepts only the networkPolicy option");
  }
  const policy = (value as SbxOpenOptions).networkPolicy;
  return policy === undefined ? fallback : validateNetworkPolicy(policy);
}
export interface SbxSandboxOptions {
  /** Stable application identity. Required to scope claims and owned resources. */
  readonly namespace: string;
  /** Guest base image used when Eve prepares a template. Defaults to node:22-alpine. */
  readonly baseImage?: string;
  /** Runtime egress default. Defaults to deny-all; allow-all is an explicit opt-out. */
  readonly networkPolicy?: SbxNetworkPolicy;
  /** Number of ready VMs to keep for this namespace and template. Defaults to 2; zero disables the pool. */
  readonly poolSize?: number;
  /** Executable path or command used to invoke the local sbx CLI. Defaults to sbx. */
  readonly sbxPath?: string;
  /** Opt in to metadata-only provider traces. Defaults to false. */
  readonly trace?: boolean;
}

export interface SbxRuntimeOptions {
  readonly namespace: string;
  readonly baseImage: string;
  readonly networkPolicy: SbxNetworkPolicy;
  readonly poolSize: number;
  readonly sbxPath: string;
  readonly trace: boolean;
}

export function validateOptions(options: SbxSandboxOptions): SbxRuntimeOptions {
  if (!options || typeof options !== "object") throw new TypeError("SbxSandbox.environment() requires an options object");
  if (typeof options.namespace !== "string" || options.namespace.trim().length === 0) {
    throw new TypeError("SbxSandbox namespace must be a nonempty string");
  }
  const poolSize = options.poolSize ?? 2;
  if (typeof poolSize !== "number" || !Number.isSafeInteger(poolSize) || poolSize < 0) {
    throw new TypeError("SbxSandbox poolSize must be a nonnegative integer (zero disables the warm pool)");
  }
  const baseImage = options.baseImage ?? "node:22-alpine";
  if (typeof baseImage !== "string" || !baseImage.trim()) {
    throw new TypeError("SbxSandbox baseImage must be a nonempty string");
  }
  const sbxPath = options.sbxPath ?? "sbx";
  if (typeof sbxPath !== "string" || !sbxPath.trim()) {
    throw new TypeError("SbxSandbox sbxPath must be a nonempty executable path or command");
  }
  if (options.trace !== undefined && typeof options.trace !== "boolean") {
    throw new TypeError("SbxSandbox trace must be a boolean");
  }
  const networkPolicy = options.networkPolicy === undefined ? "deny-all" : validateNetworkPolicy(options.networkPolicy);
  const allowed = new Set(["namespace", "baseImage", "networkPolicy", "poolSize", "sbxPath", "trace"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown SbxSandbox option: ${key}`);
  }
  return { namespace: options.namespace.trim(), baseImage: baseImage.trim(), networkPolicy, poolSize,
    sbxPath: sbxPath.trim(), trace: options.trace ?? false };
}
