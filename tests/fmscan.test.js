'use strict';

// Which channels of a band survey are stations. The surveys are what fn-rtl-gain
// printed with an RTL-SDR Blog V4 where one station (89.6 MHz) arrives far stronger
// than the rest: tests/fixtures/fm-survey-live.txt from the dongle itself;
// fm-survey.txt from recordings of the band at gains the tuner can take;
// fm-survey-overloaded.txt from a recording of the lowest slice with the gain too high
// for the tuner, though not for the converter.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var fmscan = require('../plugin/lib/fmscan');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function mhz(list) {
  return list.map(function(s) { return (s.freq / 1e6).toFixed(1); });
}

test('a survey is read: slices and channels, what was not measured as null', function() {
  var survey = fmscan.parse(fixture('fm-survey.txt'));
  assert.strictEqual(survey.slices.length, 11);
  assert.strictEqual(survey.channels.length, 206);
  assert.deepStrictEqual(survey.slices[0], { freq: 88450000, gain: 32.8, step: 0, of: 0, level: 0, cut: 0, backoff: 0, floor: survey.slices[0].floor });
  var kiss = survey.channels.find(function(c) { return c.freq === 100000000; });
  assert.strictEqual(kiss.top, true);
  assert.ok(kiss.pilot > 30 && kiss.again > 30);
  var beside = survey.channels.find(function(c) { return c.freq === 100100000; });
  assert.deepStrictEqual([beside.top, beside.pilot, beside.again], [false, null, null]);
  // a channel measured where there was no lower gain to try
  var unconfirmed = survey.channels.find(function(c) { return c.freq === 105400000; });
  assert.ok(unconfirmed.pilot > 30);
  assert.strictEqual(unconfirmed.again, null);
});

test('something that is no survey gives no channels', function() {
  assert.deepStrictEqual(fmscan.parse('fn-rtl-gain: cannot open device 0\n'), { slices: [], channels: [] });
  assert.deepStrictEqual(fmscan.parse(undefined), { slices: [], channels: [] });
  assert.deepStrictEqual(fmscan.stations(fmscan.parse(''), {}), []);
});

test('the stations of the band are found, and nothing beside them', function() {
  var found = fmscan.stations(fmscan.parse(fixture('fm-survey.txt')), { sensitivity: 8 });
  assert.deepStrictEqual(mhz(found), ['88.8', '89.1', '89.6', '91.0', '91.3', '93.2', '93.5', '94.9', '95.8', '97.3',
    '98.5', '98.8', '100.0', '100.6', '100.9', '101.4', '102.2', '103.6', '104.9', '105.4', '105.8', '106.2', '107.8']);
  // rising in frequency, each with the level its pilot gives
  var strong = found.find(function(s) { return s.freq === 89600000; });
  var weak = found.find(function(s) { return s.freq === 105800000; });
  assert.strictEqual(strong.level, 5);
  assert.strictEqual(weak.level, 2);
});

test('a survey made by the dongle: the gain taken down next to the strong station, and the stations found', function() {
  var survey = fmscan.parse(fixture('fm-survey-live.txt'));
  assert.strictEqual(survey.slices.length, 11);
  assert.strictEqual(survey.channels.length, 206);
  // the lowest slice lies next to the strong station: its gain was taken down, no other's was
  assert.deepStrictEqual(survey.slices.map(function(s) { return s.backoff; }), [10.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(survey.slices[0].gain, 32.8);

  var found = mhz(fmscan.stations(survey, { sensitivity: 8 }));
  assert.deepStrictEqual(found, ['88.8', '89.1', '89.6', '91.0', '91.3', '93.2', '93.5', '94.9', '95.8', '97.3',
    '98.5', '98.8', '100.0', '100.6', '100.9', '101.4', '102.2', '103.6', '104.9', '105.4', '105.8', '106.2', '107.8']);
  // nothing where the overloaded tuner had made signals
  assert.deepStrictEqual(fmscan.ghosts(survey, { sensitivity: 3 }), []);
  var most = mhz(fmscan.stations(survey, { sensitivity: 3 }));
  ['87.8', '88.2', '88.3'].forEach(function(f) { assert.ok(most.indexOf(f) === -1, f); });
});

test('the channels next to a station are not stations, though the pilot is heard there', function() {
  var survey = fmscan.parse(fixture('fm-survey.txt'));
  var found = mhz(fmscan.stations(survey, { sensitivity: 3 }));
  ['89.5', '89.7', '99.9', '100.1', '100.8', '101.0', '105.3', '105.5'].forEach(function(f) {
    assert.ok(found.indexOf(f) === -1, f + ' was taken for a station');
  });
});

test('signals the overloaded tuner made are told from stations: they do not keep their pilot', function() {
  var survey = fmscan.parse(fixture('fm-survey-overloaded.txt'));
  // they have the pilot of a station...
  var made = survey.channels.filter(function(c) { return c.freq === 87800000 || c.freq === 88300000; });
  assert.strictEqual(made.length, 2);
  made.forEach(function(c) { assert.ok(c.top && c.pilot > 15 && c.low > 8, JSON.stringify(c)); });
  // ...and are refused all the same, while the stations in the same slice are kept
  assert.deepStrictEqual(mhz(fmscan.stations(survey, { sensitivity: 8 })), ['88.8', '89.1']);
  assert.deepStrictEqual(mhz(fmscan.ghosts(survey, { sensitivity: 8 })), ['87.8', '88.3']);
});

test('the sensitivity setting moves the pilot a station must show', function() {
  assert.strictEqual(fmscan.threshold(8), 8);
  assert.strictEqual(fmscan.threshold(3), 3);
  assert.strictEqual(fmscan.threshold(0), 3);
  assert.strictEqual(fmscan.threshold(40), 30);
  assert.strictEqual(fmscan.threshold('nonsense'), 8);
  var survey = fmscan.parse(fixture('fm-survey.txt'));
  var counts = [3, 5, 8, 10, 15].map(function(sensitivity) {
    return fmscan.stations(survey, { sensitivity: sensitivity }).length;
  });
  assert.deepStrictEqual(counts, [26, 25, 23, 23, 22]);
  // the most sensitive setting reaches the two faint stations the usual one leaves out
  var faint = mhz(fmscan.stations(survey, { sensitivity: 3 }));
  assert.ok(faint.indexOf('96.9') !== -1 && faint.indexOf('107.3') !== -1, faint.join(' '));
});

test('a carrier off its channel, a pilot that comes and goes, and a channel below its neighbour are no stations', function() {
  function one(line) {
    return fmscan.stations(fmscan.parse(line), { sensitivity: 8 }).length;
  }
  assert.strictEqual(one('CHANNEL: freq=100000000 rf=-20.0 top=1 pilot=30.0 low=28.0 offset=100 again=29.0'), 1);
  assert.strictEqual(one('CHANNEL: freq=100000000 rf=-20.0 top=1 pilot=30.0 low=28.0 offset=100 again=-'), 1);
  assert.strictEqual(one('CHANNEL: freq=100000000 rf=-20.0 top=1 pilot=30.0 low=28.0 offset=-40000 again=29.0'), 0);
  assert.strictEqual(one('CHANNEL: freq=100000000 rf=-20.0 top=1 pilot=14.0 low=-3.0 offset=100 again=13.0'), 0);
  assert.strictEqual(one('CHANNEL: freq=100000000 rf=-20.0 top=0'), 0);
  assert.strictEqual(one('CHANNEL: freq=100000000 rf=-20.0 top=1 pilot=30.0 low=28.0 offset=100 again=1.0'), 0);
  // a faint station is faint at either gain: that is no fall
  assert.strictEqual(one('CHANNEL: freq=100000000 rf=-30.0 top=1 pilot=9.0 low=6.5 offset=100 again=5.0'), 1);
});

test('a tuner\'s mirror of a strong station is no station; a station under such a mirror stays', function() {
  // Three slices recorded with an E4000 dongle (Nooelec NESDR XTR+), as the survey prints
  // them: 98.1 and 100.3 MHz hold only the mirrors of 98.8 and 100.6, 91.3 MHz holds a
  // station of its own under the mirror of 89.6
  var survey = fmscan.parse(fixture('fm-survey-mirror.txt'));
  var copy = survey.channels.filter(function(c) { return c.freq === 98100000; })[0];
  assert.strictEqual(copy.mirror, 0.53);
  assert.strictEqual(copy.moved, -0.7);
  assert.strictEqual(copy.least, -10.3);
  assert.strictEqual(survey.channels.filter(function(c) { return c.freq === 98800000; })[0].mirror, null);

  [8, 5, 3].forEach(function(sensitivity) {
    var listed = mhz(fmscan.stations(survey, { sensitivity: sensitivity }));
    assert.ok(listed.indexOf('98.1') === -1 && listed.indexOf('100.3') === -1, 'at +' + sensitivity + ': ' + listed.join(' '));
    assert.ok(listed.indexOf('91.3') !== -1 && listed.indexOf('98.8') !== -1 && listed.indexOf('100.6') !== -1 && listed.indexOf('89.6') !== -1);
    assert.deepStrictEqual(mhz(fmscan.mirrors(survey, { sensitivity: sensitivity })), ['98.1', '100.3']);
  });
  assert.deepStrictEqual(fmscan.ghosts(survey, { sensitivity: 8 }), []);

  // The station under the mirror is given the pilot and the weakest reading it shows
  // with the tuner set elsewhere
  var under = fmscan.stations(survey, { sensitivity: 8 }).filter(function(s) { return s.freq === 91300000; })[0];
  assert.strictEqual(under.pilot, 25.3);
  assert.strictEqual(under.low, 23.8);

  // A second look whose middle reading passes at the most sensitive setting, as noise now
  // and then does, while its weakest does not: no station (seen on the test player: 4.1 dB)
  var lucky = fmscan.parse('CHANNEL: freq=98100000 rf=-31.8 top=1 pilot=9.7 low=6.5 offset=2425 again=8.1 mirror=0.56 moved=4.1 least=-6.0\n');
  assert.deepStrictEqual(fmscan.stations(lucky, { sensitivity: 3 }), []);
  assert.deepStrictEqual(mhz(fmscan.mirrors(lucky, { sensitivity: 3 })), ['98.1']);
  // Printed by the tool of 1.4.3, without the weakest reading: judged by the middle one alone
  var older = fmscan.parse('CHANNEL: freq=98100000 rf=-31.8 top=1 pilot=9.7 low=6.5 offset=2425 again=8.1 mirror=0.56 moved=-0.7\n');
  assert.deepStrictEqual(fmscan.stations(older, { sensitivity: 3 }), []);

  // Doubted and not looked at again (the second look failed): left in, as measured
  var unlooked = fmscan.parse('CHANNEL: freq=98100000 rf=-31.9 top=1 pilot=10.5 low=7.5 offset=1342 again=- mirror=0.53 moved=-\n');
  assert.deepStrictEqual(mhz(fmscan.stations(unlooked, { sensitivity: 8 })), ['98.1']);
  assert.strictEqual(fmscan.stations(unlooked, { sensitivity: 8 })[0].pilot, 10.5);
  // A survey of a tool that knows no mirrors reads as before
  assert.strictEqual(fmscan.parse(fixture('fm-survey.txt')).channels.every(function(c) { return c.mirror === null && c.moved === null; }), true);
});

test('a faint signal the tuner made is refused although it cannot fall by 10 dB', function() {
  // As surveyed on two R820T dongles beside a very strong station: 88.2 and 87.8 MHz are
  // not on the air, and with the gain lowered there is no pilot left on them
  var faint = fmscan.parse(
    'CHANNEL: freq=88200000 rf=-20.0 top=1 pilot=9.4 low=6.0 offset=1200 again=0.9\n' +
    'CHANNEL: freq=87800000 rf=-20.0 top=1 pilot=8.3 low=5.1 offset=900 again=-1.0\n' +
    // the faintest real station of fourteen surveys kept 2.9 dB
    'CHANNEL: freq=93800000 rf=-28.9 top=1 pilot=8.1 low=5.0 offset=4236 again=2.9\n');
  [8, 5, 3].forEach(function(sensitivity) {
    assert.deepStrictEqual(mhz(fmscan.stations(faint, { sensitivity: sensitivity })), ['93.8']);
    assert.deepStrictEqual(mhz(fmscan.ghosts(faint, { sensitivity: sensitivity })).sort(), ['87.8', '88.2']);
  });
});

