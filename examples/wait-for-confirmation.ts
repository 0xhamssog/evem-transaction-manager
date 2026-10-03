import { boot } from './shared.js';

const transactionId = process.env.TRANSACTION_ID;
const { manager, account } = await boot();

try {
  const id =
    transactionId ??
    (
      await manager.submit({
        account,
        to: account,
        value: 0n,
        simulate: false,
      })
    ).transactionId;

  const confirmed = await manager.waitForConfirmation(id);
  console.log(confirmed.status);
  console.log(confirmed.confirmations);
  console.log(confirmed.blockNumber?.toString() ?? '');
  console.log(confirmed.blockHash ?? '');
  console.log(confirmed.transactionIndex ?? '');

  const report = await manager.reconcile(id);
  console.log(report.outcome);
  console.log(manager.getStatus(id).status);
} finally {
  manager.close();
}
