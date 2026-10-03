'use strict';

// No network: the DNS and HTTP answers are canned.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs-extra');
var radiodns = require('../plugin/lib/radiodns');
var Logos = require('../plugin/lib/logos');

var PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

var SI = '<?xml version="1.0"?><serviceInformation><services>' +
  '<service><shortName>Absolute</shortName>' +
  '<mediaDescription><multimedia width="32" height="32" mimeValue="image/png" url="https://logos.example/abs/32.png?v=1&amp;x=2"/></mediaDescription>' +
  '<mediaDescription><multimedia width="112" height="32" mimeValue="image/png" url="https://logos.example/abs/112x32.png"/></mediaDescription>' +
  '<mediaDescription><multimedia width="600" height="600" mimeValue="image/jpeg" url="https://logos.example/abs/600.jpg"/></mediaDescription>' +
  '<mediaDescription><multimedia width="320" height="240" mimeValue="image/png" url="https://logos.example/abs/320x240.png"/></mediaDescription>' +
  '<bearer id="dab:ce1.c181.c1c0.0" cost="20" mimeValue="audio/mpeg"/><bearer id="fm:ce1.c2a1.10580" cost="30"/></service>' +
  '<service><shortName>Bare</shortName><bearer id="dab:ce1.c181.c2a1.0" cost="20"/></service>' +
  '</services></serviceInformation>';

function network(log) {
  return {
    resolveProvider: function(name) {
      log.push('dns ' + name);
      return Promise.resolve(/\.ce1\.(dab|fm)\.radiodns\.org$/.test(name) ? { host: 'epg.example', port: 80 } : null);
    },
    get: function(url) {
      log.push('get ' + url);
      if (/SI\.xml$/.test(url)) {
        return Promise.resolve({ body: Buffer.from(SI), type: 'application/xml' });
      }
      return Promise.resolve({ body: PNG, type: 'image/png' });
    }
  };
}

function fresh(log) {
  var dir = '/tmp/logos-test-' + Math.random().toString(36).slice(2);
  return new Logos({ dir: dir, lookup: new radiodns.Lookup(network(log)) });
}

test('the name and the bearer of a DAB service', function() {
  assert.strictEqual(radiodns.dabName('ce1', 'C181', 'C1C0'), '0.c1c0.c181.ce1.dab.radiodns.org');
  assert.strictEqual(radiodns.dabBearer('ce1', 'C181', 'C1C0'), 'dab:ce1.c181.c1c0.0');
  assert.strictEqual(radiodns.dabName('ce1', 'C181', 'not hex'), null);
});

test('the name of an FM service', function() {
  assert.strictEqual(radiodns.fmName('ce1', 'C2A1', 105.8), '10580.c2a1.ce1.fm.radiodns.org');
  assert.strictEqual(radiodns.fmName('ce1', 'C2A1', '89.6'), '08960.c2a1.ce1.fm.radiodns.org');
});

test('the country codes tried start with the listener\'s part of the world', function() {
  assert.deepStrictEqual(radiodns.gccCandidates('C', 'europe').slice(0, 2), ['ce1', 'ce0']);
  assert.strictEqual(radiodns.gccCandidates('C', 'americas')[0], 'ca0');
  assert.strictEqual(radiodns.gccCandidates('1', 'australia')[0], '1f0', 'Australia');
  assert.ok(radiodns.gccCandidates('9', 'australia').indexOf('9f1') < 5, 'New Zealand, in the same block');
  assert.deepStrictEqual(radiodns.gccCandidates('x', 'europe'), []);
});

test('the logos of a service are read from the broadcaster\'s list, the largest square one chosen', function() {
  var logos = radiodns.logosOf(SI, 'dab:ce1.c181.c1c0.0');
  assert.strictEqual(logos.length, 4);
  assert.strictEqual(logos[0].url, 'https://logos.example/abs/32.png?v=1&x=2');
  assert.strictEqual(radiodns.bestLogo(logos).url, 'https://logos.example/abs/600.jpg');
  assert.deepStrictEqual(radiodns.logosOf(SI, 'dab:ce1.c181.ffff.0'), []);
  assert.strictEqual(radiodns.bestLogo([{ url: 'u', width: 112, height: 32 }]), null, 'a banner is not a logo');
});

test('a station\'s logo is fetched, kept, and handed out as a picture Volumio can serve', async function() {
  var log = [];
  var logos = fresh(log);
  var station = { channel: '11D', ensembleId: 'C181', serviceId: 'C1C0', exactName: 'Absolute Radio  ' };
  var key = logos.dabKey(station);
  assert.strictEqual(key, 'dab-c181-c1c0');
  assert.strictEqual(logos.icon(key), null);
  assert.strictEqual(await logos.fetchDab(station, 'europe'), true);
  assert.strictEqual(logos.icon(key), 'music_service/rtlsdr_radio/logos/dab-c181-c1c0.png');
  assert.ok(fs.existsSync(logos.dir + '/dab-c181-c1c0.png'));
  assert.deepStrictEqual(log, ['dns 0.c1c0.c181.ce1.dab.radiodns.org', 'get http://epg.example/radiodns/spi/3.1/SI.xml', 'get https://logos.example/abs/600.jpg']);

  // Kept across a restart, and not fetched twice
  var again = new Logos({ dir: logos.dir, lookup: new radiodns.Lookup(network(log)) });
  assert.strictEqual(again.icon(key), 'music_service/rtlsdr_radio/logos/dab-c181-c1c0.png');
  assert.strictEqual(await again.fetchDab(station, 'europe'), true);
  assert.strictEqual(log.length, 3);
});

test('a station the broadcaster lists without a logo is not asked about again for a while', async function() {
  var log = [];
  var logos = fresh(log);
  var station = { ensembleId: 'C181', serviceId: 'C2A1' };
  assert.strictEqual(await logos.fetchDab(station, 'europe'), false);
  var asked = log.length;
  assert.strictEqual(await logos.fetchDab(station, 'europe'), false);
  assert.strictEqual(log.length, asked);
  assert.strictEqual(logos.wanted(logos.dabKey(station)), false);
});

test('the stations of one broadcaster cost one download of its list', async function() {
  var log = [];
  var logos = fresh(log);
  var fetched = await logos.fetchAllDab([
    { ensembleId: 'C181', serviceId: 'C1C0' },
    { ensembleId: 'C181', serviceId: 'C2A1' },
    { ensembleId: 'C181', serviceId: 'C1C0', deleted: true },
    { ensembleId: '', serviceId: '0' }
  ], 'europe');
  assert.strictEqual(fetched, 1);
  assert.strictEqual(log.filter(function(l) { return /SI\.xml$/.test(l); }).length, 1);
});

test('a station nobody answers for is tried under the other country codes, then left', async function() {
  var log = [];
  var logos = fresh(log);
  assert.strictEqual(await logos.fetchDab({ ensembleId: '1234', serviceId: '5678' }, 'europe'), false);
  assert.strictEqual(log.filter(function(l) { return /^dns /.test(l); }).length, 21);
  assert.strictEqual(log.filter(function(l) { return /^get /.test(l); }).length, 0);
});

test('without a network nothing is recorded, so the station is tried again', async function() {
  var logos = new Logos({ dir: '/tmp/logos-test-offline', lookup: new radiodns.Lookup({
    resolveProvider: function() { return Promise.resolve({ host: 'epg.example', port: 80 }); },
    get: function() { return Promise.reject(new Error('getaddrinfo ENOTFOUND')); }
  }) });
  var station = { ensembleId: 'C181', serviceId: 'C1C0' };
  assert.strictEqual(await logos.fetchDab(station, 'europe'), false);
  assert.strictEqual(logos.wanted(logos.dabKey(station)), true);
});
