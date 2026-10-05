'use strict';

var test = require('node:test');
var assert = require('node:assert');
var FmQuality = require('../plugin/lib/fmquality');

// Two seconds of a signal with a pilot of the given amplitude in noise of the given
// spread, as 16-bit samples, cut into pieces of the given size.
function signal(rate, pilotAmplitude, noiseSpread, pieceSize) {
  var samples = rate * 2;
  var buffer = Buffer.alloc(samples * 2);
  var seed = 12345;
  function random() {                       // repeatable noise
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  }
  for (var i = 0; i < samples; i++) {
    var value = pilotAmplitude * Math.sin(2 * Math.PI * 19000 * i / rate) + noiseSpread * 2 * random();
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
  }
  var pieces = [];
  for (var at = 0; at < buffer.length; at += pieceSize) {
    pieces.push(buffer.subarray(at, Math.min(buffer.length, at + pieceSize)));
  }
  return pieces;
}

function readings(rate, pilotAmplitude, noiseSpread, options, pieceSize) {
  var got = [];
  var meter = new FmQuality(rate, Object.assign({ onReading: function(smoothed, db) { got.push(db); } }, options || {}));
  signal(rate, pilotAmplitude, noiseSpread, pieceSize || 4096).forEach(function(piece) { meter.feed(piece); });
  return got;
}

test('one reading a second', function() {
  assert.strictEqual(readings(240000, 1000, 300).length, 2);
});

test('a stronger pilot over the same noise reads higher, by as much as it is stronger', function() {
  var weak = readings(240000, 300, 300)[0];
  var strong = readings(240000, 3000, 300)[0];
  assert.ok(Math.abs((strong - weak) - 20) < 2, 'ten times the amplitude is 20 dB: ' + (strong - weak).toFixed(1));
});

test('noise without a pilot gives no level', function() {
  // as strong as the receiver gives it on a frequency with nothing on it: every value there is
  var db = readings(240000, 0, 16384)[0];
  assert.ok(db < 6, 'reads ' + db.toFixed(1));
  assert.strictEqual(FmQuality.level(db), null);
});

test('the reading does not depend on how the signal is cut into pieces', function() {
  var even = readings(171000, 1000, 300, null, 4096)[0];
  var odd = readings(171000, 1000, 300, null, 4097)[0];
  assert.ok(Math.abs(even - odd) < 1e-6, even + ' against ' + odd);
});

// Two seconds of what the receiver gives for a carrier in noise: tones of the given
// swings (Hz) at the given frequencies, and noise that rises with the frequency, of the
// given strength at 67 kHz
function received(rate, tones, noiseAt67) {
  var samples = rate * 2;
  var buffer = Buffer.alloc(samples * 2);
  var seed = 4321;
  function random() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  }
  var before = 0;
  for (var i = 0; i < samples; i++) {
    var value = 0;
    tones.forEach(function(tone) {
      value += 32768 * tone.swing / rate * Math.sin(2 * Math.PI * tone.at * i / rate);
    });
    // the difference of white noise rises with the frequency, as a receiver's noise does
    var now = random();
    value += noiseAt67 * (now - before) / (2 * Math.sin(Math.PI * 67000 / rate));
    before = now;
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
  }
  return buffer;
}

// The size of a pilot of the usual swing, as the receiver gives it
function usualPilot(rate) {
  return 32768 * 6750 / rate;
}

function heard(rate, tones, noiseAt67, options) {
  var got = [];
  var meter = new FmQuality(rate, Object.assign({ onReading: function(smoothed, db, mono) { got.push({ db: smoothed, mono: mono }); } }, options || {}));
  meter.feed(received(rate, tones, noiseAt67));
  return got[got.length - 1];
}

test('a station without a pilot is read by its carrier, on the scale of the pilot', function() {
  [171000, 240000].forEach(function(rate) {
    var programme = { at: 1000, swing: 40000 };
    var noise = 1.2 * usualPilot(rate);
    var stereo = heard(rate, [programme, { at: 19000, swing: 6750 }], noise);
    var mono = heard(rate, [programme], noise);
    assert.strictEqual(stereo.mono, false);
    assert.strictEqual(mono.mono, true);
    // the same noise: the same reading, with the pilot or without
    assert.ok(Math.abs(stereo.db - mono.db) < 1.5, rate + ': ' + stereo.db.toFixed(1) + ' with a pilot, ' + mono.db.toFixed(1) + ' without');
    assert.strictEqual(FmQuality.level(mono.db), 5);
    // four times the noise: 12 dB less, and still a station
    var noisier = heard(rate, [programme], 4 * noise);
    assert.strictEqual(noisier.mono, true);
    assert.ok(Math.abs((mono.db - noisier.db) - 12) < 1.5, rate + ': ' + mono.db.toFixed(1) + ' against ' + noisier.db.toFixed(1));
  });
});

test('a station without a pilot at the edge of what can be read keeps its reading', function() {
  var rate = 171000;
  // Seconds of a carrier with a programme and no pilot, one stretch after the other
  // through one meter. The noise is stood in for by steady tones where the meter reads
  // it, as strong as puts a pilot the given dB above them, so that every reading is
  // exactly that and only the meter's rule is tried.
  function through(stretches, options) {
    var got = [];
    var meter = new FmQuality(rate, Object.assign({ onReading: function(smoothed, db, mono) { got.push({ db: smoothed, mono: mono }); } }, options || {}));
    var at = 0;
    var places = [62000, 63500, 65000, 66500, 68000, 69500, 71000, 72500, 76500, 78000, 79500, 81000, 82500];
    stretches.forEach(function(stretch) {
      var size = usualPilot(rate) / Math.pow(10, stretch.quiet / 20);
      var buffer = Buffer.alloc(rate * stretch.seconds * 2);
      for (var i = 0; i < rate * stretch.seconds; i++, at++) {
        var value = 32768 * 40000 / rate * Math.sin(2 * Math.PI * 1000 * at / rate);
        for (var p = 0; p < places.length; p++) {
          // above 73 kHz as much stronger as noise is there: it rises with the frequency
          value += size * (p < 8 ? 1 : places[p] / 67000) * Math.sin(2 * Math.PI * places[p] * at / rate + p);
        }
        buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
      }
      meter.feed(buffer);
    });
    return got[got.length - 1];
  }
  // tuned to it at 25 dB: too little to be taken for a station from nothing
  var cold = through([{ quiet: 25, seconds: 6 }]);
  assert.strictEqual(cold.mono, false);
  assert.strictEqual(FmQuality.level(cold.db), null);
  // read at 27 dB first, it keeps its reading when it sinks to 25
  var held = through([{ quiet: 27, seconds: 4 }, { quiet: 25, seconds: 10 }]);
  assert.strictEqual(held.mono, true);
  assert.ok(Math.abs(held.db - 25) < 0.5, held.db.toFixed(1));
  assert.strictEqual(FmQuality.level(held.db), 3);
  // and loses it when the carrier sinks into the noise
  var gone = through([{ quiet: 27, seconds: 4 }, { quiet: 21, seconds: 12 }]);
  assert.strictEqual(gone.mono, false);

  // A station the scan listed as sending no pilot is read by its carrier from the first
  // second, also where a wide receiver lets it show no more than 23 dB
  var known = through([{ quiet: 23, seconds: 4 }], { mono: true });
  assert.strictEqual(known.mono, true);
  assert.strictEqual(FmQuality.level(known.db), 3);
  assert.strictEqual(through([{ quiet: 23, seconds: 4 }]).mono, false);
  // but not when there is nothing there today: a frequency with no carrier reads 17 to 20
  var absent = through([{ quiet: 19, seconds: 4 }], { mono: true });
  assert.strictEqual(absent.mono, false);
  assert.strictEqual(FmQuality.level(absent.db), null);
});

test('no pilot and no carrier clear of the noise: no reading', function() {
  // noise as strong as a frequency with no station on it gives: a pilot would stand
  // 20 dB above it, and one too weak to be held would do no better
  [171000, 240000].forEach(function(rate) {
    var empty = heard(rate, [], 21 * usualPilot(rate) * Math.sqrt(rate / 171000));
    assert.strictEqual(empty.mono, false);
    assert.strictEqual(FmQuality.level(empty.db), null);
  });
});

test('a subsidiary carrier in the noise band does not count as noise', function() {
  [171000, 240000].forEach(function(rate) {
    var station = [{ at: 1000, swing: 30000 }, { at: 19000, swing: 6750 }];
    var plain = heard(rate, station, usualPilot(rate));
    // a carrier at 67 kHz swinging the transmitter by 7.5 kHz, itself modulated a little
    var withCarrier = heard(rate, station.concat([{ at: 66800, swing: 3000 }, { at: 67000, swing: 5000 }, { at: 67300, swing: 3000 }]), usualPilot(rate));
    assert.ok(Math.abs(plain.db - withCarrier.db) < 3, rate + ': ' + plain.db.toFixed(1) + ' without, ' + withCarrier.db.toFixed(1) + ' with');
    assert.ok(plain.db > 35, rate + ': ' + plain.db.toFixed(1));
  });
});

test('levels', function() {
  assert.deepStrictEqual([0, 5.9, 6, 11.9, 12, 19.9, 20, 29.9, 30, 39.9, 40, 60].map(FmQuality.level),
    [null, null, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
});

test('sample rates as the settings give them', function() {
  assert.strictEqual(FmQuality.parseRate('171k'), 171000);
  assert.strictEqual(FmQuality.parseRate('240k'), 240000);
  assert.strictEqual(FmQuality.parseRate(200000), 200000);
  assert.strictEqual(FmQuality.parseRate('96k'), null, 'too low to hold the noise band');
  assert.strictEqual(FmQuality.parseRate('fast'), null);
});
