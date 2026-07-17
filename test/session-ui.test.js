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

test('loads tutor assignments without one request per historical sheet row', () => {
  const tutorView = fs.readFileSync(path.join(root, 'public', 'tutor-view.html'), 'utf8');
  assert.match(tutorView, /has_assessment/);
  assert.match(tutorView, /st === 'New' && !hasAssessment/);
  assert.doesNotMatch(tutorView, /st === 'New' && !a\b/);
  assert.doesNotMatch(tutorView, /const assessmentPromises = entries\.map/);
});

test('renders the Google Sheet sync timestamp as the ISO timestamp returned by the server', () => {
  const dashboard = fs.readFileSync(path.join(root, 'public', 'dashboard.html'), 'utf8');
  assert.match(dashboard, /new Date\(data\.lastSync\)/);
  assert.doesNotMatch(dashboard, /new Date\(data\.lastSync \+ 'Z'\)/);
});
