'use strict';

// A picture handed to the player as a station's logo: its kind and size read from the
// picture itself, and what is refused.

var test = require('node:test');
var assert = require('node:assert');
var zlib = require('zlib');
var pictures = require('../plugin/lib/pictures');

// A PNG header of the given size; what follows it does not matter to the check
function png(width, height, bytes) {
  var head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, (bytes || 64) - 33))]);
}

// A JPEG as cameras write it: an application segment before the frame header
function jpg(width, height) {
  var app = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  var frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3,
    1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, frame, Buffer.alloc(32)]);
}

function svg(inner, attributes) {
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<!-- a logo -->\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100"' +
    (attributes || '') + '>' + (inner || '<circle cx="50" cy="50" r="40" fill="#c00"/>') + '</svg>');
}

test('the kind of a picture is read from the picture, not from its name', function() {
  assert.strictEqual(pictures.kind(png(600, 600)), 'png');
  assert.strictEqual(pictures.kind(jpg(600, 600)), 'jpg');
  assert.strictEqual(pictures.kind(svg()), 'svg');
  assert.strictEqual(pictures.kind(Buffer.from('﻿  <svg viewBox="0 0 1 1"></svg>')), 'svg');
  assert.strictEqual(pictures.kind(Buffer.from('%PDF-1.7 a document')), null);
  assert.strictEqual(pictures.kind(Buffer.from('<html><body><svg></svg></body></html>')), null);
  assert.strictEqual(pictures.kind(Buffer.from('GIF89a..........')), null);
  assert.strictEqual(pictures.kind(zlib.gzipSync(svg())), null);
  assert.strictEqual(pictures.kind(Buffer.alloc(0)), null);
  assert.strictEqual(pictures.kind('a string'), null);
});

test('the dimensions of a PNG and of a JPEG', function() {
  assert.deepStrictEqual(pictures.size(png(600, 400), 'png'), { width: 600, height: 400 });
  assert.deepStrictEqual(pictures.size(jpg(1920, 1080), 'jpg'), { width: 1920, height: 1080 });
  assert.strictEqual(pictures.size(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]), 'png'), null);
  assert.strictEqual(pictures.size(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 1, 2, 3, 4, 5, 6]), 'jpg'), null);
});

test('a picture of a size screens can use is taken', function() {
  assert.deepStrictEqual(pictures.check(png(600, 600)), { ok: true, kind: 'png', extension: 'png', width: 600, height: 600 });
  assert.deepStrictEqual(pictures.check(jpg(300, 300)), { ok: true, kind: 'jpg', extension: 'jpg', width: 300, height: 300 });
  assert.deepStrictEqual(pictures.check(svg()), { ok: true, kind: 'svg', extension: 'svg', width: null, height: null });
});

test('what cannot be a logo is refused, with the reason', function() {
  assert.deepStrictEqual(pictures.check(Buffer.from('%PDF-1.7 a document, not a picture')), { ok: false, reason: 'not-a-picture' });
  assert.deepStrictEqual(pictures.check(png(40, 40)), { ok: false, reason: 'too-small', width: 40, height: 40, least: 128 });
  assert.deepStrictEqual(pictures.check(png(600, 100)), { ok: false, reason: 'too-small', width: 600, height: 100, least: 128 });
  assert.deepStrictEqual(pictures.check(jpg(9000, 6000)), { ok: false, reason: 'too-many', width: 9000, height: 6000, most: 4096 });
  assert.deepStrictEqual(pictures.check(png(600, 600, pictures.MAX_BYTES + 1)), { ok: false, reason: 'too-large', limit: pictures.MAX_BYTES });
  var long = svg('<path d="' + 'M0 0 '.repeat(120000) + '"/>');
  assert.deepStrictEqual(pictures.check(long), { ok: false, reason: 'too-large', limit: pictures.MAX_SVG_BYTES });
});

test('an SVG that holds script, or points outside itself, is refused', function() {
  function refused(body) {
    var result = pictures.check(body);
    return result.ok ? null : result.reason + ' ' + result.what;
  }
  assert.strictEqual(refused(svg('<script>alert(1)</script>')), 'unsafe script');
  assert.strictEqual(refused(svg('<SCRIPT xlink:href="x.js"/>')), 'unsafe script');
  assert.strictEqual(refused(svg(null, ' onload="alert(1)"')), 'unsafe script');
  assert.strictEqual(refused(svg('<a href="javascript:alert(1)"><circle r="5"/></a>')), 'unsafe script');
  assert.strictEqual(refused(svg('<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>')), 'unsafe script');
  assert.strictEqual(refused(svg('<image href="http://elsewhere.example/a.png"/>')), 'unsafe outside');
  assert.strictEqual(refused(svg('<image xlink:href="//elsewhere.example/a.png"/>')), 'unsafe outside');
  assert.strictEqual(refused(svg('<style>@import url(http://elsewhere.example/a.css);</style>')), 'unsafe outside');
  assert.strictEqual(refused(svg('<rect fill="url( http://elsewhere.example/a.svg#x)"/>')), 'unsafe outside');
  assert.strictEqual(refused(Buffer.from('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>')), 'unsafe entity');
});

test('an SVG that uses only what is in it is taken', function() {
  var inner = '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
    '<rect fill="url(#g)" width="100" height="100"/><use xlink:href="#g"/>' +
    '<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>' +
    '<text font-family="sans-serif">Radio one = two</text>';
  assert.strictEqual(pictures.check(svg(inner)).ok, true);
});
