'use strict';

// No network: the DNS and HTTP answers are canned, and so is the state of the network.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs-extra');
var radiodns = require('../plugin/lib/radiodns');
var Logos = require('../plugin/lib/logos');

var PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
var JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

function picture(size, url) {
  var parts = String(size).split('x');
  return '<mediaDescription><multimedia width="' + parts[0] + '" height="' + (parts[1] || parts[0]) +
    '" mimeValue="image/png" url="' + url + '"/></mediaDescription>';
}

// A commercial group whose stations do not carry its name, and which has no logo itself
var BAUER = '<?xml version="1.0"?><serviceInformation><services>' +
  '<serviceProvider><shortName>Bauer</shortName><mediumName>Bauer Radio</mediumName></serviceProvider>' +
  '<service><shortName>Absolute</shortName><mediumName>Absolute Radio</mediumName>' +
  picture(32, 'https://bauer.example/abs/32.png?v=1&amp;x=2') +
  picture('112x32', 'https://bauer.example/abs/112x32.png') +
  picture(600, 'https://bauer.example/abs/600.jpg') +
  picture('320x240', 'https://bauer.example/abs/320x240.png') +
  '<bearer id="dab:ce1.c181.c1c0.0" cost="20" mimeValue="audio/mpeg"/><bearer id="fm:ce1.c2a1.10580" cost="30"/></service>' +
  '<service><shortName>Bare</shortName><bearer id="dab:ce1.c181.c2a1.0" cost="20"/></service>' +
  // Listed on another ensemble than the one it is heard on here
  '<service><shortName>KISSXTRA</shortName><mediumName>KISS XTRA</mediumName>' + picture(600, 'https://bauer.example/kissxtra/600.png') +
  '<bearer id="dab:ce1.c183.cdd1.0" cost="20"/><bearer id="dab:ce1.c1a0.cdd1.0" cost="20"/></service>' +
  '</services></serviceInformation>';

// A public broadcaster whose stations carry its name, with a logo of its own
var BBC = '<?xml version="1.0"?><serviceInformation><services>' +
  '<serviceProvider><shortName>BBC</shortName><mediumName>BBC</mediumName>' +
  picture(128, 'http://bbc.example/bbc/128.png') + picture(600, 'http://bbc.example/bbc/600.png') +
  picture(1400, 'http://bbc.example/bbc/1400.png') + picture('1920x1080', 'http://bbc.example/bbc/wide.png') +
  '</serviceProvider>' +
  '<service><shortName>Radio 1</shortName><mediumName>BBC Radio 1</mediumName>' + picture(600, 'http://bbc.example/r1/600.png') +
  '<bearer id="dab:ce1.ce15.c221.0" cost="20"/></service>' +
  // Named for FM on every frequency it is sent on
  '<service><shortName>Radio 2</shortName><mediumName>BBC Radio 2</mediumName>' + picture(600, 'http://bbc.example/r2/600.png') +
  '<bearer id="dab:ce1.ce15.c222.0" cost="20"/><bearer id="fm:ce1.c202.*" cost="30"/></service>' +
  '<service><shortName>CBeebies</shortName><mediumName>CBeebies Radio</mediumName>' + picture(600, 'http://bbc.example/cb/600.png') +
  '<bearer id="dab:ce1.ce15.c22a.0" cost="20"/></service>' +
  '</services></serviceInformation>';

var REGISTERED = {
  '0.c1c0.c181.ce1.dab.radiodns.org': 'epg.bauer.example',
  '0.c2a1.c181.ce1.dab.radiodns.org': 'epg.bauer.example',
  '0.c221.ce15.ce1.dab.radiodns.org': 'epg.bbc.example',
  '0.c222.ce15.ce1.dab.radiodns.org': 'epg.bbc.example',
  '08910.c202.ce1.fm.radiodns.org': 'epg.bbc.example'
};

var ABSOLUTE = { ensembleId: 'C181', serviceId: 'C1C0', name: 'Absolute Radio', exactName: 'Absolute Radio  ' };
var BARE = { ensembleId: 'C181', serviceId: 'C2A1', name: 'Bare' };
var KISS_XTRA = { ensembleId: 'C185', serviceId: 'CDD1', name: 'KISS XTRA' };
var RADIO_1 = { ensembleId: 'CE15', serviceId: 'C221', name: 'BBC Radio 1' };
var RADIO_2 = { ensembleId: 'CE15', serviceId: 'C222', name: 'BBC Radio 2' };
var BBC_LOCAL = { ensembleId: 'C1BC', serviceId: 'C999', name: 'BBC Radio Foo' };
var LOOKALIKE = { ensembleId: 'C1BC', serviceId: 'C5F0', name: 'BBCX Extra' };
var NOBODY = { ensembleId: '1234', serviceId: '5678', name: 'Nobody FM' };

// The network as the lookup sees it. state.online: false is a network that is not there;
// with state.hotspot as well, one that answers every name with nothing, as a hotspot does.
function network(log, state) {
  state.etags = state.etags || {};
  state.broken = state.broken || {};
  return {
    reachable: function() {
      log.push('check');
      return Promise.resolve(!!state.online);
    },
    resolveProvider: function(name) {
      log.push('dns ' + name);
      if (state.onDns) {
        state.onDns(name);
      }
      if (!state.online) {
        return state.hotspot ? Promise.resolve(null) :
          Promise.reject(Object.assign(new Error('queryCname ECONNREFUSED ' + name), { code: 'ECONNREFUSED' }));
      }
      return Promise.resolve(REGISTERED[name] ? { host: REGISTERED[name], port: 80 } : null);
    },
    get: function(url, maxBytes, known) {
      log.push('get ' + url + (known ? ' (if newer)' : ''));
      if (!state.online) {
        return Promise.reject(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }));
      }
      var host = /^https?:\/\/([^\/]+)/.exec(url)[1];
      if (state.broken[host]) {
        return Promise.reject(Object.assign(new Error('HTTP 503 for ' + url), { status: 503 }));
      }
      if (state.portal) {
        return Promise.resolve({ body: Buffer.from('<html><body>Sign in to use this network</body></html>'), type: 'text/html' });
      }
      if (state.dead && state.dead[url]) {
        return Promise.reject(Object.assign(new Error('HTTP 404 for ' + url), { status: 404 }));
      }
      if (state.odd && state.odd[url]) {
        return Promise.resolve({ body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), type: 'image/svg+xml' });
      }
      if (/SI\.xml$/.test(url)) {
        return Promise.resolve({ body: Buffer.from(host === 'epg.bbc.example' ? BBC : BAUER), type: 'application/xml' });
      }
      var etag = state.etags[url] || 'v1';
      if (known && known.etag === etag) {
        return Promise.resolve({ unchanged: true });
      }
      if (state.bodies && state.bodies[url]) {
        return Promise.resolve({ body: state.bodies[url], type: 'image/png', etag: etag, modified: null });
      }
      return Promise.resolve({ body: /\.jpg$/.test(url) && etag === 'v1' ? JPG : PNG, type: 'image/png', etag: etag, modified: null });
    }
  };
}

function make(stations, options) {
  options = options || {};
  var rig = {
    log: [],
    lines: [],
    state: Object.assign({ online: true }, options.network),
    stations: stations || [],
    fm: options.fm || [],
    dir: options.dir || '/tmp/logos-test-' + Math.random().toString(36).slice(2)
  };
  rig.open = function() {
    rig.logos = new Logos({
      dir: rig.dir,
      link: options.link || null,
      lookup: new radiodns.Lookup(network(rig.log, rig.state)),
      logger: { info: function(m) { rig.lines.push(m); }, error: function(m) { rig.lines.push('ERROR ' + m); } },
      stations: function() { return rig.stations; },
      fmStations: function() { return rig.fm; },
      waits: [20],
      onLogo: function() { rig.log.push('arrived'); },
      onName: function(station, name) { rig.log.push('named ' + station.frequency + ' ' + name); }
    });
    return rig.logos;
  };
  rig.open();
  rig.asked = function(pattern) {
    return rig.log.filter(function(entry) { return pattern.test(entry); });
  };
  return rig;
}

// A picture's address without the mark it carries
function plain(icon) {
  return icon && icon.replace(/&v=[0-9a-z]+$/, '');
}

function mark(icon) {
  return icon && /&v=([0-9a-z]+)$/.exec(icon)[1];
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function until(condition, what) {
  for (var i = 0; i < 600; i++) {
    if (condition()) {
      return;
    }
    await sleep(5);
  }
  assert.fail('never happened: ' + what);
}

function idle(rig) {
  return until(function() { return rig.logos.status().state === 'idle'; }, 'the work to end');
}

function waiting(rig) {
  return until(function() { return rig.logos.status().state === 'waiting'; }, 'the wait for the network');
}

// --- names, lists ---------------------------------------------------------------------

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

test('the logos of a service are read from the broadcaster\'s list, the 600 pixel square one chosen', function() {
  var logos = radiodns.logosOf(BAUER, 'dab:ce1.c181.c1c0.0');
  assert.strictEqual(logos.length, 4);
  assert.strictEqual(logos[0].url, 'https://bauer.example/abs/32.png?v=1&x=2');
  assert.strictEqual(radiodns.bestLogo(logos).url, 'https://bauer.example/abs/600.jpg');
  assert.deepStrictEqual(radiodns.logosOf(BAUER, 'dab:ce1.c181.ffff.0'), []);
  assert.strictEqual(radiodns.bestLogo([{ url: 'u', width: 112, height: 32 }]), null, 'a banner is not a logo');
  assert.strictEqual(radiodns.bestLogo([{ url: 'a', width: 128, height: 128 }, { url: 'b', width: 320, height: 320 }]).url, 'b',
    'the largest square, when none is large enough');
  assert.strictEqual(radiodns.bestLogo([{ url: 'a', width: 1400, height: 1400 }, { url: 'b', width: 600, height: 600 }]).url, 'b',
    'not a larger one than screens ask for');
  assert.deepStrictEqual(radiodns.rankLogos(logos).map(function(l) { return l.width + 'x' + l.height; }), ['600x600', '32x32', '320x240'],
    'the ones worth showing, the best first; the banner is none of them');
});

test('a list tells of the broadcaster, and of every service it lists with a logo', function() {
  var bbc = radiodns.providerOf(BBC);
  assert.deepStrictEqual(bbc.names, ['BBC']);
  assert.deepStrictEqual(bbc.leads, ['BBC'], 'its stations carry its name');
  assert.strictEqual(bbc.logo, 'http://bbc.example/bbc/600.png');

  var bauer = radiodns.providerOf(BAUER);
  assert.deepStrictEqual(bauer.names, ['Bauer', 'Bauer Radio']);
  assert.deepStrictEqual(bauer.leads, [], 'its stations do not carry its name');
  assert.strictEqual(bauer.logo, null);

  assert.deepStrictEqual(radiodns.dabServicesOf(BAUER), {
    'ce1.c1c0': 'https://bauer.example/abs/600.jpg',
    'ce1.cdd1': 'https://bauer.example/kissxtra/600.png'
  });
});

test('a name begins with a broadcaster\'s name only as a whole word', function() {
  assert.ok(radiodns.startsWith('BBC Radio 4', 'bbc'));
  assert.ok(radiodns.startsWith('BBC6 Music', 'BBC'));
  assert.ok(radiodns.startsWith('BBC', 'BBC'));
  assert.ok(!radiodns.startsWith('BBCX Extra', 'BBC'));
  assert.ok(!radiodns.startsWith('Radio BBC', 'BBC'));
  assert.ok(!radiodns.startsWith('anything', ''));
});

// --- fetching ---------------------------------------------------------------------------

test('a station\'s logo is fetched when the station is shown, kept, and handed out as a picture Volumio can serve', async function() {
  var rig = make([ABSOLUTE]);
  assert.strictEqual(rig.logos.dabKey(ABSOLUTE), 'dab-c181-c1c0');
  assert.strictEqual(rig.logos.icon(ABSOLUTE), null);
  assert.strictEqual(rig.logos.want(ABSOLUTE), true);
  await idle(rig);
  assert.strictEqual(plain(rig.logos.icon(ABSOLUTE)), 'music_service/rtlsdr_radio/logos/dab-c181-c1c0.jpg');
  assert.ok(fs.existsSync(rig.dir + '/dab-c181-c1c0.jpg'));
  assert.deepStrictEqual(rig.asked(/^(dns|get)/), ['dns 0.c1c0.c181.ce1.dab.radiodns.org',
    'get http://epg.bauer.example/radiodns/spi/3.1/SI.xml', 'get https://bauer.example/abs/600.jpg']);
  assert.strictEqual(rig.asked(/^arrived/).length, 1, 'the plugin is told, so that the screen can show it');

  // Kept across a restart, and not fetched twice
  var asked = rig.log.length;
  rig.open();
  assert.strictEqual(plain(rig.logos.icon(ABSOLUTE)), 'music_service/rtlsdr_radio/logos/dab-c181-c1c0.jpg');
  assert.strictEqual(rig.logos.want(ABSOLUTE), false);
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.log.length, asked);
});

test('a station the broadcaster lists without a logo is not asked about again for a while', async function() {
  var rig = make([BARE]);
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.logos.icon(BARE), null);
  assert.ok(rig.logos.index.misses['dab-c181-c2a1']);
  var asked = rig.log.length;
  assert.strictEqual(rig.logos.want(BARE), false);
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.log.length, asked);

  // ...and is asked about again once the while has passed
  rig.logos.index.misses['dab-c181-c2a1'] = Date.now() - 8 * 24 * 3600 * 1000;
  assert.strictEqual(rig.logos.want(BARE), true);
  await idle(rig);
});

test('the stations of one broadcaster cost one download of its list', async function() {
  var rig = make([ABSOLUTE, BARE, Object.assign({ deleted: true }, ABSOLUTE), { ensembleId: '', serviceId: '0', name: 'Typed in' }]);
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.asked(/SI\.xml$/).length, 1);
  assert.strictEqual(rig.asked(/^dns/).length, 2, 'and one question each; the deleted one and the one without identifiers none');
  assert.deepStrictEqual(rig.lines, ['[RTL-SDR Radio] Logos: 1 fetched']);
});

test('a station nobody answers for is tried under the other country codes, then left', async function() {
  var rig = make([NOBODY]);
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.asked(/^dns/).length, 21);
  assert.strictEqual(rig.asked(/^get/).length, 0);
  assert.ok(rig.logos.index.misses['dab-1234-5678']);
});

test('one station found settles the country code for all that share its country digit', async function() {
  // Three stations nobody answers for, on ensembles of which nothing is known yet
  var strangers = ['C5F0', 'C5F1', 'C5F2'].map(function(sid) { return { ensembleId: 'C1BC', serviceId: sid, name: sid }; });
  var rig = make([ABSOLUTE].concat(strangers));
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.asked(/^dns/).length, 4, 'one name each, not a search through every code');
  assert.deepStrictEqual(rig.asked(/^dns .*c5f/), ['dns 0.c5f0.c1bc.ce1.dab.radiodns.org', 'dns 0.c5f1.c1bc.ce1.dab.radiodns.org',
    'dns 0.c5f2.c1bc.ce1.dab.radiodns.org']);
  assert.strictEqual(Object.keys(rig.logos.index.misses).length, 3);

  // A station of another country digit is still searched for
  rig.stations = rig.stations.concat([NOBODY]);
  rig.log.length = 0;
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.asked(/^dns/).length, 21);
});

// --- without a network ------------------------------------------------------------------

test('without a network nothing is asked, nothing is concluded and nothing is reported as an error', async function() {
  var rig = make([ABSOLUTE, NOBODY], { network: { online: false } });
  rig.logos.sweep();
  await waiting(rig);
  await sleep(150);   // several looks at the network later
  assert.strictEqual(rig.logos.status().state, 'waiting');
  assert.strictEqual(rig.logos.status().queued, 2);
  assert.strictEqual(rig.asked(/^(dns|get)/).length, 0);
  assert.ok(rig.asked(/^check/).length > 2, 'it keeps looking');
  assert.deepStrictEqual(rig.logos.index.misses, {});
  assert.deepStrictEqual(rig.lines, ['[RTL-SDR Radio] Logos: no network, 2 to fetch when it is back'], 'said once, and not as an error');
});

test('the work carries on by itself when the network is back', async function() {
  var rig = make([ABSOLUTE, NOBODY], { network: { online: false } });
  rig.logos.sweep();
  await waiting(rig);
  rig.state.online = true;
  await idle(rig);
  assert.ok(rig.logos.icon(ABSOLUTE));
  assert.ok(rig.logos.index.misses['dab-1234-5678'], 'and only now is the other station known to have no logo');
  assert.deepStrictEqual(rig.lines, [
    '[RTL-SDR Radio] Logos: no network, 2 to fetch when it is back',
    '[RTL-SDR Radio] Logos: the network is back, carrying on',
    '[RTL-SDR Radio] Logos: 1 fetched'
  ]);
});

test('a network that goes in the middle of the work costs no station its logo', async function() {
  var rig = make([NOBODY, ABSOLUTE]);
  // Gone after a few of the names of the first station have been asked for
  rig.state.onDns = function() {
    if (rig.asked(/^dns/).length === 3) {
      rig.state.online = false;
    }
  };
  rig.logos.sweep();
  await waiting(rig);
  assert.deepStrictEqual(rig.logos.index.misses, {});
  assert.strictEqual(rig.logos.status().queued, 2, 'the station in hand is put back');
  assert.strictEqual(rig.lines.filter(function(l) { return /ERROR|not fetched/.test(l); }).length, 0);

  rig.state.onDns = null;
  rig.state.online = true;
  await idle(rig);
  assert.ok(rig.logos.icon(ABSOLUTE));
  assert.ok(rig.logos.index.misses['dab-1234-5678']);
});

test('a hotspot, which answers every name with nothing, is not taken for the broadcasters\' word', async function() {
  var rig = make([NOBODY, BBC_LOCAL]);
  rig.state.onDns = function() {
    rig.state.online = false;
    rig.state.hotspot = true;
  };
  rig.logos.sweep();
  await waiting(rig);
  assert.deepStrictEqual(rig.logos.index.misses, {}, 'every name came back empty, and still no station is written off');
  assert.strictEqual(rig.logos.status().queued, 2);
});

test('a playing station looks at the network at once instead of waiting for the next look', async function() {
  var rig = make([ABSOLUTE], { network: { online: false } });
  rig.logos.waits = [60000];
  rig.logos.sweep();
  await waiting(rig);
  rig.state.online = true;
  rig.logos.want(ABSOLUTE, { now: true });
  await idle(rig);
  assert.ok(rig.logos.icon(ABSOLUTE));
});

test('a broadcaster\'s server in trouble is not the station\'s fault, and does not hold up the others', async function() {
  var rig = make([ABSOLUTE, RADIO_1], { network: { online: true, broken: { 'epg.bauer.example': true } } });
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.logos.icon(ABSOLUTE), null);
  assert.ok(rig.logos.icon(RADIO_1));
  assert.deepStrictEqual(rig.logos.index.misses, {});
  assert.ok(rig.lines.some(function(l) { return /dab-c181-c1c0 not fetched: HTTP 503/.test(l); }));
  assert.ok(!rig.lines.some(function(l) { return /^ERROR/.test(l); }));

  // Not asked again straight away, however often the station is shown
  var asked = rig.log.length;
  assert.strictEqual(rig.logos.want(ABSOLUTE), false);
  assert.strictEqual(rig.log.length, asked);

  // The user's refresh asks again, and by then the server is well
  rig.state.broken = {};
  rig.logos.refresh();
  await idle(rig);
  assert.ok(rig.logos.icon(ABSOLUTE));
});

test('a logo that is listed but not to be had gives way to the next best one listed', async function() {
  var rig = make([ABSOLUTE], { network: { online: true,
    dead: { 'https://bauer.example/abs/600.jpg': true },
    odd: { 'https://bauer.example/abs/32.png?v=1&x=2': true } } });
  rig.logos.sweep();
  await idle(rig);
  assert.deepStrictEqual(rig.asked(/^get https:\/\/bauer\.example\/abs/), [
    'get https://bauer.example/abs/600.jpg',
    'get https://bauer.example/abs/32.png?v=1&x=2',
    'get https://bauer.example/abs/320x240.png'
  ], 'the square ones first, then the one that is no banner');
  assert.strictEqual(plain(rig.logos.icon(ABSOLUTE)), 'music_service/rtlsdr_radio/logos/dab-c181-c1c0.png');
});

test('a station whose listed logos are all dead is left for a week, like one without', async function() {
  var rig = make([KISS_XTRA, RADIO_1, ABSOLUTE], { network: { online: true, dead: {
    'https://bauer.example/kissxtra/600.png': true, 'http://bbc.example/r1/600.png': true } } });
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(plain(rig.logos.icon(RADIO_1)), 'music_service/rtlsdr_radio/logos/group-epg.bbc.example.png',
    'no logo of its own to be had: its broadcaster\'s');
  assert.strictEqual(rig.logos.icon(KISS_XTRA), null, 'and its broadcaster has none');
  assert.ok(rig.logos.index.misses['dab-ce15-c221']);
  assert.ok(rig.logos.index.misses['dab-c185-cdd1']);
  assert.strictEqual(rig.lines.filter(function(l) { return /the logo listed is not to be had/.test(l); }).length, 2, 'said once each');
  assert.ok(!rig.lines.some(function(l) { return /^ERROR/.test(l); }));

  var asked = rig.log.length;
  assert.strictEqual(rig.logos.want(RADIO_1), false);
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.log.length, asked, 'and not asked for at every turn');
});

test('the sign-in page of a guest network is not taken for a broadcaster\'s answer', async function() {
  var rig = make([ABSOLUTE, BARE], { network: { online: true, portal: true } });
  rig.logos.sweep();
  await idle(rig);
  assert.deepStrictEqual(rig.logos.index.misses, {});
  assert.deepStrictEqual(rig.logos.index.directory, {});
  assert.ok(rig.lines.every(function(l) { return /not fetched: not a service list/.test(l); }), rig.lines.join('\n'));

  // Signed in: the refresh the user asks for finds the logo
  rig.state.portal = false;
  rig.logos.refresh();
  await idle(rig);
  assert.ok(rig.logos.icon(ABSOLUTE));
});

// --- the order of the work --------------------------------------------------------------

test('the station being played goes first, stations without a logo next, logos kept last', async function() {
  var rig = make([RADIO_1]);
  rig.logos.sweep();
  await idle(rig);
  rig.log.length = 0;

  rig.stations = [RADIO_1, RADIO_2, ABSOLUTE, BARE];
  rig.logos.refresh();
  rig.logos.want(BARE, { now: true });
  await idle(rig);
  assert.deepStrictEqual(rig.asked(/^dns/), [
    'dns 0.c2a1.c181.ce1.dab.radiodns.org',   // played now
    'dns 0.c222.ce15.ce1.dab.radiodns.org',   // without a logo
    'dns 0.c1c0.c181.ce1.dab.radiodns.org',   // without a logo
    'dns 0.c221.ce15.ce1.dab.radiodns.org'    // kept: checked for a newer version
  ]);
});

test('a refresh fetches only what is new', async function() {
  var rig = make([ABSOLUTE]);
  rig.logos.sweep();
  await idle(rig);
  var file = rig.dir + '/dab-c181-c1c0.jpg';
  var written = fs.statSync(file).mtimeMs;
  rig.log.length = 0;

  await sleep(20);
  var status = rig.logos.refresh();
  assert.strictEqual(status.state, 'fetching');
  await idle(rig);
  assert.deepStrictEqual(rig.asked(/^get .*600/), ['get https://bauer.example/abs/600.jpg (if newer)']);
  assert.strictEqual(fs.statSync(file).mtimeMs, written, 'the server had nothing newer: the picture is left alone');
  assert.strictEqual(rig.asked(/^arrived/).length, 0);

  // The broadcaster changes the picture
  rig.state.etags['https://bauer.example/abs/600.jpg'] = 'v2';
  rig.logos.refresh();
  await idle(rig);
  assert.strictEqual(plain(rig.logos.icon(ABSOLUTE)), 'music_service/rtlsdr_radio/logos/dab-c181-c1c0.png');
  assert.ok(!fs.existsSync(file), 'the old picture is not left behind');
  assert.strictEqual(rig.asked(/^arrived/).length, 1);
});

test('a refresh asks again for the stations written off before', async function() {
  var rig = make([NOBODY]);
  rig.logos.sweep();
  await idle(rig);
  rig.log.length = 0;
  rig.logos.refresh();
  await idle(rig);
  assert.strictEqual(rig.asked(/^dns/).length, 21);
});

// --- another ensemble, and the broadcaster's own logo -----------------------------------

test('a station its broadcaster lists on another ensemble gets its own logo', async function() {
  // Asked about before the list that names it has been fetched for another station
  var rig = make([KISS_XTRA, ABSOLUTE]);
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(plain(rig.logos.icon(KISS_XTRA)), 'music_service/rtlsdr_radio/logos/dab-c185-cdd1.png');
  assert.ok(rig.asked(/^get/).indexOf('get https://bauer.example/kissxtra/600.png') !== -1);
  assert.strictEqual(rig.logos.index.misses['dab-c185-cdd1'], undefined);

  // On a later day, with the list long forgotten: what it said is remembered
  var later = make([KISS_XTRA, ABSOLUTE], { dir: rig.dir });
  fs.removeSync(rig.dir + '/dab-c185-cdd1.png');
  later.logos.sweep();
  await idle(later);
  assert.ok(later.logos.icon(KISS_XTRA));
  assert.strictEqual(later.asked(/SI\.xml/).length, 0);
});

test('a station without a logo of its own is shown with its broadcaster\'s', async function() {
  var typedIn = { name: 'BBC Typed In' };
  var rig = make([RADIO_1, BBC_LOCAL, LOOKALIKE, ABSOLUTE, BARE, typedIn]);
  rig.logos.sweep();
  await idle(rig);

  assert.strictEqual(plain(rig.logos.icon(RADIO_1)), 'music_service/rtlsdr_radio/logos/dab-ce15-c221.png', 'its own');
  assert.strictEqual(plain(rig.logos.icon(BBC_LOCAL)), 'music_service/rtlsdr_radio/logos/group-epg.bbc.example.png', 'the BBC\'s');
  assert.strictEqual(plain(rig.logos.icon(typedIn)), 'music_service/rtlsdr_radio/logos/group-epg.bbc.example.png', 'by its name alone');
  assert.strictEqual(rig.logos.icon(LOOKALIKE), null, 'BBCX is not the BBC');
  assert.strictEqual(rig.logos.icon(BARE), null, 'its broadcaster has no logo of its own');
  assert.strictEqual(rig.asked(/^get http:\/\/bbc\.example\/bbc\//).join(), 'get http://bbc.example/bbc/600.png', 'fetched once, in the size screens ask for');

  assert.deepStrictEqual(rig.logos.status(), { state: 'idle', queued: 0, stations: 6, own: 2, group: 2, none: 2 });
});

test('a broadcaster\'s logo is not fetched while no station needs it', async function() {
  var rig = make([RADIO_1, RADIO_2]);
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.asked(/^get http:\/\/bbc\.example\/bbc\//).length, 0);

  // A scan finds a station that does
  rig.stations = [RADIO_1, RADIO_2, BBC_LOCAL];
  rig.logos.sweep();
  await idle(rig);
  assert.ok(/group-epg\.bbc\.example/.test(rig.logos.icon(BBC_LOCAL)));
});

test('a name another broadcaster\'s station carries too is no sign of belonging', async function() {
  // A station of the commercial group that happens to be called "BBC ..."
  var tribute = { ensembleId: 'C181', serviceId: 'C1C0', name: 'BBC Tribute Radio' };
  var rig = make([RADIO_1, tribute, BBC_LOCAL]);
  rig.logos.sweep();
  await idle(rig);
  assert.ok(rig.logos.icon(tribute), 'it has its own logo');
  assert.strictEqual(rig.logos.icon(BBC_LOCAL), null, 'and the name alone no longer says whose a station is');
});

// --- where the pictures are kept --------------------------------------------------------

test('the pictures outlive the plugin\'s folder, which an update empties', async function() {
  var base = '/tmp/logos-test-link-' + Math.random().toString(36).slice(2);
  fs.ensureDirSync(base + '/plugin');
  var rig = make([ABSOLUTE], { dir: base + '/store', link: base + '/plugin/logos' });
  rig.logos.sweep();
  await idle(rig);
  assert.ok(fs.lstatSync(base + '/plugin/logos').isSymbolicLink());
  assert.ok(fs.existsSync(base + '/plugin/logos/dab-c181-c1c0.jpg'), 'reachable where Volumio serves pictures from');

  // The update: the folder goes, as Volumio removes it, and a new one comes
  fs.removeSync(base + '/plugin');
  assert.ok(fs.existsSync(base + '/store/dab-c181-c1c0.jpg'));
  fs.ensureDirSync(base + '/plugin');
  var asked = rig.log.length;
  rig.open();
  assert.ok(fs.existsSync(base + '/plugin/logos/dab-c181-c1c0.jpg'));
  assert.ok(rig.logos.icon(ABSOLUTE));
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.log.length, asked, 'nothing is fetched again');

  // A folder left in the link's place is replaced by the link
  fs.removeSync(base + '/plugin/logos');
  fs.ensureDirSync(base + '/plugin/logos');
  rig.open();
  assert.ok(fs.lstatSync(base + '/plugin/logos').isSymbolicLink());
});

test('a picture\'s address changes with every installation and every replaced picture, and not otherwise', async function() {
  // Volumio tells screens to keep what an address gave them for a month, its default
  // picture included, which is what it gives while an update has the plugin folder away
  var base = '/tmp/logos-test-mark-' + Math.random().toString(36).slice(2);
  fs.ensureDirSync(base + '/plugin');
  var rig = make([RADIO_1], { dir: base + '/store', link: base + '/plugin/logos' });
  rig.logos.sweep();
  await idle(rig);
  var first = rig.logos.icon(RADIO_1);
  assert.strictEqual(plain(first), 'music_service/rtlsdr_radio/logos/dab-ce15-c221.png');
  assert.ok(mark(first), 'the address carries a mark');

  // The player restarts: the same picture under the same address
  await sleep(15);
  rig.open();
  assert.strictEqual(rig.logos.icon(RADIO_1), first);

  // An update replaces the plugin folder; the link is made anew: a new address
  await sleep(15);
  fs.removeSync(base + '/plugin');
  fs.ensureDirSync(base + '/plugin');
  rig.open();
  var afterUpdate = rig.logos.icon(RADIO_1);
  assert.strictEqual(plain(afterUpdate), plain(first), 'the same picture');
  assert.notStrictEqual(mark(afterUpdate), mark(first), 'under an address no screen has seen');

  // The same when the installer has made the link before the plugin starts
  await sleep(15);
  fs.removeSync(base + '/plugin/logos');
  fs.symlinkSync(base + '/store', base + '/plugin/logos');
  rig.open();
  var afterInstaller = rig.logos.icon(RADIO_1);
  assert.notStrictEqual(mark(afterInstaller), mark(afterUpdate));

  // The broadcaster replaces the picture: a new address again, the file name the same
  await sleep(15);
  rig.state.etags['http://bbc.example/r1/600.png'] = 'v2';
  rig.state.bodies = { 'http://bbc.example/r1/600.png': Buffer.concat([PNG, Buffer.from('new artwork')]) };
  rig.logos.refresh();
  await idle(rig);
  var afterRefresh = rig.logos.icon(RADIO_1);
  assert.strictEqual(plain(afterRefresh), plain(first));
  assert.notStrictEqual(mark(afterRefresh), mark(afterInstaller));

  // A refresh that finds nothing newer leaves the address alone
  rig.logos.refresh();
  await idle(rig);
  assert.strictEqual(rig.logos.icon(RADIO_1), afterRefresh);
});

test('a stop leaves what is not done, without a trace', async function() {
  var rig = make([ABSOLUTE, RADIO_1, NOBODY], { network: { online: false } });
  rig.logos.sweep();
  await waiting(rig);
  rig.logos.stop();
  assert.deepStrictEqual(rig.logos.status(), { state: 'idle', queued: 0, stations: 3, own: 0, group: 0, none: 3 });
  var asked = rig.log.length;
  await sleep(60);
  assert.strictEqual(rig.log.length, asked, 'no more looks at the network');

  // And the next start picks the work up again
  rig.state.online = true;
  rig.logos.sweep();
  await idle(rig);
  assert.ok(rig.logos.icon(ABSOLUTE));
});

// --- FM ---------------------------------------------------------------------------------

var OTHER_PNG = Buffer.concat([PNG, Buffer.from('another picture')]);

test('an FM station whose PI code is known is found through RadioDNS, whatever frequency its list names', async function() {
  var station = { frequency: '89.1', name: 'FM 89.1', pi: 'C202' };
  var rig = make([], { fm: [station] });
  assert.strictEqual(rig.logos.fmKey(station), 'fm-08910');
  assert.strictEqual(rig.logos.icon(station), null);
  assert.strictEqual(rig.logos.want(station), true);
  await idle(rig);
  assert.strictEqual(plain(rig.logos.icon(station)), 'music_service/rtlsdr_radio/logos/fm-08910.png');
  assert.deepStrictEqual(rig.asked(/^(dns|get|named)/), ['dns 08910.c202.ce1.fm.radiodns.org',
    'get http://epg.bbc.example/radiodns/spi/3.1/SI.xml', 'named 89.1 BBC Radio 2', 'get http://bbc.example/r2/600.png']);
  assert.strictEqual(rig.asked(/^arrived/).length, 1);

  // Not looked up again, in this run or the next
  assert.strictEqual(rig.logos.want(station), false);
  rig.open();
  assert.strictEqual(rig.logos.want(station), false);
  assert.deepStrictEqual(rig.logos.status(), { state: 'idle', queued: 0, stations: 1, own: 1, group: 0, none: 0 });
});

test('an FM station with neither a PI code nor a name is not looked up', async function() {
  var station = { frequency: '98.5', name: 'FM 98.5' };
  var rig = make([], { fm: [station] });
  assert.strictEqual(rig.logos.want(station), false);
  rig.logos.sweep();
  await idle(rig);
  assert.deepStrictEqual(rig.asked(/^(dns|get)/), []);
  assert.strictEqual(rig.logos.icon(station), null);
  assert.strictEqual(rig.logos.status().none, 1);
});

test('an FM station is found by its name among the user\'s DAB stations, and given a copy of the logo kept', async function() {
  var fm = { frequency: '88.8', name: 'FM 88.8', customName: 'BBC Radio 2 National' };
  var rig = make([RADIO_2], { fm: [fm] });
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(plain(rig.logos.icon(fm)), 'music_service/rtlsdr_radio/logos/fm-08880.png');
  assert.ok(fs.readFileSync(rig.dir + '/fm-08880.png').equals(fs.readFileSync(rig.dir + '/dab-ce15-c222.png')));
  // nothing was asked of the network for it
  assert.deepStrictEqual(rig.asked(/^(dns|get)/), ['dns 0.c222.ce15.ce1.dab.radiodns.org',
    'get http://epg.bbc.example/radiodns/spi/3.1/SI.xml', 'get http://bbc.example/r2/600.png']);
  assert.ok(rig.lines.some(function(m) { return /FM 88\.8 goes by the name "BBC Radio 2 National": the logo of "BBC Radio 2" \(within\)/.test(m); }), rig.lines.join('\n'));

  // A refresh leaves the same picture, and its address, alone
  var before = rig.logos.icon(fm);
  rig.logos.refresh();
  await idle(rig);
  assert.strictEqual(rig.logos.icon(fm), before);
});

test('an FM station is found by its name in the broadcasters\' lists, when the name means one station there', async function() {
  // The user has Absolute on DAB, so Bauer's list is read; it names KISS XTRA too
  var kissXtra = { frequency: '100.0', name: 'FM 100.0', customName: 'Kiss Xtra' };
  var kiss = { frequency: '100.3', name: 'FM 100.3', customName: 'Kiss' };
  var rig = make([ABSOLUTE], { fm: [kissXtra, kiss] });
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(plain(rig.logos.icon(kissXtra)), 'music_service/rtlsdr_radio/logos/fm-10000.png');
  assert.strictEqual(rig.asked(/^get https:\/\/bauer\.example\/kissxtra/).length, 1);
  assert.strictEqual(rig.logos.icon(kiss), null, '"Kiss" is of the family of KISS XTRA, not that station');
  // and is not tried again at every sweep
  var asked = rig.log.length;
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(rig.log.length, asked);
});

test('the PI code, once RDS has told it, finds the station its name did not', async function() {
  // Named by the user for the wrong programme
  var fm = { frequency: '89.1', name: 'FM 89.1', customName: 'BBC Radio 1' };
  var rig = make([RADIO_1], { fm: [fm], network: { bodies: { 'http://bbc.example/r2/600.png': OTHER_PNG } } });
  rig.logos.sweep();
  await idle(rig);
  assert.ok(fs.readFileSync(rig.dir + '/fm-08910.png').equals(PNG), 'the logo its name leads to');
  var before = rig.logos.icon(fm);
  assert.strictEqual(rig.logos.want(fm), false);

  fm.pi = 'c202';
  assert.strictEqual(rig.logos.want(fm, { now: true }), true);
  await idle(rig);
  assert.ok(fs.readFileSync(rig.dir + '/fm-08910.png').equals(OTHER_PNG), 'the logo of the programme it is');
  assert.notStrictEqual(rig.logos.icon(fm), before, 'under an address a screen has not seen');
  // the BBC's list, read for the DAB station, already named the programme: no question asked
  assert.deepStrictEqual(rig.asked(/^dns .*fm\.radiodns/), []);
});

test('an FM station of a broadcaster whose stations carry its name is shown with the broadcaster\'s logo', async function() {
  var kent = { frequency: '96.7', name: 'FM 96.7', customName: 'BBC Radio Kent' };
  var rig = make([RADIO_1], { fm: [kent] });
  rig.logos.sweep();
  await idle(rig);
  assert.strictEqual(plain(rig.logos.icon(kent)), 'music_service/rtlsdr_radio/logos/group-epg.bbc.example.png');
  assert.deepStrictEqual(rig.logos.status(), { state: 'idle', queued: 0, stations: 2, own: 1, group: 1, none: 0 });
});

test('a list read before FM stations were looked for is read once more, and then says what they need', async function() {
  var rig = make([RADIO_1]);
  rig.logos.sweep();
  await idle(rig);
  // The index as a version before FM logos left it
  var index = fs.readJsonSync(rig.dir + '/index.json');
  Object.keys(index.groups).forEach(function(url) { delete index.groups[url].read; });
  index.named = {};
  index.fmDirectory = {};
  fs.writeJsonSync(rig.dir + '/index.json', index);

  var fm = { frequency: '89.1', name: 'FM 89.1', customName: 'BBC Radio 2' };
  rig.fm = [fm];
  rig.open();
  rig.log.length = 0;
  rig.logos.sweep();
  await idle(rig);
  assert.deepStrictEqual(rig.asked(/^(dns|get)/), ['get http://epg.bbc.example/radiodns/spi/3.1/SI.xml', 'get http://bbc.example/r2/600.png']);
  assert.strictEqual(plain(rig.logos.icon(fm)), 'music_service/rtlsdr_radio/logos/fm-08910.png');

  // Read once: not at the next sweep
  rig.fm = [fm, { frequency: '99.9', name: 'FM 99.9', customName: 'Nobody FM' }];
  rig.log.length = 0;
  rig.logos.sweep();
  await idle(rig);
  assert.deepStrictEqual(rig.asked(/^(dns|get)/), []);
});

test('without a network an FM station is neither found nor written off', async function() {
  var station = { frequency: '89.1', name: 'FM 89.1', pi: 'c202' };
  var rig = make([], { fm: [station], network: { online: false } });
  rig.logos.sweep();
  await waiting(rig);
  assert.strictEqual(rig.logos.icon(station), null);
  rig.state.online = true;
  await idle(rig);
  assert.strictEqual(plain(rig.logos.icon(station)), 'music_service/rtlsdr_radio/logos/fm-08910.png');
});
