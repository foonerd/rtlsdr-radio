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


test('a station without a pilot is known by its carrier, and a bare carrier is not taken for one', function() {
  function found(line, sensitivity) {
    return fmscan.stations(fmscan.parse(line + '\n'), { sensitivity: sensitivity || 8 });
  }
  // As the survey prints made-up slices of the band: a mono station, strong and weak
  var mono = found('CHANNEL: freq=98800000 rf=-0.5 top=1 pilot=-11.3 low=-28.0 offset=-150 quiet=61.0 swing=38.0 wide=0.01 again=-');
  assert.strictEqual(mono.length, 1);
  // it has no pilot: its reception is what a pilot would read on it
  assert.deepStrictEqual([mono[0].mono, mono[0].pilot, mono[0].level], [true, 61, 5]);
  var weak = found('CHANNEL: freq=98200000 rf=-29.6 top=1 pilot=-7.4 low=-13.0 offset=210 quiet=31.2 swing=37.6 wide=0.47 again=-8.0 againq=29.9 agains=36.8');
  assert.deepStrictEqual([weak.length, weak[0].mono, weak[0].level], [1, true, 4]);
  // whatever the sensitivity setting: it speaks of the pilot, and there is none
  assert.strictEqual(found('CHANNEL: freq=98800000 rf=-0.5 top=1 pilot=-11.3 low=-28.0 offset=-150 quiet=61.0 swing=38.0 wide=0.01 again=-', 3)[0].mono, true);
  // a stereo station is one by its pilot, however clear its carrier
  var stereo = found('CHANNEL: freq=98800000 rf=-0.5 top=1 pilot=58.9 low=55.1 offset=-51 quiet=59.0 swing=18.9 wide=0.01 again=57.0 againq=57.2 agains=19.3');
  assert.deepStrictEqual([stereo[0].mono, stereo[0].pilot], [false, 58.9]);

  // a bare carrier, strong or faint, steady or wandering and humming: nothing swings it
  assert.strictEqual(found('CHANNEL: freq=98800000 rf=-0.5 top=1 pilot=-7.8 low=-19.6 offset=5 quiet=60.3 swing=0.5 wide=0.01 again=-').length, 0);
  assert.strictEqual(found('CHANNEL: freq=97800000 rf=-29.6 top=1 pilot=-11.5 low=-20.1 offset=-3 quiet=29.0 swing=0.6 wide=0.01 again=-9.1 againq=28.2 agains=0.6').length, 0);
  assert.strictEqual(found('CHANNEL: freq=98600000 rf=-10.0 top=1 pilot=-11.9 low=-18.8 offset=140 quiet=50.1 swing=1.7 wide=0.01 again=-').length, 0);
  // a quiet passage, 26 dB under full modulation, is still a programme
  assert.strictEqual(found('CHANNEL: freq=98800000 rf=-0.5 top=1 pilot=-6.1 low=-17.7 offset=-12 quiet=58.3 swing=3.3 wide=0.01 again=-').length, 1);
  // silent at the first look and speaking at the second: a station
  assert.strictEqual(found('CHANNEL: freq=98800000 rf=-10.0 top=1 pilot=-9.1 low=-21.0 offset=40 quiet=50.3 swing=0.6 wide=0.01 again=-10.2 againq=47.9 agains=31.3').length, 1);

  // no carrier clear of the noise: as surveyed on channels with no station on them
  assert.strictEqual(found('CHANNEL: freq=103000000 rf=-31.0 top=1 pilot=-4.4 low=-12.0 offset=-2801 quiet=23.7 swing=20.4 wide=3.73 again=-').length, 0);
  assert.strictEqual(found('CHANNEL: freq=97100000 rf=-33.4 top=1 pilot=-4.6 low=-11.2 offset=-568 quiet=24.2 swing=18.1 wide=2.13 again=-').length, 0);
  // a weak carrier thrown about by clicks, one off its channel, one below its neighbour
  assert.strictEqual(found('CHANNEL: freq=98800000 rf=-10.0 top=1 pilot=-5.0 low=-12.0 offset=300 quiet=33.0 swing=30.0 wide=6.50 again=-').length, 0);
  assert.strictEqual(found('CHANNEL: freq=98800000 rf=-0.5 top=1 pilot=-11.3 low=-28.0 offset=-30000 quiet=61.0 swing=38.0 wide=0.01 again=-').length, 0);
  assert.strictEqual(found('CHANNEL: freq=98800000 rf=-0.5 top=0').length, 0);
  // the same weak mono station through an E4000 tuner, as surveyed: a little more of the
  // time beyond the limit than through an R820T, and a station
  assert.strictEqual(found('CHANNEL: freq=101200000 rf=-27.7 top=1 pilot=-0.0 low=-15.3 offset=404 quiet=28.0 swing=24.6 wide=1.11 own=5.7 again=-2.7 againq=26.9 agains=23.5').length, 1);
  // a channel with no station on it, as surveyed: twice that share
  assert.strictEqual(found('CHANNEL: freq=97100000 rf=-33.4 top=1 pilot=-4.6 low=-11.2 offset=-568 quiet=26.5 swing=18.1 wide=2.13 again=-').length, 0);
  // a station modulating as far as 95 kHz is a station
  assert.strictEqual(found('CHANNEL: freq=98800000 rf=-1.6 top=1 pilot=4.2 low=-9.0 offset=77 quiet=58.7 swing=53.1 wide=1.49 again=-').length, 1);
});

test('a signal without a pilot passes the same second looks as one with', function() {
  // a faint carrier that cannot fall by 10 dB, and is gone into the noise all the same
  var faint = fmscan.parse('CHANNEL: freq=95600000 rf=-27.0 top=1 pilot=-6.0 low=-14.0 offset=900 quiet=27.0 swing=24.0 wide=0.30 again=-8.0 againq=21.5 agains=18.0\n');
  assert.deepStrictEqual(fmscan.stations(faint, { sensitivity: 8 }), []);
  assert.strictEqual(fmscan.ghosts(faint, { sensitivity: 8 }).length, 1);
  // the carrier gone with the gain lowered: made in the tuner
  var made = fmscan.parse('CHANNEL: freq=95600000 rf=-22.0 top=1 pilot=-6.0 low=-14.0 offset=900 quiet=36.0 swing=24.0 wide=0.30 again=-8.0 againq=19.5 agains=18.0\n');
  assert.deepStrictEqual(fmscan.stations(made, { sensitivity: 8 }), []);
  var ghosts = fmscan.ghosts(made, { sensitivity: 8 });
  assert.deepStrictEqual([ghosts.length, ghosts[0].mono, ghosts[0].againq], [1, true, 19.5]);
  // one with a pilot is not marked so
  var stereo = fmscan.ghosts(fmscan.parse('CHANNEL: freq=88200000 rf=-20.0 top=1 pilot=19.4 low=16.0 offset=1200 again=0.9\n'), { sensitivity: 8 });
  assert.deepStrictEqual([stereo.length, stereo[0].mono], [1, undefined]);

  // at a stronger channel's mirror place, and gone with the tuner set elsewhere: the mirror
  var copy = fmscan.parse('CHANNEL: freq=98100000 rf=-25.0 top=1 pilot=-7.0 low=-15.0 offset=-300 quiet=34.0 swing=30.0 wide=0.20 again=-8.5 againq=32.0 agains=29.0 mirror=0.61 moved=-9.0 least=-20.0 movedq=19.0\n');
  assert.deepStrictEqual(fmscan.stations(copy, { sensitivity: 8 }), []);
  assert.deepStrictEqual(fmscan.mirrors(copy, { sensitivity: 8 }).map(function(c) { return c.mono; }), [true]);
  // still there with the tuner set elsewhere: a station under the mirror, given what it shows there
  var under = fmscan.stations(fmscan.parse('CHANNEL: freq=98100000 rf=-25.0 top=1 pilot=-7.0 low=-15.0 offset=-300 quiet=34.0 swing=30.0 wide=0.20 again=-8.5 againq=32.0 agains=29.0 mirror=0.61 moved=-9.0 least=-20.0 movedq=30.5\n'), { sensitivity: 8 });
  assert.deepStrictEqual([under.length, under[0].mono, under[0].pilot], [1, true, 30.5]);
});

test('a survey of a tool that does not measure the carrier finds no station without a pilot', function() {
  ['fm-survey.txt', 'fm-survey-live.txt', 'fm-survey-overloaded.txt', 'fm-survey-mirror.txt'].forEach(function(name) {
    var survey = fmscan.parse(fixture(name));
    assert.strictEqual(survey.channels.every(function(c) { return c.quiet === null && c.againq === null; }), true, name);
    assert.strictEqual(fmscan.stations(survey, { sensitivity: 3 }).some(function(s) { return s.mono; }), false, name);
  });
});

test('a survey made by a dongle that measures the carrier: the stereo stations, and the mono one among them', function() {
  // tests/fixtures/fm-survey-carrier.txt: the band as a Nooelec NESDR SMArt v5 (R820T)
  // surveyed it. 101.2 MHz sends a programme and no pilot, and is weak there.
  var survey = fmscan.parse(fixture('fm-survey-carrier.txt'));
  assert.strictEqual(survey.slices.length, 11);
  assert.strictEqual(survey.channels.length, 206);
  var found = fmscan.stations(survey, { sensitivity: 8 });
  assert.deepStrictEqual(mhz(found), ['88.8', '89.1', '89.6', '91.0', '91.3', '93.2', '93.5', '93.8', '94.9', '95.8', '96.7', '96.9',
    '97.3', '98.5', '98.8', '100.0', '100.6', '100.9', '101.2', '101.4', '102.2', '103.6', '104.9', '105.4', '105.6', '105.8', '106.2',
    '106.8', '107.3', '107.8']);
  assert.deepStrictEqual(mhz(found.filter(function(s) { return s.mono; })), ['101.2']);
  var mono = found.filter(function(s) { return s.mono; })[0];
  assert.deepStrictEqual([mono.pilot, mono.level], [27.6, 3]);
  // on a stereo station the carrier measure agrees with the pilot
  survey.channels.filter(function(c) { return c.pilot !== null && c.pilot >= 25; }).forEach(function(c) {
    assert.ok(Math.abs(c.quiet - c.pilot) <= 4.5, (c.freq / 1e6) + ': quiet ' + c.quiet + ' against pilot ' + c.pilot);
  });
  // the 45 channels listened to that hold no station: none with a carrier clear of the noise
  var empty = survey.channels.filter(function(c) { return c.quiet !== null && c.pilot < 6 && c.freq !== 101200000; });
  assert.strictEqual(empty.length, 44);
  assert.ok(Math.max.apply(null, empty.map(function(c) { return c.quiet; })) < 24);
  assert.deepStrictEqual(fmscan.ghosts(survey, { sensitivity: 3 }), []);
});

test('a station the list holds stays on a little less than a new one must show', function() {
  function found(line, options) {
    return fmscan.stations(fmscan.parse(line + '\n'), options);
  }
  // 2 dB short of what the setting asks: no new station, but one that was there stays
  var short = 'CHANNEL: freq=105600000 rf=-38.5 top=1 pilot=6.2 low=3.9 offset=1473 quiet=19.0 swing=14.6 wide=8.90 again=5.1 againq=18.9 agains=13.0';
  assert.strictEqual(found(short, { sensitivity: 8 }).length, 0);
  assert.strictEqual(found(short, { sensitivity: 8, known: [98800000] }).length, 0);
  var held = found(short, { sensitivity: 8, known: [98800000, 105600000] });
  assert.deepStrictEqual([held.length, held[0].held, held[0].pilot], [1, true, 6.2]);
  // one that passes as a new station is not marked as held
  assert.strictEqual(found(short, { sensitivity: 5, known: [105600000] })[0].held, false);
  // not below the least any setting asks for
  var gone = 'CHANNEL: freq=105600000 rf=-38.5 top=1 pilot=2.2 low=-3.0 offset=1473 quiet=18.0 swing=14.6 wide=9.90 again=-';
  assert.strictEqual(found(gone, { sensitivity: 8, known: [105600000] }).length, 0);
  assert.strictEqual(found(gone, { sensitivity: 3, known: [105600000] }).length, 0);
  // and not what the tuner made, or a channel below its neighbour, wherever the list has it
  assert.strictEqual(found('CHANNEL: freq=88200000 rf=-20.0 top=1 pilot=9.4 low=6.0 offset=1200 again=0.9', { sensitivity: 8, known: [88200000] }).length, 0);
  assert.strictEqual(found('CHANNEL: freq=88200000 rf=-20.0 top=0', { sensitivity: 8, known: [88200000] }).length, 0);

  // a station without a pilot: its carrier a little weaker than a new one's must be, or in a pause
  var weaker = 'CHANNEL: freq=101200000 rf=-27.9 top=1 pilot=-9.0 low=-15.0 offset=500 quiet=24.6 swing=20.1 wide=0.90 again=-';
  assert.strictEqual(found(weaker, { sensitivity: 8 }).length, 0);
  assert.deepStrictEqual(found(weaker, { sensitivity: 8, known: [101200000] }).map(function(s) { return [s.mono, s.held]; }), [[true, true]]);
  var pause = 'CHANNEL: freq=101200000 rf=-10.0 top=1 pilot=-9.1 low=-21.0 offset=40 quiet=50.3 swing=0.6 wide=0.01 again=-10.2 againq=47.9 agains=0.7';
  assert.strictEqual(found(pause, { sensitivity: 8 }).length, 0);
  assert.strictEqual(found(pause, { sensitivity: 8, known: [101200000] }).length, 1);
  // no carrier left: gone
  assert.strictEqual(found('CHANNEL: freq=101200000 rf=-30.0 top=1 pilot=-9.0 low=-15.0 offset=500 quiet=21.0 swing=20.1 wide=4.90 again=-', { sensitivity: 8, known: [101200000] }).length, 0);
});

test('how far the dongle tunes off is told from the carriers of the stations', function() {
  // the band as surveyed by a dongle with a good crystal: nothing to correct
  var good = fmscan.tuningError(fmscan.parse(fixture('fm-survey-carrier.txt')), { sensitivity: 8 });
  assert.ok(good.stations >= 15, JSON.stringify(good));
  assert.ok(Math.abs(good.ppm) <= 2, JSON.stringify(good));
  // the same survey as a dongle 54 parts per million high would make it: every carrier
  // some 5.3 kHz below its channel. One transmitter there is itself 4 kHz off (98.5 MHz):
  // it does not move the finding.
  var off = fmscan.parse(fixture('fm-survey-off.txt'));
  assert.ok(off.channels.filter(function(c) { return c.freq === 98800000; })[0].offset < -5000);
  var found = fmscan.tuningError(off, { sensitivity: 8 });
  assert.ok(Math.abs(found.ppm - 54) <= 2, JSON.stringify(found));
  // the stations are found all the same: 5 kHz is within the channel
  assert.strictEqual(fmscan.stations(off, { sensitivity: 8 }).length, 30);

  // too few stations received well to tell by
  var few = fmscan.parse(
    'CHANNEL: freq=98800000 rf=-10.0 top=1 pilot=40.0 low=38.0 offset=-5300 again=39.0\n' +
    'CHANNEL: freq=100000000 rf=-10.0 top=1 pilot=40.0 low=38.0 offset=-5400 again=39.0\n' +
    'CHANNEL: freq=93200000 rf=-30.0 top=1 pilot=12.0 low=10.0 offset=-9000 again=11.0\n');
  assert.strictEqual(fmscan.tuningError(few, { sensitivity: 8 }), null);
  // stations that do not agree: no dongle's doing
  var apart = fmscan.parse([88, 90, 92, 94, 96, 98, 100, 102].map(function(mhz, i) {
    return 'CHANNEL: freq=' + (mhz * 1e6) + ' rf=-10.0 top=1 pilot=40.0 low=38.0 offset=' + (i % 2 ? 6000 : -6000) + ' again=39.0';
  }).join('\n') + '\n');
  assert.strictEqual(fmscan.tuningError(apart, { sensitivity: 8 }), null);
  assert.strictEqual(fmscan.tuningError(fmscan.parse(''), {}), null);
});

test('a weak station beside a strong one is told from what the strong one spills', function() {
  function judged(lines, sensitivity, known) {
    return fmscan.judged(fmscan.parse(lines.join('\n') + '\n'), { sensitivity: sensitivity || 8, known: known });
  }
  // As surveyed: 98.3 MHz, a weak station 200 kHz below a strong one. Its pilot reads
  // better with the channel taken in more narrowly.
  var strong = 'CHANNEL: freq=98500000 rf=-17.9 top=1 pilot=43.8 low=38.4 offset=-3944 quiet=45.7 swing=21.9 wide=0.00 again=41.2 againq=43.1 agains=23.7';
  var weak = 'CHANNEL: freq=98300000 rf=-39.5 top=1 pilot=12.6 low=8.1 offset=-3022 quiet=19.9 swing=15.3 wide=8.60 narrow=19.8 again=12.8 againq=18.4 agains=14.9';
  assert.deepStrictEqual(mhz(judged([weak, strong]).stations), ['98.3', '98.5']);

  // A made-up slice: nothing on 99.1 MHz but what a very strong station 200 kHz below
  // spills there, pilot and all, and it holds with the gain lowered. More narrowly it reads worse.
  var station = 'CHANNEL: freq=98900000 rf=-0.5 top=1 pilot=46.1 low=44.2 offset=-52 quiet=46.2 swing=18.8 wide=0.00 again=47.1 againq=47.2 agains=18.9';
  var spilt = 'CHANNEL: freq=99100000 rf=-38.7 top=1 pilot=9.9 low=7.8 offset=-11209 quiet=19.4 swing=22.0 wide=13.01 narrow=4.9 again=12.0 againq=21.2 agains=21.3';
  var found = judged([station, spilt]);
  assert.deepStrictEqual(mhz(found.stations), ['98.9']);
  assert.deepStrictEqual(mhz(found.spill), ['99.1']);
  // On the 200 kHz raster a station on the channel next to a stronger one is a station
  var next = 'CHANNEL: freq=99100000 rf=-15.5 top=1 pilot=43.3 low=40.9 offset=4 quiet=43.4 swing=19.0 wide=0.00 again=41.7 againq=41.8 agains=18.9';
  assert.deepStrictEqual(mhz(judged([station, next]).stations), ['98.9', '99.1']);

  // With no far stronger station near, a weak station that reads worse more narrowly is
  // left in: as surveyed at 107.3 MHz, with nothing within half a megahertz
  var alone = 'CHANNEL: freq=107300000 rf=-34.3 top=1 pilot=8.7 low=1.7 offset=-6418 quiet=20.9 swing=17.7 wide=8.46 narrow=5.8 again=10.2 againq=20.2 agains=16.6';
  assert.deepStrictEqual(mhz(judged([alone], 5).stations), ['107.3']);
  // and a survey of a tool that takes no second opinion is judged as before
  assert.deepStrictEqual(mhz(judged([station, spilt.replace(' narrow=4.9', '')]).stations), ['98.9', '99.1']);
});

test('of channels next to each other that pass for stations, the one that shows the station best is listed', function() {
  function judged(lines, sensitivity, known) {
    return fmscan.judged(fmscan.parse(lines.join('\n') + '\n'), { sensitivity: sensitivity || 8, known: known });
  }
  // As surveyed: 93.4 MHz hears the station on 93.5, on its channel and steady at both gains
  var beside = 'CHANNEL: freq=93400000 rf=-33.7 top=1 pilot=14.5 low=9.0 offset=-1488 quiet=18.6 swing=21.2 wide=14.05 narrow=2.2 again=19.4 againq=20.1 agains=28.6';
  var station = 'CHANNEL: freq=93500000 rf=-24.5 top=1 pilot=30.8 low=28.3 offset=-81 quiet=30.4 swing=7.1 wide=0.02 again=31.4 againq=30.9 agains=9.3';
  var found = judged([beside, station]);
  assert.deepStrictEqual(mhz(found.stations), ['93.5']);
  assert.deepStrictEqual(mhz(found.beside), ['93.4']);
  assert.deepStrictEqual(mhz(judged([beside]).stations), ['93.4'], 'alone, it passes: it is left out for its neighbour, not for itself');

  // A weak station (96.7 MHz) and the channel below, which hears it nearly as well: the
  // reading through the narrower filter tells them apart
  var lower = 'CHANNEL: freq=96600000 rf=-36.7 top=1 pilot=7.7 low=1.1 offset=1820 quiet=19.3 swing=16.0 wide=8.19 narrow=9.0 again=5.0 againq=19.6 agains=15.7';
  var own = 'CHANNEL: freq=96700000 rf=-36.7 top=1 pilot=8.9 low=4.0 offset=-1035 quiet=19.7 swing=16.7 wide=8.71 narrow=14.6 again=10.7 againq=20.1 agains=16.6';
  [5, 3].forEach(function(sensitivity) {
    var both = judged([lower, own], sensitivity);
    assert.deepStrictEqual([mhz(both.stations), mhz(both.beside)], [['96.7'], ['96.6']], 'at +' + sensitivity);
  });
  // the station keeps the reading of the usual filter: that is what it is received with
  assert.strictEqual(judged([lower, own], 5).stations[0].pilot, 8.9);
  assert.strictEqual(judged([lower, own], 5).stations[0].narrow, undefined);

  // Readings alike within what chance does: the one the list holds is not given up for its neighbour
  var a = 'CHANNEL: freq=96600000 rf=-36.7 top=1 pilot=9.0 low=6.1 offset=820 quiet=19.3 swing=16.0 wide=8.19 narrow=13.0 again=9.0';
  var b = 'CHANNEL: freq=96700000 rf=-36.7 top=1 pilot=9.4 low=6.0 offset=-1035 quiet=19.7 swing=16.7 wide=8.71 narrow=14.6 again=10.7';
  assert.deepStrictEqual(mhz(judged([a, b]).stations), ['96.7']);
  assert.deepStrictEqual(mhz(judged([a, b], 8, [96600000]).stations), ['96.6']);
  // 200 kHz apart: both
  assert.deepStrictEqual(mhz(judged([a, b.replace('freq=96700000', 'freq=96800000')]).stations), ['96.6', '96.8']);
});

test('a faint reading that is not there again was noise, not something the tuner made', function() {
  var noise = fmscan.parse('CHANNEL: freq=97600000 rf=-38.5 top=1 pilot=4.6 low=-0.2 offset=-1370 quiet=20.6 swing=17.2 wide=9.42 narrow=7.2 again=-0.6 againq=19.7 agains=17.9\n');
  assert.deepStrictEqual(fmscan.stations(noise, { sensitivity: 3 }), []);
  assert.deepStrictEqual(fmscan.ghosts(noise, { sensitivity: 3 }), []);
  // there again: at the most sensitive setting it is taken
  var there = fmscan.parse('CHANNEL: freq=97600000 rf=-38.5 top=1 pilot=4.6 low=-0.2 offset=-1370 quiet=20.6 swing=17.2 wide=9.42 narrow=7.2 again=3.1 againq=19.7 agains=17.9\n');
  assert.strictEqual(fmscan.stations(there, { sensitivity: 3 }).length, 1);
  assert.strictEqual(fmscan.stations(there, { sensitivity: 5 }).length, 0);
});

test('a weak station beside a strong one, once in the list, is held by its reading through the narrower filter', function() {
  // 98.3 MHz as three surveys within minutes found it: the strong station 200 kHz above
  // reaches into its channel, and the usual reading moves between 3 and 12 dB; read
  // more narrowly it stands 11 to 18 dB above the noise every time
  var looks = [
    'CHANNEL: freq=98300000 rf=-40.0 top=1 pilot=3.3 low=-0.8 offset=-4519 quiet=19.0 swing=15.0 wide=9.00 narrow=10.8 again=8.1',
    'CHANNEL: freq=98300000 rf=-40.0 top=1 pilot=10.3 low=4.8 offset=-4147 quiet=19.0 swing=15.0 wide=9.00 narrow=13.2 again=9.9',
    'CHANNEL: freq=98300000 rf=-40.2 top=1 pilot=12.1 low=7.8 offset=-4516 quiet=19.0 swing=15.0 wide=9.00 narrow=17.6 again=12.8'
  ];
  function listed(line, known) {
    return fmscan.stations(fmscan.parse(line + '\n'), { sensitivity: 8, known: known ? [98300000] : [] }).length;
  }
  // new, it is found when its usual reading passes: in two of the three
  assert.deepStrictEqual(looks.map(function(line) { return listed(line, false); }), [0, 1, 1]);
  // in the list, it stays in all three
  assert.deepStrictEqual(looks.map(function(line) { return listed(line, true); }), [1, 1, 1]);
  // but not when it is gone with the gain lowered, or reads too little narrowly as well
  assert.strictEqual(listed(looks[0].replace('again=8.1', 'again=0.4'), true), 0);
  assert.strictEqual(listed(looks[0].replace('narrow=10.8', 'narrow=6.8'), true), 0);
});

test('a survey that listens to every channel: the stations, the channels beside them, and what is spilt', function() {
  // tests/fixtures/fm-survey-every.txt: the band as a Nooelec NESDR SMArt v5 (R820T)
  // surveyed it, every channel listened to that does not lie right beside a far stronger one
  var survey = fmscan.parse(fixture('fm-survey-every.txt'));
  assert.strictEqual(survey.channels.length, 206);
  assert.ok(survey.channels.filter(function(c) { return c.pilot !== null; }).length > 160);
  var found = fmscan.judged(survey, { sensitivity: 8 });
  assert.deepStrictEqual(mhz(found.stations), ['88.8', '89.1', '89.6', '91.0', '91.3', '93.2', '93.5', '93.8', '94.9', '95.8', '96.7', '96.9',
    '97.3', '98.3', '98.5', '98.8', '100.0', '100.6', '100.9', '101.2', '101.4', '102.2', '103.6', '104.9', '105.4', '105.8', '106.2',
    '106.8', '107.3', '107.8']);
  assert.deepStrictEqual(mhz(found.stations.filter(function(s) { return s.mono; })), ['101.2']);
  // the channels next to stations pass for stations by themselves, and are left out for them
  assert.deepStrictEqual(mhz(found.beside), ['90.9', '93.4', '93.6', '97.0', '103.7', '107.9']);
  found.beside.forEach(function(channel) {
    assert.ok(found.stations.some(function(s) { return Math.abs(s.freq - channel.freq) <= 100000 && s.pilot > channel.pilot; }), mhz([channel])[0]);
  });
  assert.deepStrictEqual(mhz(fmscan.ghosts(survey, { sensitivity: 8 })), ['88.3']);
  // the dongle's tuning, from the same survey
  assert.ok(Math.abs(fmscan.tuningError(survey, { sensitivity: 8 }).ppm) <= 3);
});

test('where the tuner is driven hard, a pilot that falls a little with the gain lowered was made in the tuner', function() {
  // As surveyed beside a station of 55 dB: the first slice with the gain taken down for
  // overload, the second at full gain. 88.5 MHz fell by 3.7 dB and is not on the air;
  // 88.8 MHz, a station, rose.
  var text =
    'SLICE: freq=88450000 gain=25.4 step=15 of=29 level=39.3 cut=0.00 backoff=4.3 floor=-25.7\n' +
    'CHANNEL: freq=88500000 rf=-26.5 top=1 pilot=8.0 low=4.3 offset=2068 quiet=19.0 swing=15.0 wide=9.00 narrow=8.9 again=4.3\n' +
    'CHANNEL: freq=88800000 rf=-20.1 top=1 pilot=17.6 low=14.5 offset=-4003 quiet=20.0 swing=15.0 wide=5.00 narrow=23.6 again=18.9\n' +
    'SLICE: freq=96450000 gain=49.6 step=29 of=29 level=21.8 cut=0.00 backoff=0.0 floor=-40.2\n' +
    'CHANNEL: freq=96700000 rf=-37.0 top=1 pilot=9.4 low=5.4 offset=-147 quiet=19.7 swing=16.7 wide=8.71 narrow=13.5 again=5.7\n';
  var survey = fmscan.parse(text);
  assert.deepStrictEqual(survey.channels.map(function(c) { return c.hard; }), [true, true, false]);
  assert.deepStrictEqual(mhz(fmscan.stations(survey, { sensitivity: 8 })), ['88.8', '96.7']);
  assert.deepStrictEqual(mhz(fmscan.ghosts(survey, { sensitivity: 8 })), ['88.5']);
  // the same fall where the tuner is not driven hard is a weak station's own wandering
  assert.deepStrictEqual(mhz(fmscan.stations(fmscan.parse(text.replace('backoff=4.3', 'backoff=0.0').replace('gain=25.4', 'gain=44.5')), { sensitivity: 8 })),
    ['88.5', '88.8', '96.7']);
  // the very strong station itself, in the same slice: its reading moves by more than that
  // from one look to the next, and it is a station
  var strong = fmscan.parse(text + 'SLICE: freq=90450000 gain=22.9 step=14 of=29 level=71.7 cut=0.01 backoff=0.0 floor=-23.8\n' +
    'CHANNEL: freq=89600000 rf=18.1 top=1 pilot=56.5 low=47.2 offset=-137 quiet=58.0 swing=20.0 wide=0.00 again=50.9\n');
  assert.strictEqual(strong.channels[3].hard, true);
  assert.deepStrictEqual(mhz(fmscan.stations(strong, { sensitivity: 8 })), ['88.8', '89.6', '96.7']);
  // a slice surveyed with far less gain than another holds a very strong station too
  assert.strictEqual(fmscan.parse(text.replace('backoff=4.3', 'backoff=0.0')).channels[0].hard, true);
  // a survey of one slice, or of a tool that names no gain: nothing is hard
  assert.strictEqual(fmscan.parse('CHANNEL: freq=88500000 rf=-26.5 top=1 pilot=8.0 low=4.3 offset=2068 again=4.3\n').channels[0].hard, false);
});

test('two weak stations 100 kHz apart are both listed: each shows a carrier of its own', function() {
  function judged(lines, sensitivity, known) {
    return fmscan.judged(fmscan.parse(lines.join('\n') + '\n'), { sensitivity: sensitivity || 8, known: known });
  }
  // As surveyed one evening: a station on 96.6 MHz and a weaker one on 96.7 MHz (told by
  // ear to be two), the power of each peaking at its own centre, and the channels either
  // side of the pair, which hear them and have no peak
  var below = 'CHANNEL: freq=96500000 rf=-40.1 top=1 pilot=9.6 low=6.6 offset=5474 quiet=19.0 swing=16.0 wide=9.00 narrow=4.0 again=7.3';
  var first = 'CHANNEL: freq=96600000 rf=-35.9 top=1 pilot=16.7 low=14.9 offset=203 quiet=20.0 swing=16.0 wide=6.00 narrow=21.7 own=5.1 again=16.8';
  var second = 'CHANNEL: freq=96700000 rf=-38.2 top=1 pilot=12.5 low=9.4 offset=-7598 quiet=19.5 swing=16.0 wide=8.00 narrow=15.6 own=0.7 again=11.1';
  var above = 'CHANNEL: freq=96800000 rf=-39.0 top=1 pilot=10.7 low=5.3 offset=11812 quiet=19.0 swing=16.0 wide=9.00 narrow=6.4 own=-2.6 again=8.2';
  var found = judged([below, first, second, above]);
  assert.deepStrictEqual(mhz(found.stations), ['96.6', '96.7']);
  assert.deepStrictEqual(mhz(found.beside), ['96.5', '96.8']);
  assert.strictEqual(found.stations[1].ownCarrier, undefined, 'what the choice was made by is not handed out');

  // no peak of its own, or no better through the narrower filter: it hears its neighbour
  assert.deepStrictEqual(mhz(judged([first, second.replace('own=0.7', 'own=0.3')]).stations), ['96.6']);
  assert.deepStrictEqual(mhz(judged([first, second.replace('narrow=15.6', 'narrow=13.0')]).stations), ['96.6']);
  // where the peak cannot be measured (beside the frequency the tuner is set to): as before
  assert.deepStrictEqual(mhz(judged([first, second.replace(' own=0.7', '')]).stations), ['96.6']);

  // A made-up pair, the stronger one's pilot not faint: it is given no narrower reading,
  // comes first all the same, and the weaker one beside it is a station by its own peak
  var plain = 'CHANNEL: freq=98600000 rf=-30.1 top=1 pilot=25.3 low=22.2 offset=347 quiet=25.8 swing=18.8 wide=0.73 own=7.5 again=25.0';
  var weaker = 'CHANNEL: freq=98700000 rf=-31.7 top=1 pilot=14.6 low=11.5 offset=-5874 quiet=21.0 swing=18.0 wide=3.00 narrow=26.6 own=4.2 again=14.2';
  var echo = 'CHANNEL: freq=98800000 rf=-37.5 top=1 pilot=17.2 low=13.9 offset=-10418 quiet=20.0 swing=18.0 wide=6.00 narrow=6.4 own=-2.4 again=16.1';
  var pair = judged([plain, weaker, echo]);
  assert.deepStrictEqual(mhz(pair.stations), ['98.6', '98.7']);
  assert.deepStrictEqual(mhz(pair.beside), ['98.8']);
  // the weaker one alone beside the echo: the echo is left out for it, not the other way round
  assert.deepStrictEqual(mhz(judged([weaker, echo]).stations), ['98.7']);
});

test('the dongle\'s tuning is told although a quarter of the stations share an error of their own', function() {
  // tests/fixtures/fm-survey-corrected.txt: the band as a blue R820T stick surveyed it,
  // corrected by 58 parts per million where 51 would have been right. Six of the
  // twenty-two stations received well belong to transmitters that sit 4 kHz low together:
  // they do not agree with the rest, and are not what the dongle is judged by.
  var survey = fmscan.parse(fixture('fm-survey-corrected.txt'));
  var each = fmscan.stations(survey, { sensitivity: 3 }).filter(function(s) { return s.pilot >= 25; }).map(function(s) {
    return Math.round(-s.offset / s.freq * 1e6);
  });
  assert.strictEqual(each.length, 22);
  assert.strictEqual(each.filter(function(ppm) { return ppm > 10; }).length, 6);
  var found = fmscan.tuningError(survey, { sensitivity: 3 });
  assert.deepStrictEqual(found, { ppm: -7, stations: 16 });
});

test('a very strong station whose reading moves between the looks is a station', function() {
  // As a scan refused it once: 89.6 MHz, the strongest station of the band, 57.3 dB at
  // the first look and 45 dB with the gain lowered. What is left is a pilot no tuner makes.
  var strongest = fmscan.parse(
    'SLICE: freq=88450000 gain=29.7 step=17 of=29 level=30.2 cut=0.00 backoff=13.7 floor=-34.0\n' +
    'CHANNEL: freq=89600000 rf=7.5 top=1 pilot=57.3 low=50.1 offset=-52 quiet=58.0 swing=20.0 wide=0.00 own=20.0 again=45.0 againq=46.0 agains=20.0\n');
  assert.deepStrictEqual(mhz(fmscan.stations(strongest, { sensitivity: 8 })), ['89.6']);
  assert.deepStrictEqual(fmscan.ghosts(strongest, { sensitivity: 8 }), []);
  // a signal the overloaded tuner made, as recorded: 25.5 dB, and 4.4 dB with the gain lowered
  var made = fmscan.parse('CHANNEL: freq=88300000 rf=-3.9 top=1 pilot=25.5 low=21.8 offset=-10039 again=4.4\n');
  assert.deepStrictEqual(fmscan.stations(made, { sensitivity: 8 }), []);
  assert.strictEqual(fmscan.ghosts(made, { sensitivity: 8 }).length, 1);
  // and one that fell from 40 to 20: not plain any more, and fallen far
  var fallen = fmscan.parse('CHANNEL: freq=88300000 rf=-3.9 top=1 pilot=40.0 low=36.0 offset=100 again=20.0\n');
  assert.deepStrictEqual(fmscan.stations(fallen, { sensitivity: 8 }), []);
});

test('what a scan would say of each channel, for the tune dialog', function() {
  var survey = fmscan.parse(fixture('fm-survey-every.txt'));
  var said = {};
  fmscan.said(survey, { sensitivity: 8 }).forEach(function(channel) {
    said[(channel.freq / 1e6).toFixed(1)] = channel;
  });
  assert.strictEqual(Object.keys(said).length, survey.channels.length);
  // a station, with the reading it is judged by and its level
  assert.deepStrictEqual([said['101.4'].says, said['101.4'].reading, said['101.4'].level, said['101.4'].mono], ['stereo', 31.5, 4, false]);
  // one without a pilot: the reading is of its carrier
  assert.deepStrictEqual([said['101.2'].says, said['101.2'].reading, said['101.2'].level, said['101.2'].mono], ['mono', 27.5, 3, true]);
  // why the others are none
  assert.strictEqual(said['101.3'].says, 'off channel');
  assert.strictEqual(said['101.3'].reading, 13.2);
  assert.strictEqual(said['101.1'].says, 'no pilot');
  assert.strictEqual(said['93.4'].says, 'beside');
  assert.strictEqual(said['88.3'].says, 'made in the tuner');
  // right beside a far stronger station: not listened to, nothing read
  assert.deepStrictEqual([said['100.8'].says, said['100.8'].reading, said['100.8'].level], ['neighbour', null, null]);
  // the same stations as the scan lists
  var stations = Object.keys(said).filter(function(mhz) { return said[mhz].says === 'stereo' || said[mhz].says === 'mono'; });
  assert.strictEqual(stations.length, fmscan.judged(survey, { sensitivity: 8 }).stations.length);
});

