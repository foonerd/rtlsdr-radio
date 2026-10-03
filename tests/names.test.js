'use strict';

// Whether two station names mean the same station: the names an FM station goes by
// against the names broadcasters give their stations on DAB and in their lists.

var test = require('node:test');
var assert = require('node:assert');
var names = require('../plugin/lib/names');

var DAB = ['BBC Radio 2', 'BBC Radio 4', 'BBC Radio London', 'Magic', 'Magic Soul', 'KISS', 'Kisstory',
  'Heart UK', 'Heart 80s', 'Heart London', 'Capital UK', 'Capital XTRA', 'Capital Dance', 'LBC', 'LBC News',
  'Classic FM', 'Smooth UK', 'Smooth Chill', 'Greatest Hits', 'Radio X', 'Absolute Radio', 'Absolute 80s'
].map(function(name) { return { name: name }; });

function found(wanted, options) {
  var hit = names.match(wanted, DAB, options);
  return hit ? hit.how + ': ' + hit.found.name : null;
}

test('the words that tell a name from others', function() {
  assert.deepStrictEqual(names.words('BBC Radio 2'), ['bbc', '2']);
  assert.deepStrictEqual(names.words('BBC R2'), ['bbc', '2']);
  assert.deepStrictEqual(names.words('Classic FM'), ['classic']);
  assert.deepStrictEqual(names.words('  The  Beat-London '), ['beat', 'london']);
  assert.deepStrictEqual(names.words('Jazz & Blues'), ['jazz', 'and', 'blues']);
  assert.deepStrictEqual(names.words('Radio Ö3'), ['ö3']);
  // a name made of nothing else keeps what it has
  assert.deepStrictEqual(names.words('Radio FM'), ['radio', 'fm']);
  assert.deepStrictEqual(names.words(''), []);
  assert.deepStrictEqual(names.words(null), []);
});

test('the same station under the user\'s name, RDS\'s and the broadcaster\'s', function() {
  assert.strictEqual(found('BBC Radio 4'), 'same: BBC Radio 4');
  assert.strictEqual(found('BBC R2'), 'same: BBC Radio 2');
  assert.strictEqual(found('Kiss'), 'same: KISS');
  assert.strictEqual(found('Classic'), 'same: Classic FM');
  assert.strictEqual(found('Magic Radio'), 'same: Magic');
  assert.strictEqual(found('Absolute'), 'same: Absolute Radio');
  assert.strictEqual(found('Capital XTRA'), 'same: Capital XTRA');
});

test('a name with something added means the station it adds to', function() {
  assert.strictEqual(found('BBC Radio 2 National'), 'within: BBC Radio 2');
  assert.strictEqual(found('LBC London'), 'within: LBC');
  // of two that fit, the one that says more
  assert.strictEqual(names.match('LBC News London', DAB).found.name, 'LBC News');
});

test('a name that only begins like others finds the family, and is not taken for sure', function() {
  assert.strictEqual(found('Heart'), 'family: Heart UK');
  assert.strictEqual(found('Capital FM'), 'family: Capital UK');
  assert.strictEqual(found('Smooth Radio'), 'family: Smooth UK');
  assert.strictEqual(found('Heart', { sure: true }), null);
  // a number added marks a station of its own more than a word does
  var some = [{ name: 'Heart 80s' }, { name: 'Heart London' }];
  assert.strictEqual(names.match('Heart', some).found.name, 'Heart London');
});

test('names that share no beginning are different stations', function() {
  assert.strictEqual(found('BBC Radio Kent'), null);
  assert.strictEqual(found('XFM'), null);
  assert.strictEqual(found('Jazz FM'), null);
  assert.strictEqual(found('FM'), null);
  assert.strictEqual(found(''), null);
  // "Kisstory" does not begin with the word "Kiss"
  assert.strictEqual(names.match('Kiss', [{ name: 'Kisstory' }]), null);
});
