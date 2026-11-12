// Real compiled Nitro/Eve server in its own process. IPC only controls shutdown;
// all session operations travel through the authenticated Eve HTTP API.
process.on('message', async message => {
  if (message !== 'shutdown') return;
  const watchdog = setTimeout(() => process.exit(1), 30000);
  try {
    // Await Nitro/Eve's actual graceful signal handlers. Emitting a synthetic
    // signal alone does not await async handlers or terminate local-world timers.
    await Promise.all(process.listeners('SIGTERM').map(handler => handler.call(process, 'SIGTERM')));
    clearTimeout(watchdog);
    process.disconnect();
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
});
await import(process.env.SBX10_SERVER_ENTRY);
