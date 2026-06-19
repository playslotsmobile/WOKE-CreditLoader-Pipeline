// Daily reconciliation runner (invoked by cron). Confirms every recently
// loaded invoice is actually fully paid in QuickBooks; alerts the main group
// on any "loaded without paying" discrepancy. Exits 0 always so cron stays quiet.
const { reconcileLoadedVsPaid } = require('../src/services/reconcileService');

(async () => {
  try {
    const windowDays = process.argv[2] ? parseInt(process.argv[2], 10) : 21;
    const r = await reconcileLoadedVsPaid({ windowDays });
    console.log(`${new Date().toISOString()} reconcile: checked=${r.checked} paid=${r.paid} discrepancies=${r.discrepancies.length} newlyAlerted=${r.newlyAlerted}`);
  } catch (e) {
    console.error(`${new Date().toISOString()} reconcile FAILED: ${e.message}`);
  } finally {
    process.exit(0);
  }
})();
