# Minimal Eve app example

This example shows how to connect an Eve app to Docker Sandboxes.

You need Node.js 24, Eve `1.0.0-rc.6`, and a working local `sbx` service.

1. Install the example dependencies:

   ```powershell
   npm install
   ```

2. Copy `agent/sandbox.ts` into your Eve app.
3. Set `namespace` to a unique, stable name for your app.
4. Build and start the app on the computer that has `sbx`:

   ```powershell
   npx eve build
   npx eve start
   ```

The build prepares the sandbox image. Eve requests a sandbox VM when a session needs one.
