// Quick test script for Play777 credit loading
// Tests loading credits to Tonydist (Vendor 715)

require('dotenv').config();

const play777 = require('./src/services/play777');

async function testLoad() {
  console.log('=== Play777 Load Test ===');
  console.log('Target: Tonydist (Vendor 715)');
  console.log('Credits: 1 (minimal test amount)');
  console.log('');

  const account = {
    username: 'Tonydist',
    operatorId: '715',
    loadType: 'vendor',
    parentOperatorId: null,
  };

  const credits = 1;

  try {
    const result = await play777.loadCredits(account, credits);
    console.log('');
    console.log('=== Result ===');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Test failed:', err.message);
  }

  process.exit(0);
}

testLoad();
