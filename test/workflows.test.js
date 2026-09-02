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

test('supports a read-only Google Sheets shadow mode', () => {
  assert.match(server, /process\.env\.SHADOW_READ_ONLY_SHEETS === 'true'/);
  assert.match(server, /spreadsheets\.readonly/);
  assert.match(server, /skipShadowSheetWrite\('update demo status'\)/);
  assert.match(server, /skipShadowSheetWrite\('write assessment feedback'\)/);
  assert.match(server, /skipShadowSheetWrite\('append assessment log'\)/);
  assert.match(server, /skipShadowSheetWrite\('sync tutor codes'\)/);
});

test('uses the configured operational source spreadsheet', () => {
  assert.match(server, /process\.env\.SOURCE_SPREADSHEET_ID/);
  assert.match(server, /1xxq44ok6l6E0OHQ5-VK8sqMuIwxh1e9G2dbTlnAubF0/);
  assert.match(server, /range: "'Trial 2\.0'!A:X"/);
  assert.match(server, /feedbackPresent: Boolean\(String\(row\[19\]/);
  assert.match(server, /Feedback already exists in Column T/);
});

test('verifies Column R before writing assessment results', () => {
  assert.match(server, /findPhoneVerifiedTrialEntry/);
  assert.match(server, /normalizePhoneForMatch\(row\[17\]\) !== expected/);
  assert.match(server, /range: "'Trial 2\.0'!A:R"/);
  assert.match(server, /retrySheetOperation\(\(\) => updateSheetRow/);
  assert.match(server, /retrySheetOperation\(\(\) => writeAssessmentFeedbackToTrialSheet/);
  assert.doesNotMatch(server, /appendToSheet/);
  assert.doesNotMatch(server, /range: "'Trial 2\.0'!A:R",\s*valueInputOption/);
});

test('allows a phone-verified source row whose student-name cell is empty', () => {
  assert.match(server, /const required = \[tutor_name, slot, student_age, language, level, feedback, date, time\]/);
});

test('prevents accidental double submission from the tutor form', () => {
  const tutorView = fs.readFileSync(path.join(root, 'public', 'tutor-view.html'), 'utf8');
  assert.match(tutorView, /form\.dataset\.submitting === 'true'/);
  assert.match(tutorView, /submitButton\.disabled = true/);
  assert.match(tutorView, /finally \{/);
});

test('renders the required recommended start topic for Advanced assessments', () => {
  const tutorView = fs.readFileSync(path.join(root, 'public', 'tutor-view.html'), 'utf8');
  assert.match(tutorView, /const startTopicField =/);
  assert.match(tutorView, /id="start_\$\{level\}"/);
  assert.match(tutorView, /No topic checklists for \$\{level\} level\.<\/p>\$\{startTopicField\}/);
});

test('supports explicit admin creation of new tutors with generated codes', () => {
  const adminTutors = fs.readFileSync(path.join(root, 'public', 'admin-tutors.html'), 'utf8');
  assert.match(adminTutors, /id="addTutorForm"/);
  assert.match(adminTutors, /Add Tutor &amp; Generate Code/);
  assert.match(server, /code = generateTutorCode\(name, existingCodes\)/);
  assert.match(server, /await syncTutorCodesToSheet\(\)/);
  assert.match(server, /await syncSheet\(\)/);
});

test('protects assessment history when deleting accidental tutor accounts', () => {
  const adminTutors = fs.readFileSync(path.join(root, 'public', 'admin-tutors.html'), 'utf8');
  assert.match(adminTutors, /async function deleteTutor/);
  assert.match(adminTutors, /method: 'DELETE'/);
  assert.match(server, /SELECT COUNT\(\*\) AS count FROM assessments WHERE user_id = \?/);
  assert.match(server, /has assessment history and cannot be deleted/);
  assert.match(server, /res\.json\(\{ success: true, name: tutor\.name, code: tutor\.code \}\)/);
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
