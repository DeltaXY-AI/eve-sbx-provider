import { defineSandbox } from "eve/sandbox";
import { SbxSandbox } from "@deltaxy.ai/eve-sbx-provider";

export const environment = SbxSandbox.environment({
  namespace: "minimal-example",
  // baseImage: "node:22-alpine",
  // poolSize: 2,
  // sbxPath: "sbx",
  // trace: false,
});

export default defineSandbox(() => environment.open());
