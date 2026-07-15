const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('keeps every existing user-facing page', () => {
  for (const page of [
    'index.html', 'login.html', 'dashboard.html', 'tutor-view.html',
    'form.html', 'completed.html', 'conversion.html', 'analytics.html',
    'admin-tutors.html',
  ]) {
    assert.equal(fs.existsSync(path.join(root, 'public', page)), true, `${page} is missing`);
  }
});

test('keeps the core admin and tutor workflows', () => {
  for (const route of [
    '/api/login', '/api/tutor/login', '/api/tutor-names',
    '/api/assessments', '/api/assessments/by-row/:row',
    '/api/sheet-data', '/api/sheet-tutor/:name',
    '/api/sheet-data/:row/demo-not-done', '/api/admin/tutors',
    '/api/demo-completion', '/api/conversion-rate', '/api/sync-sheet',
  ]) {
    assert.equal(server.includes(route), true, `${route} is missing`);
  }
});

test('keeps Google Sheets read and write integration', () => {
  assert.match(server, /spreadsheets\.values\.get/);
  assert.match(server, /spreadsheets\.values\.update/);
  assert.match(server, /spreadsheets\.values\.append/);
  assert.match(server, /spreadsheets\.values\.batchUpdate/);
});
