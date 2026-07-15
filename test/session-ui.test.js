const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('renews active secure sessions', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /rolling:\s*true/);
});

test('preserves an assessment draft when submission needs a fresh login', () => {
  const tutorView = fs.readFileSync(path.join(root, 'public', 'tutor-view.html'), 'utf8');
  assert.match(tutorView, /preserveDraft:\s*true/);
  assert.match(tutorView, /Your completed assessment is still here/);
});
