/**
 * Hearth — seed from the direct debit list
 *
 * Paste into the same Apps Script project as Code.gs, save, and run seed()
 * ONCE. Safe to re-run: it matches on title and updates rather than duplicating.
 *
 * References are last-four only, deliberately. Never put a full card or
 * account number in here.
 *
 * Dates below are the LAST payment taken. next_due is computed from them, so
 * everything lands on the right day of the month by itself.
 *
 * `review: 'true'` marks the ones I guessed at. They show a "check this" flag
 * in the app until you confirm them.
 */

// Anything automatic and monthly stays off the calendar: 21 all-day events a
// month is noise. The app still lists them under Dates. Only things you must
// act on — renewals, one-offs — get a calendar entry and a notice period.
var SEED_SUBJECTS = [
  { kind: 'property', name: 'The house' },
  { kind: 'vehicle',  name: 'The car' },
  { kind: 'household', name: 'Household' }
];

var SEED = [
  // title, subject, provider, ref, amount, cadence, last paid, category, calendar, notice, note, review
  ['Mortgage',            'The house', 'Santander',        '4298',   822.58, 'monthly',     '2026-08-03', 'Mortgage',          'none', 0, '', ''],
  ['Council tax',         'The house', 'SCDC',             '2817',   257.00, 'monthly',     '2026-08-10', 'Council tax',       'none', 0, 'Guessed this is council tax — confirm, and check whether it runs 10 months or 12.', 'true'],
  ['Gas & electricity',   'The house', 'British Gas',      '04G4',   200.05, 'monthly',     '2026-07-27', 'Utilities',         'none', 0, '', ''],
  ['Water',               'The house', 'Anglian Water',    '0857',    99.00, 'monthly',     '2026-08-03', 'Water',             'none', 0, '', ''],
  ['Broadband & TV',      'The house', 'Virgin Media',     '3001',    45.02, 'monthly',     '2026-08-14', 'Broadband & phone', 'none', 0, '', ''],
  ['Home insurance',      'The house', 'Homeprotect',      '8612',    16.09, 'monthly',     '2026-07-27', 'Insurance',         'none', 0, 'Bank shows the frequency as "not known" — assumed monthly. Renewal date matters more than the payment; add it as a separate yearly item once you know it.', 'true'],

  ['Car insurance',       'The car',   'Flex',             '5EW',     36.64, 'monthly',     '2026-08-07', 'Insurance',         'none', 0, '', ''],

  ['Mortgage protection', 'Household', 'Legal & General',  '5664',    37.62, 'monthly',     '2026-07-27', 'Insurance',         'none', 0, 'L&G "MI" — assumed mortgage/life cover. Confirm which.', 'true'],
  ['Life or health cover','Household', 'Aviva',            '7657',    21.61, 'monthly',     '2026-07-27', 'Insurance',         'none', 0, 'Could be life, health or car. Confirm what this one is.', 'true'],
  ['Mobile',              'Household', 'EE',               '8041',    27.96, 'monthly',     '2026-07-29', 'Broadband & phone', 'none', 0, 'Your notes say three people on phones — check this covers all three or add the others.', 'true'],
  ['Spare SIM',           'Household', 'O2',               '3955',     1.00, 'monthly',     '2026-08-19', 'Broadband & phone', 'none', 0, '£1 a month — likely a legacy or spare line. Worth deciding if it is still wanted.', 'true'],
  ['PayPal subscription', 'Household', 'PayPal',           'ZP4C',     1.20, 'half-yearly', '2026-08-19', 'Subscriptions',     'none', 0, '£1.20 twice a year. Find out what it is for.', 'true'],
  ['Will storage',        'Household', 'National Will Safe','9099',   30.00, 'yearly',      '2025-11-04', 'Subscriptions',     'household', 30, '', ''],

  ['Barclaycard',         'Household', 'Barclaycard',      '3004',   350.99, 'monthly',     '2024-06-04', 'Card repayment',    'none', 0, 'Last taken June 2024 — check this is still live. Card repayments are not a household cost in their own right; the spending behind them already counts. Left out of the committed total.', 'true'],
  ['Halifax',             'Household', 'Halifax',          '3265',    42.12, 'monthly',     '2026-07-30', 'Card repayment',    'none', 0, 'Reference looks like a card. Confirm whether it is a card, a loan or a policy.', 'true'],

  // The six appliance policies, kept separate so you can see and cancel them individually
  ['Appliance cover 1',   'The house', 'D&G',              '9045',     5.35, 'monthly',     '2026-07-27', 'Subscriptions',     'none', 0, 'Six D&G policies run at £26.07 a month — £312.84 a year. Worth listing which appliance each covers, then deciding.', 'true'],
  ['Appliance cover 2',   'The house', 'D&G',              '9049',     4.64, 'monthly',     '2026-07-27', 'Subscriptions',     'none', 0, '', 'true'],
  ['Appliance cover 3',   'The house', 'D&G',              '9044',     3.95, 'monthly',     '2026-07-27', 'Subscriptions',     'none', 0, '', 'true'],
  ['Appliance cover 4',   'The house', 'D&G',              '9048',     3.02, 'monthly',     '2026-07-27', 'Subscriptions',     'none', 0, '', 'true'],
  ['Appliance cover 5',   'The house', 'D&G',              '9046',     5.36, 'monthly',     '2026-07-27', 'Subscriptions',     'none', 0, '', 'true'],
  ['Appliance cover 6',   'The house', 'D&G',              '9047',     3.75, 'monthly',     '2026-07-27', 'Subscriptions',     'none', 0, '', 'true']
];

/**
 * Things your handwritten notes list that no direct debit covers. Added as
 * empty placeholders with a notice period, so they appear in the app asking
 * to be filled in rather than being quietly forgotten.
 */
var SEED_GAPS = [
  ['Vehicle tax',           'The car',   'DVLA',   '', '', 'yearly', '', 'Vehicle', 'household', 14, 'Date not known yet — check the V5C or the DVLA site.', 'true'],
  ['MOT',                   'The car',   '',       '', '', 'yearly', '', 'Vehicle', 'household', 14, 'Date not known yet — gov.uk/check-mot-status gives it from the registration.', 'true'],
  ['Car service',           'The car',   '',       '', '', 'yearly', '', 'Vehicle', 'household', 14, 'Last service date and garage.', 'true'],
  ['Car insurance renewal', 'The car',   'Flex',   '', '', 'yearly', '', 'Insurance','household', 30, 'The monthly payment is tracked separately. This is the date to shop around.', 'true'],
  ['Home insurance renewal','The house', 'Homeprotect','','', 'yearly','', 'Insurance','household', 30, 'Same idea — the renewal is the date that matters.', 'true'],
  ['Mortgage deal ends',    'The house', 'Santander','','', 'once',  '', 'Mortgage', 'household', 90, 'Remortgage date, plus current rate and LTV. Ninety days notice, because switching takes time.', 'true']
];

function seed() {
  var who = 'seed';
  var subjectIds = {};

  SEED_SUBJECTS.forEach(function (s) {
    var found = readTab('subjects').filter(function (x) { return x.name === s.name; })[0];
    subjectIds[s.name] = found ? found.id
      : upsert('subjects', { kind: s.kind, name: s.name, active: 'yes' }, who).id;
  });

  var existing = readTab('obligations');
  var byTitle = {};
  existing.forEach(function (o) { byTitle[o.title] = o.id; });

  var count = 0;
  SEED.concat(SEED_GAPS).forEach(function (r) {
    var row = {
      id: byTitle[r[0]] || '',
      title: r[0],
      subject_id: subjectIds[r[1]] || '',
      provider: r[2],
      account_ref: r[3],
      amount: r[4],
      cadence: r[5],
      next_due: r[6] ? advance(r[6], r[5]) : '',
      category: r[7],
      calendar: r[8],
      notice_days: r[9],
      note: r[10],
      review: r[11],
      kind: 'payment',
      status: 'active'
    };
    if (!row.id) delete row.id;
    upsert('obligations', row, who);
    count++;
  });

  return count + ' obligations seeded. Open the app and pull to sync.';
}
