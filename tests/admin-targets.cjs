'use strict';
// Inspect action resolution without opening applications or starting the server.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../server.cjs'), 'utf8');
const begin = source.indexOf('function resolveXamppAction(');
const end = source.indexOf('\nfunction assertAllowedXamppTarget', begin);
assert.ok(begin >= 0 && end > begin);
const context = vm.createContext({
  path, fs: { existsSync: () => true }, XAMPP_ROOT: 'C:\\xampp',
  XAMPP_ACTION_COMPONENTS: new Set(['apache', 'mysql', 'php']),
  getConfig: () => ({}), activeApacheRuntime: () => ({}), activeMySqlRuntime: () => ({}),
  componentPort: () => 8088
});
vm.runInContext(source.slice(begin, end), context);
assert.equal(context.resolveXamppAction('admin', 'apache').target, 'http://localhost:8088/');
assert.equal(context.resolveXamppAction('admin', 'mysql').target, 'http://localhost:8088/phpmyadmin/');
assert.throws(() => context.resolveXamppAction('admin', 'php'));
console.log('PASS: Admin actions follow the active Apache port and reject invalid components.');

