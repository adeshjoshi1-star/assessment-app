const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTutorName, sameTutorName } = require('../lib/tutors');

test('normalizes Nitesh spelling variants without changing records', () => {
  for (const value of ['Nitesh', 'Nitish', 'Nithish', 'Nithish kumar', 'nitesh kumar']) {
    assert.equal(normalizeTutorName(value), 'Nitesh');
  }
});

test('normalizes Yadu spelling variants', () => {
  assert.equal(normalizeTutorName('Yadu'), 'Yadu');
  assert.equal(normalizeTutorName('Yadhu'), 'Yadu');
  assert.equal(sameTutorName('Yadu', 'Yadhu'), true);
});

test('rejects invalid tutor placeholders', () => {
  assert.equal(normalizeTutorName('no_tutor_added'), null);
  assert.equal(normalizeTutorName('deleted user'), null);
});
