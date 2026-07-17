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

test('uses the configured operational source spreadsheet', () => {
  assert.match(server, /process\.env\.SOURCE_SPREADSHEET_ID/);
  assert.match(server, /1xxq44ok6l6E0OHQ5-VK8sqMuIwxh1e9G2dbTlnAubF0/);
  assert.match(server, /range: "'Trial 2\.0'!A:R"/);
});

test('resolves the actual assessment worksheet tab instead of assuming Sheet1', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /resolveAssessmentSheetTab/);
  assert.match(server, /fields:\s*'sheets\.properties\.title'/);
  assert.doesNotMatch(server, /let assessmentSheetTab = 'Sheet1'/);
});

test('matches assessments by identity when Google Sheet rows are dragged', () => {
  assert.match(server, /function assessmentIdentityKey/);
  assert.match(server, /function assessmentMatchesEntry/);
  assert.match(server, /if \(a && !assessmentMatchesEntry\(a, entry\)\) a = null/);
  assert.match(server, /has_assessment: Boolean\(matchedAssessment\)/);
  assert.match(server, /currentEntry = assessmentMatchesEntry/);
  assert.match(server, /const sheetRowValue = currentEntry\?\.row/);
});

test('keeps the last complete cache during a temporary large sheet drag', () => {
  assert.match(server, /function shouldHoldSheetSnapshot/);
  assert.match(server, /LARGE_SHEET_DROP_CONFIRMATIONS = 3/);
  assert.match(server, /possible row-drag snapshot/);
});
