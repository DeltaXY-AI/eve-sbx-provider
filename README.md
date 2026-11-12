# @deltaxy.ai/eve-sbx-provider

Use this package to connect an Eve app to Docker Sandboxes on the same computer.

The package uses the local `sbx` command. It does not install Docker Sandboxes or start its service.

> **Release status:** This package is not published to npm yet. The npm install command below will work after publication. You can install the local tarball for development.

## Requirements

The tested setup uses:

- Node.js 24.x.
- Eve `1.0.0-rc.6`.
- Docker Sandboxes CLI `sbx v0.51.0` and a working local service.
- Windows 11 x64.

Other systems have not been checked in the recorded tests.

## Install

After publication, install the package and Eve:

```powershell
npm install @deltaxy.ai/eve-sbx-provider eve@1.0.0-rc.6
```

To install a local package tarball:

```powershell
npm install "C:\path\to\deltaxy.ai-eve-sbx-provider-0.1.0.tgz" eve@1.0.0-rc.6
```

The computer that builds and runs the Eve app must have the `sbx` command and service.

## Set up an Eve app

Create `agent/sandbox.ts`:

```ts
import { defineSandbox } from "eve/sandbox";
import { SbxSandbox } from "@deltaxy.ai/eve-sbx-provider";

const environment = SbxSandbox.environment({
  namespace: "invoice-demo",
});

export default defineSandbox(() => environment.open());
```

Use a unique `namespace` for each app. Keep the same namespace when you restart the app. Keep the Eve storage directory if you need to resume existing sessions.

Build and start the Eve app on the computer that has `sbx`:

```powershell
npx eve build
npx eve start
```

The build prepares the sandbox image. Eve requests a sandbox VM when a session needs one. Installing or importing this package does not create a VM.

## Options

| Option | Required | Default | Description |
|---|---:|---|---|
| `namespace` | Yes | — | A unique, stable name for this app. |
| `baseImage` | No | `node:22-alpine` | The image used for new sandbox VMs. |
| `networkPolicy` | No | `deny-all` | Use `deny-all` or `allow-all`. |
| `poolSize` | No | `2` | Number of ready VMs to keep. Set to `0` to turn off the pool. |
| `sbxPath` | No | `sbx` | Name or path of the local `sbx` command. |
| `trace` | No | `false` | Set to `true` to log lifecycle events. Traces do not include command text or environment values. |

The default network policy is `deny-all`. Use `allow-all` only when the app needs runtime network access. You can set a policy for a new session with `environment.open({ networkPolicy: "allow-all" })`. This does not change an existing session.

A ready-VM pool uses extra computer resources. Set `poolSize` to `0` if you do not want the provider to keep ready VMs.

## Stop the app

Call `shutdownSbx()` from the app's graceful shutdown hook, after it stops accepting new requests:

```ts
import { shutdownSbx } from "@deltaxy.ai/eve-sbx-provider";

await shutdownSbx("invoice-demo");
```

This removes ready VMs that are not in use. It does not remove active session VMs or sandbox images.

## Security and limits

The provider sets a deny rule for network access by default. Some public-Internet and link-local checks are not complete. Do not treat this package as proof that all network access is blocked. Read [SECURITY.md](./SECURITY.md) before using the package with untrusted work.

This package is not a security certification. It does not guarantee protection from every VM escape, denial-of-service attack, or prompt-injection attack. Multiple serving processes that use the same app namespace and storage are not supported.

A forced stop can leave VMs behind. The provider does not remove all VMs when it starts. Do not remove a VM unless you can confirm that it belongs to your app and is not in use. Never use a global prune, reset, or wildcard cleanup command.

## License

Apache License, Version 2.0. See [LICENSE](./LICENSE).
