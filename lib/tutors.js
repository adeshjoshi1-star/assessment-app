const TUTOR_NAME_ALIASES = {
  sumith: 'Sumith',
  sumit: 'Sumith',
  'sumith rajan': 'Sumith',
  'sumith ranjan': 'Sumith',
  'sumith raj': 'Sumith',
  malavika: 'Malavika',
  'malavika r': 'Malavika',
  yatin: 'Yatin',
  yathin: 'Yatin',
  'yathin pradeep': 'Yatin',
  'yatin pradeep': 'Yatin',
  abhishek: 'Abhishek',
  'abhishek tm': 'Abhishek',
  ashitha: 'Ashitha KM',
  'ashitha km': 'Ashitha KM',
  ashitaa: 'Ashitha KM',
  'ashitaa k m': 'Ashitha KM',
  lakshya: 'Lakshya',
  pavan: 'Pavan',
  sahil: 'Sahil',
  selin: 'Selin',
  vishnu: 'Vishnu',
  reshma: 'Reshma',
  ayswarya: 'Ayswarya',
  nitesh: 'Nitesh',
  nitish: 'Nitesh',
  nithish: 'Nitesh',
  'nithish kumar': 'Nitesh',
  'nitesh kumar': 'Nitesh',
  yadu: 'Yadu',
  yadhu: 'Yadu',
};

function normalizeTutorName(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (['no_tutor', 'no_tutor_added', 'no tutor', 'no tutor added', 'unknown', 'deleted', 'none'].includes(lower)) return null;
  if (/^no.?tutor/i.test(value) || /^deleted/i.test(value) || lower.length < 2 || lower === 'su') return null;
  const stripped = lower.replace(/[^a-z0-9 ]/g, '');
  return TUTOR_NAME_ALIASES[lower] || TUTOR_NAME_ALIASES[stripped] || value.charAt(0).toUpperCase() + value.slice(1);
}

function sameTutorName(a, b) {
  const left = normalizeTutorName(a);
  const right = normalizeTutorName(b);
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

module.exports = { TUTOR_NAME_ALIASES, normalizeTutorName, sameTutorName };
