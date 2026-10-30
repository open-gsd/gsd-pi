import { once } from 'node:events';

// The native host includes its bounded drain/close budget in startup logs.
// Honor that contract; a shorter harness watchdog can bypass service.stop.
export async function stopIsolatedGateway(gateway, logs) {
  if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return;
  const budgets = [...logs.matchAll(/shutdown budget at startup:.*?shutdown=(\d+)ms/g)];
  const budgetMs = budgets.length ? Number(budgets.at(-1)[1]) + 5000 : 350_000;
  const exited = once(gateway, 'exit');
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    gateway.kill('SIGKILL');
  }, budgetMs);
  gateway.kill('SIGTERM');
  try {
    const [code, signal] = await exited;
    if (forced || code !== 0 || signal) {
      throw new Error(`Isolated Gateway did not shut down gracefully (code=${code}, signal=${signal}, watchdog=${budgetMs}ms)`);
    }
    return { code, signal, watchdogMs: budgetMs, forced: false };
  } finally { clearTimeout(timer); }
}
