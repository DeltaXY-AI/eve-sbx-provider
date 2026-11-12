// Actual compiled Eve/Nitro server; IPC only requests graceful process shutdown.
process.on('message', async message => {
  if (message !== 'shutdown') return;
  const watchdog = setTimeout(() => process.exit(1), 30000);
  try {
    await Promise.all(process.listeners('SIGTERM').map(handler => handler.call(process, 'SIGTERM')));
    clearTimeout(watchdog); process.disconnect(); process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
});
await import(process.env.SBX12_SERVER_ENTRY);
