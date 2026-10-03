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
