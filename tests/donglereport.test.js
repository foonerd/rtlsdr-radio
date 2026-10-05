'use strict';

// The dongle report: reading what the tools print, choosing what to record, and the
// summary. Making a report with the tools' stand-ins is in controller.test.js.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var DongleReport = require('../plugin/lib/donglereport.js');
var fmscan = require('../plugin/lib/fmscan.js');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

test('what fn-rtl_test prints is read: the dongle, its tuner, its gain steps, samples lost', function() {
  // As printed by a Nooelec NESDR SMArt XTR v5
  var e4000 = DongleReport.parseTest(fixture('rtl_test-e4000.txt'));
  assert.strictEqual(e4000.found, true);
  assert.strictEqual(e4000.device, 'Nooelec, SMArt XTR v5, SN: 00000001');
  assert.strictEqual(e4000.tuner, 'Elonics E4000');
  assert.deepStrictEqual(e4000.gains, [-1.0, 1.5, 4.0, 6.5, 9.0, 11.5, 14.0, 16.5, 19.0, 21.5, 24.0, 29.0, 34.0, 42.0]);
  assert.strictEqual(e4000.lostBytes, 0);
  assert.strictEqual(e4000.lostPerMillion, 0);

  // And by a Nooelec NESDR SMArt v5
  var r820t = DongleReport.parseTest(fixture('rtl_test-r820t.txt'));
  assert.strictEqual(r820t.tuner, 'Rafael Micro R820T');
  assert.strictEqual(r820t.gains.length, 29);
  assert.strictEqual(r820t.gains[28], 49.6);

  var lossy = DongleReport.parseTest(fixture('rtl_test-e4000.txt').replace('Signal caught',
    'lost at least 148 bytes\nlost at least 52 bytes\nSignal caught').replace('(minimum): 0', '(minimum): 31'));
  assert.strictEqual(lossy.lostBytes, 200);
  assert.strictEqual(lossy.lostPerMillion, 31);

  var none = DongleReport.parseTest('No supported devices found.\n');
  assert.strictEqual(none.found, false);
  assert.strictEqual(none.tuner, null);
  assert.deepStrictEqual(none.gains, []);
  assert.strictEqual(DongleReport.parseTest(undefined).found, false);
});

test('the gain tool\'s check of itself and its gains station by station are read', function() {
  assert.deepStrictEqual(DongleReport.parseSelftest('selftest: ok (pilot 52.9 dB, none -10.2 dB, alike 0.0 dB, unlike 17.1 dB)\n'),
    { ok: true, line: 'selftest: ok (pilot 52.9 dB, none -10.2 dB, alike 0.0 dB, unlike 17.1 dB)' });
  assert.strictEqual(DongleReport.parseSelftest('selftest: FAILED (pilot 3.0 dB)\n').ok, false);
  assert.deepStrictEqual(DongleReport.parseSelftest(''), { ok: false, line: null });

  var gains = DongleReport.parseGains('GAIN: freq=89100000 gain=19.0 step=9 of=14 level=59.7 cut=0.05 backoff=0.0\n' +
    'GAIN: freq=93500000 gain=34.0 step=13 of=14 level=6.5 cut=0.00 backoff=8.0\nBAND: gain=16.5 step=8 of=14\n');
  assert.deepStrictEqual(gains, [
    { freq: 89100000, gain: 19, step: 9, of: 14, level: 59.7, cut: 0.05, backoff: 0 },
    { freq: 93500000, gain: 34, step: 13, of: 14, level: 6.5, cut: 0, backoff: 8 }
  ]);
});

test('what is recorded: the strongest station\'s slice at a row of gains and once moved, the fullest slice, two DAB channels', function() {
  var survey = fmscan.parse(fixture('fm-survey.txt'));
  var stations = fmscan.stations(survey, { sensitivity: 8 });
  assert.ok(stations.length > 5);
  var gains = [-1.0, 1.5, 4.0, 6.5, 9.0, 11.5, 14.0, 16.5, 19.0, 21.5, 24.0, 29.0, 34.0, 42.0];
  var plan = DongleReport.recordings(survey, stations, gains, ['11D', '12B', '11A', 'nonsense']);

  var strongest = stations.slice().sort(function(a, b) { return b.rf - a.rf; })[0];
  var slice = survey.slices.filter(function(s) { return Math.abs(s.freq - strongest.freq) <= 1000000; })[0];
  var fm = plan.filter(function(entry) { return entry.kind === 'fm'; });
  var dab = plan.filter(function(entry) { return entry.kind === 'dab'; });

  // The slice of the strongest station: highest gain, the survey's gain, a low gain
  // (the fourth of the steps from 0 dB up), and the survey's gain again 500 kHz higher
  assert.strictEqual(fm[0].freq, slice.freq);
  assert.strictEqual(fm[0].gain, 42);
  assert.strictEqual(fm[0].file, 'fm-' + slice.freq + '-42.0.iq');
  assert.ok(fm.some(function(entry) { return entry.freq === slice.freq && entry.gain === slice.gain; }));
  assert.ok(fm.some(function(entry) { return entry.freq === slice.freq && entry.gain === 9; }));
  assert.ok(fm.some(function(entry) { return entry.freq === slice.freq + 500000 && entry.gain === slice.gain; }));
  // Another slice, the one with the most stations
  assert.ok(fm.some(function(entry) { return entry.freq !== slice.freq && entry.freq !== slice.freq + 500000; }));
  assert.ok(fm.length <= 5);
  fm.forEach(function(entry) { assert.strictEqual(entry.rate, 2400000); });

  // The first two usable DAB channels, each at the highest and at a middle gain
  assert.deepStrictEqual(dab.map(function(entry) { return entry.file; }),
    ['dab-222064000-42.0.iq', 'dab-222064000-21.5.iq', 'dab-225648000-42.0.iq', 'dab-225648000-21.5.iq']);
  dab.forEach(function(entry) { assert.strictEqual(entry.rate, 2048000); });

  // No file twice, and every entry says why it is made
  assert.strictEqual(new Set(plan.map(function(entry) { return entry.file; })).size, plan.length);
  plan.forEach(function(entry) { assert.ok(entry.why.length > 10); });

  // No station found: the middle of the band is recorded all the same; no gain steps: nothing
  var empty = DongleReport.recordings(survey, [], gains, []);
  assert.ok(empty.length >= 3);
  assert.ok(empty.every(function(entry) { return entry.kind === 'fm'; }));
  assert.deepStrictEqual(DongleReport.recordings(survey, stations, [], ['11D']), []);
});

test('the summary names the dongle, the survey and the stations in words', function() {
  var survey = fmscan.parse(fixture('fm-survey.txt'));
  var stations = fmscan.stations(survey, { sensitivity: 8 });
  var report = {
    form: DongleReport.REPORT_FORM,
    made: '2026-10-05T07:00:00.000Z',
    player: { plugin: '1.4.2', volumio: '4.001', board: 'Raspberry Pi 5 Model B Rev 1.1', arch: 'arm / arm' },
    settings: { 'FM gain': 'automatic', 'DAB PPM correction': 0 },
    dongle: Object.assign(DongleReport.parseTest(fixture('rtl_test-e4000.txt')),
      { usb: { id: '0bda:2838', manufacturer: 'Nooelec', product: 'SMArt XTR v5', serial: '00000001', port: '1-2', speed: '480' } }),
    selftest: { ok: true, line: 'selftest: ok (pilot 52.9 dB)' },
    fm: { band: 'europe, 87.50 to 108 MHz, raster 100 kHz', sensitivity: 8, seconds: 28.12, slices: survey.slices, channels: survey.channels.length,
      stations: stations, ghosts: [], counts: { 8: stations.length, 5: stations.length + 1, 3: stations.length + 2 },
      gains: [{ freq: 89100000, gain: 19, step: 9, of: 14, level: 59.7, cut: 0.05, backoff: 0 }] },
    recordingsAsked: true,
    recordings: [{ file: 'fm-88450000-42.0.iq', bytes: 4980736, why: 'the slice with the strongest station, at the highest gain' },
      { file: 'dab-222064000-42.0.iq', why: 'DAB channel 11D at the highest gain' }],
    problems: ['recording dab-222064000-42.0.iq: nothing was written']
  };
  var text = DongleReport.text(report);
  assert.match(text, /^FM\/DAB Radio dongle report \(form 1\)\nMade 2026-10-05T07:00:00\.000Z by plugin 1\.4\.2 on Raspberry Pi 5 Model B Rev 1\.1, Volumio 4\.001, arm \/ arm\n/);
  assert.match(text, /Calls itself: +Nooelec, SMArt XTR v5, SN: 00000001\n/);
  assert.match(text, /USB: +0bda:2838 \| Nooelec \| SMArt XTR v5, port 1-2, 480 Mbit\/s\n/);
  assert.match(text, /Tuner: +Elonics E4000\n/);
  assert.match(text, /Gain steps: +14, from -1\.0 to 42\.0 dB \(-1\.0 1\.5 /);
  assert.match(text, /Samples lost: +none in 8 s at 2\.4 million samples a second\n/);
  assert.match(text, /Survey: +28\.1 s, \d+ slices, \d+ channels\n/);
  assert.ok(text.indexOf('Stations:             ' + stations.length + ' at +8 dB, ' + (stations.length + 1) + ' at +5 dB, ' + (stations.length + 2) + ' at +3 dB (the setting here: +8 dB)') !== -1, text);
  assert.match(text, /fm-88450000-42\.0\.iq +4\.8 MB +the slice with the strongest station/);
  assert.match(text, /dab-222064000-42\.0\.iq +failed +DAB channel 11D/);
  assert.match(text, /Problems\n  recording dab-222064000-42\.0\.iq: nothing was written\n$/);
  // One line for every station listed
  var lines = text.split('\n');
  var at = lines.indexOf('  Stations at +8 dB');
  assert.strictEqual(lines[at + 1], '    MHz      pilot dB  weakest  carrier Hz  power dB');
  var first = stations[0];
  assert.strictEqual(lines[at + 2].split(/\s+/).join(' '), ' ' + [(first.freq / 1e6).toFixed(1), first.pilot, first.low, Math.round(first.offset), first.rf].join(' '));
  assert.strictEqual(lines[at + 1 + stations.length + 1], '', 'one line for every station listed, then the table ends');
  assert.strictEqual(lines[lines.indexOf('  Slices') + 1], '    MHz      gain   level of 127  cut off %  taken down  floor');

  // A survey that failed, and a report without recordings
  report.fm = { band: report.fm.band, error: 'fn-rtl-gain: the dongle delivers no samples' };
  report.recordings = [];
  report.recordingsAsked = false;
  text = DongleReport.text(report);
  assert.match(text, /Survey: +failed: fn-rtl-gain: the dongle delivers no samples\n/);
  assert.match(text, /Recordings\n  none \(not asked for\)\n/);
});
