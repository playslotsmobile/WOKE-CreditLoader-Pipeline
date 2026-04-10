// Test the full vendor → operator chain load
// Master → Ltorres1979 (Vendor 1288) → CTrejo (Operator 1868)
// Loads 1 credit to each

require('dotenv').config();

const play777 = require('./src/services/play777');

async function testChainLoad() {
  const vendor = {
    username: 'Ltorres1979',
    operatorId: '1288',
  };

  const operator = {
    username: 'CTrejo',
    operatorId: '1868',
  };

  // Step 1: Load vendor
  console.log('=== Step 1: Load Vendor ===');
  console.log(`Target: ${vendor.username} (Vendor ${vendor.operatorId})`);
  console.log('Credits: 1\n');

  const vendorResult = await play777.loadCredits(vendor, 1);
  console.log('\nVendor result:', JSON.stringify(vendorResult, null, 2));

  if (!vendorResult.success) {
    console.log('\nVendor load failed — skipping operator.');
    process.exit(1);
  }

  // Step 2: Load operator (under the vendor)
  console.log('\n=== Step 2: Load Operator ===');
  console.log(`Target: ${operator.username} (Operator ${operator.operatorId})`);
  console.log(`Under: ${vendor.username} (Vendor ${vendor.operatorId})`);
  console.log('Credits: 1\n');

  const operatorResult = await play777.loadCredits(operator, 1, vendor);
  console.log('\nOperator result:', JSON.stringify(operatorResult, null, 2));

  console.log('\n=== Chain Load Complete ===');
  process.exit(0);
}

testChainLoad();
