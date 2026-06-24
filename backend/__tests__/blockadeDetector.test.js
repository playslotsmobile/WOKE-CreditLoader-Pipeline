// Standalone classifier checks for blockadeDetector. Run: node __tests__/blockadeDetector.test.js
const { classify } = require('../src/services/blockadeDetector');

const cases = [
  // [input, expectedType-or-null]
  ['BLOCKADE:PHONE_VERIFICATION: Phone verification modal on vendors page', 'PHONE_VERIFICATION'],
  ['PHONE_VERIFICATION_REQUIRED: Master715 depleted or session needs phone re-verification', 'PHONE_VERIFICATION'],
  ['Update Your Contact — please update your phone number below', 'PHONE_VERIFICATION'],
  ['Sorry, you have been blocked — You are unable to access play777games.com', 'CF_BLOCK'],
  ['Attention Required! | Cloudflare', 'CF_BLOCK'],
  ['Please verify your email before continuing', 'EMAIL_VERIFICATION'],
  ['Press and Hold to verify you are human', 'CAPTCHA'],
  ['Login failed — still on login page', 'LOGIN_REQUIRED'],
  // Transient / non-blockade — MUST stay null so normal retry runs:
  ['Rate limit: 3 browser launches in 10min window. Wait 333s before retrying.', null],
  ['Network service crashed, restarting service', null],
  ['Vendor M12345 (1112) not found on vendors page', null],
  ['Vendors table did not load after 2 attempts', null],
  ['ECONNRESET socket hang up', null],
  ['', null],
];

let pass = 0;
let fail = 0;
for (const [input, expected] of cases) {
  const got = classify(input);
  const gotType = got ? got.type : null;
  const ok = gotType === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  expected=${expected}  got=${gotType}  | ${input.slice(0, 60)}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${cases.length} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
