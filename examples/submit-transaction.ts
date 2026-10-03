import { boot } from './shared.js';

const { manager, account } = await boot();

try {
  const handle = await manager.submit({
    account,
    to: account,
    value: 0n,
    simulate: false,
  });
  console.log(handle.transactionId);
  console.log(handle.hash);

  const confirmed = await manager.waitForConfirmation(handle.transactionId);
  const report = await manager.reconcile(handle.transactionId);
  console.log(confirmed.status);
  console.log(report.status);
  console.log(report.outcome);
} finally {
  manager.close();
}
