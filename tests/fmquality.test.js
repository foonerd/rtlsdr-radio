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
  var db = readings(240000, 0, 300)[0];
  assert.ok(db < 6, 'reads ' + db.toFixed(1));
  assert.strictEqual(FmQuality.level(db), null);
});

test('the reading does not depend on how the signal is cut into pieces', function() {
  var even = readings(171000, 1000, 300, null, 4096)[0];
  var odd = readings(171000, 1000, 300, null, 4097)[0];
  assert.ok(Math.abs(even - odd) < 1e-6, even + ' against ' + odd);
});

test('de-emphasis is allowed for', function() {
  var plain = readings(240000, 1000, 300)[0];
  var deemphasised = readings(240000, 1000, 300, { deemphasis: true })[0];
  assert.ok(Math.abs((plain - deemphasised) - 11) < 1e-6);
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
