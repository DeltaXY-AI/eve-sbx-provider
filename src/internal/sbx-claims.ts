import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const claimFile = (storagePath: string, namespace: string, sessionId: string) => join(storagePath,
  "docker-sandboxes-claims", hash(`${namespace}\0${sessionId}`));
export function validVmName(name: string, namespace?: string) {
  const match = /^eve-dsb-p-([0-9a-f]{8})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(name);
  return !!match && (namespace === undefined || match[1] === hash(namespace).slice(0, 8));
}
export const nameFor = (namespace: string, sessionId: string) =>
  `eve-dsb-${hash(`${namespace}\0${sessionId}`).slice(0, 32)}`;
export async function readClaim(file: string): Promise<string | undefined> {
  const deadline = Date.now() + 1000;
  for (;;) {
    let name: string;
    try { name = (await readFile(file, "utf8")).trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (name) {
      if (!validVmName(name) && !/^eve-dsb-[0-9a-f]{32}$/.test(name)) {
        throw new Error(`Invalid sandbox claim: ${file}`);
      }
      return name;
    }
    if (Date.now() >= deadline) throw new Error(`Empty sandbox claim: ${file}`);
    await delay(10);
  }
}
export async function claim(file: string, candidate: string): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  try { await writeFile(file, candidate, { flag: "wx" }); return candidate; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await readClaim(file);
    if (!owner) throw new Error(`Sandbox claim disappeared: ${file}`);
    return owner;
  }
}
