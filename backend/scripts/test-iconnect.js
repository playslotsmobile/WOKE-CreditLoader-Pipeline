// Quick test script for IConnect credit loading
// Tests loading 1 credit to tonyslounge2018@gmail.com

require('dotenv').config();

const iconnect = require('./src/services/iconnect');

async function testLoad() {
  console.log('=== IConnect Load Test ===');
  console.log('Target: tonyslounge2018@gmail.com');
  console.log('Credits: 1 (minimal test amount)');
  console.log('');

  const account = {
    username: 'tonyslounge2018@gmail.com',
  };

  try {
    const result = await iconnect.loadCredits(account, 1);
    console.log('');
    console.log('=== Result ===');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Test failed:', err.message);
  }

  process.exit(0);
}

testLoad();

