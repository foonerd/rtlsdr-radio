'use strict';

// The controller against stand-in decoders (tests/fakes), in a throwaway container.
// What is tested is the wiring: which processes are started with which arguments,
// that one use of the tuner ends before the next begins, and what the player is told.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs-extra');
var http = require('http');

var CONFIG_DIR = '/data/configuration/music_service/rtlsdr_radio';

var toasts = [];
var states = [];
var modals = [];
var coreStops = 0;
var coreStopSaw = null;

// A commandRouter that accepts whatever it is asked and records what matters here
function anything() {
  return new Proxy(function() {}, {
    get: function(target, name) { return name === 'then' ? undefined : anything(); },
    apply: function() { return undefined; }
  });
}
var coreCommand = new Proxy({
  pushToastMessage: function(type, title, message) { toasts.push({ type: type, title: title, message: message }); },
  servicePushState: function(state) { states.push(Object.assign({}, state)); },
  broadcastMessage: function(name, data) { modals.push({ name: name, data: data }); },
  stateMachine: new Proxy({
    getState: function() { return { status: 'play', service: 'rtlsdr_radio', title: 'x' }; },
    // Volumio's stop reaches the service of the current queue item
    stop: function() { coreStops++; coreStopSaw = plugin.deviceState; return plugin.stop(); }
  }, { get: function(target, name) { return name in target ? target[name] : function() {}; } }),
  sharedVars: { get: function() { return 'en'; } },
  pluginManager: { getConfigurationFile: function(context, file) { return CONFIG_DIR + '/' + file; } }
}, { get: function(target, name) { return name in target ? target[name] : anything(); } });

var logs = [];
var logger = {
  info: function(m) { logs.push(m); },
  error: function(m) { logs.push('ERROR ' + m); },
  warn: function(m) { logs.push('WARN ' + m); }
};

fs.ensureDirSync(CONFIG_DIR);
fs.copySync(__dirname + '/../plugin/config.json', CONFIG_DIR + '/config.json');

var Controller = require('../plugin/index.js');
var fmscan = require('../plugin/lib/fmscan.js');
var plugin = new Controller({ coreCommand: coreCommand, logger: logger, configManager: {} });
plugin.tuner.settle = 100;
plugin.tuner.grace = 400;

// No network for the updater either; lib/update.js has tests of its own. The zip tool
// and the restart are stood in for.
var updateDid = [];
plugin.updater.network = {
  // GitHub, with no release of the plugin on it
  json: function() { return Promise.resolve([]); },
  download: function() { return Promise.reject(new Error('no network in this test')); }
};
plugin.updater.zip = function(folder, file) {
  updateDid.push('keep');
  fs.writeFileSync(file, 'the installed plugin, zipped');
  return Promise.resolve();
};
plugin.restartBackend = function() { updateDid.push('restart'); };

// No network for the station logos here; lib/logos.js has tests of its own
var logoChecks = 0;
plugin.logos.lookup.network = {
  reachable: function() { logoChecks++; return Promise.resolve(false); },
  resolveProvider: function() { return Promise.reject(new Error('no network in this test')); },
  get: function() { return Promise.reject(new Error('no network in this test')); }
};

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// The names of the running stand-ins
function running() {
  var names = ['fn-rtl_fm', 'fn-redsea', 'fn-dab', 'fn-dab-scanner', 'fn-rtl_power', 'fn-rtl-gain', 'fn-rtl_test', 'fn-rtl_sdr', 'sox', 'aplay'];
  var found = [];
  fs.readdirSync('/proc').forEach(function(entry) {
    if (!/^\d+$/.test(entry)) { return; }
    try {
      var name = fs.readFileSync('/proc/' + entry + '/comm', 'utf8').trim();
      var stat = fs.readFileSync('/proc/' + entry + '/stat', 'utf8');
      var state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (names.indexOf(name) !== -1 && state !== 'Z') { found.push(name); }
    } catch (e) { /* gone */ }
  });
  return found.sort();
}

function post(path, body) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(body || {});
    var req = http.request({ host: '127.0.0.1', port: 3456, path: path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, function(res) {
      var text = '';
      res.on('data', function(chunk) { text += chunk; });
      res.on('end', function() { resolve({ status: res.statusCode, text: text }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(path) {
  return new Promise(function(resolve, reject) {
    http.get({ host: '127.0.0.1', port: 3456, path: path }, function(res) {
      var text = '';
      res.on('data', function(chunk) { text += chunk; });
      res.on('end', function() { resolve({ status: res.statusCode, text: text }); });
    }).on('error', reject);
  });
}

// A path of the Station Manager as a browser gets it: status, headers, the body as it is
function fetchRaw(path) {
  return new Promise(function(resolve, reject) {
    http.get({ host: '127.0.0.1', port: 3456, path: path }, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
    }).on('error', reject);
  });
}

// A file sent as a browser's form sends it
function upload(path, fields, file) {
  return new Promise(function(resolve, reject) {
    var boundary = '----test' + Math.random().toString(36).slice(2);
    var parts = [];
    Object.keys(fields).forEach(function(name) {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + fields[name] + '\r\n'));
    });
    if (file) {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + file.name +
        '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
      parts.push(file.body);
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    var data = Buffer.concat(parts);
    var req = http.request({ host: '127.0.0.1', port: 3456, path: path, method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': data.length } }, function(res) {
      var text = '';
      res.on('data', function(chunk) { text += chunk; });
      res.on('end', function() { resolve({ status: res.statusCode, text: text }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// The header of a PNG of the given size
function pngOf(width, height, bytes) {
  var head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, (bytes || 200) - 33))]);
}

var DAB_NAME = 'BBC Radio1      ';
function dabTrack(name, channel) {
  return { uri: 'rtlsdr://dab/' + (channel || '12B') + '/' + encodeURIComponent(name), title: name.trim(), service: 'rtlsdr_radio' };
}
function fmTrack(frequency) {
  return { uri: 'rtlsdr://fm/' + frequency, name: 'FM ' + frequency, service: 'rtlsdr_radio' };
}

test('the plugin starts with an empty station list', async function() {
  plugin.onVolumioStart();
  await plugin.onStart();
  // A picture is not held back in these tests, except where that is what is tested
  plugin.config.set('artwork_hold', 0);
  assert.strictEqual(plugin.deviceState, 'idle');
  assert.strictEqual(plugin.stationsDb.version, 2);
});

test('FM: the four processes of the chain run, and the player is told', async function() {
  states.length = 0;
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await sleep(300);
  assert.deepStrictEqual(running(), ['aplay', 'fn-redsea', 'fn-rtl_fm', 'sox']);
  assert.strictEqual(plugin.deviceState, 'playing_fm');
  assert.strictEqual(plugin.tuner.busy(), 'playing_fm');
  assert.ok(states.some(function(s) { return s.status === 'play' && s.uri === 'rtlsdr://fm/94.9'; }));
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), /^-f 94\.9M -M fm /);
});

function gainRuns() {
  try {
    return fs.readFileSync('/tmp/fake-runs-fn-rtl-gain', 'utf8').split('\n').filter(Boolean).length;
  } catch (e) {
    return 0;
  }
}

test('FM: the gain is measured at the station\'s frequency before the receiver starts, and kept with the station', async function() {
  plugin.stationsDb.fm = [{ frequency: '94.9', name: 'FM 94.9' }];
  var before = gainRuns();
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await sleep(300);
  assert.strictEqual(gainRuns(), before + 1);
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8'), /^-f 94900000 -s 1368000$/m);
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), / -g 37\.2 /);
  assert.deepStrictEqual(running(), ['aplay', 'fn-redsea', 'fn-rtl_fm', 'sox']);
  assert.strictEqual(plugin.stationsDb.fm[0].gain, 37.2);
  assert.ok(plugin.stationsDb.fm[0].gainMeasured);

  // Played again: the gain kept with the station is used, nothing is measured
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await sleep(300);
  assert.strictEqual(gainRuns(), before + 1);
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), / -g 37\.2 /);

  // A measurement that has grown old is made again
  plugin.stationsDb.fm[0].gainMeasured = new Date(Date.now() - plugin.FM_GAIN_KEEP - 1000).toISOString();
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await sleep(300);
  assert.strictEqual(gainRuns(), before + 2);

  // And so is one made before the tuner was checked for overload
  delete plugin.stationsDb.fm[0].gainRule;
  logs.length = 0;
  process.env.FAKE_GAIN_BACKOFF = '7.4';
  try {
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(300);
  } finally {
    delete process.env.FAKE_GAIN_BACKOFF;
  }
  assert.strictEqual(gainRuns(), before + 3);
  assert.strictEqual(plugin.stationsDb.fm[0].gainRule, plugin.GAIN_RULE);

  // And one made with another dongle: what is plugged in is noted with the gain
  assert.strictEqual(plugin.stationsDb.fm[0].gainOn, plugin.usbMark());
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await sleep(300);
  assert.strictEqual(gainRuns(), before + 3, 'the same dongle: the gain kept is used');
  var mark = plugin.usbMark;
  plugin.usbMark = function() { return 'another-dongle'; };
  try {
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(300);
    assert.strictEqual(gainRuns(), before + 4);
    assert.strictEqual(plugin.stationsDb.fm[0].gainOn, 'another-dongle');
  } finally {
    plugin.usbMark = mark;
  }
  assert.ok(logs.some(function(m) { return /taken down 7\.4 dB: the tuner was overloaded/.test(m); }));
});

test('FM: what RDS says of the station is kept with it: the PI code, and a name that has stood', async function() {
  plugin.stationsDb.fm = [{ frequency: '94.9', name: 'FM 94.9' }];
  plugin.RDS_PS_HOLD = 0;
  try {
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
  } finally {
    plugin.RDS_PS_HOLD = 30000;
  }
  var station = plugin.stationsDb.fm[0];
  assert.strictEqual(station.pi, 'c201');
  assert.strictEqual(station.ps, 'TEST FM');
  assert.deepStrictEqual([station.name, station.nameFrom], ['TEST FM', 'rds']);

  // The user's own name is shown before it and is never touched; a scan leaves the learnt name
  station.customName = 'My station';
  plugin.nameFmStation(station, 'BBC Radio London', 'radiodns');
  assert.deepStrictEqual([station.customName, station.name, station.nameFrom], ['My station', 'BBC Radio London', 'radiodns']);
  plugin.nameFmStation(station, 'TEST FM', 'rds');
  assert.strictEqual(station.name, 'BBC Radio London', 'the broadcaster\'s list stands above RDS');
  var merged = plugin.mergeStationData(station, { frequency: '94.9', name: 'FM 94.9', signal_strength: '-20.0', quality: 30, level: 4 }, 'fm');
  assert.strictEqual(merged.name, 'BBC Radio London');
  plugin.stationsDb.fm = [];
});

test('FM: with automatic gain switched off, the gain the user set reaches the receiver and nothing is measured', async function() {
  var before = gainRuns();
  plugin.config.set('fm_gain_auto', false);
  plugin.config.set('fm_gain', 28);
  try {
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(300);
    assert.strictEqual(gainRuns(), before);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), / -g 28 /);
  } finally {
    plugin.config.set('fm_gain_auto', true);
    plugin.config.set('fm_gain', 50);
  }
});

test('FM: a gain that cannot be measured does not stop the station from playing', async function() {
  plugin.stationsDb.fm = [{ frequency: '97.3', name: 'FM 97.3' }];
  process.env.FAKE_GAIN_FAILS = '1';
  try {
    await plugin.clearAddPlayTrack(fmTrack('97.3'));
    await sleep(300);
  } finally {
    delete process.env.FAKE_GAIN_FAILS;
  }
  assert.deepStrictEqual(running(), ['aplay', 'fn-redsea', 'fn-rtl_fm', 'sox']);
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), /^-f 97\.3M .* -g 50 /);
  assert.strictEqual(plugin.stationsDb.fm[0].gain, undefined);
  assert.ok(logs.some(function(m) { return /Gain could not be measured: fn-rtl-gain: cannot open device 0/.test(m); }));
});

test('FM: a station asked for while another\'s gain is being measured takes its place; the first never starts', async function() {
  plugin.stationsDb.fm = [];
  process.env.FAKE_GAIN_SECONDS = '2';
  var first = Promise.resolve(plugin.clearAddPlayTrack(fmTrack('91.0'))).catch(function() {});
  await sleep(500);
  assert.deepStrictEqual(running(), ['fn-rtl-gain']);
  delete process.env.FAKE_GAIN_SECONDS;
  await plugin.clearAddPlayTrack(fmTrack('102.5'));
  await first;
  await sleep(300);
  assert.deepStrictEqual(running(), ['aplay', 'fn-redsea', 'fn-rtl_fm', 'sox']);
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), /^-f 102\.5M /);
  plugin.stationsDb.fm = [];
});

test('DAB straight after FM: the FM chain is gone before the DAB decoder starts', async function() {
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  await sleep(500);
  assert.deepStrictEqual(running(), ['aplay', 'fn-dab', 'sox']);
  assert.strictEqual(plugin.deviceState, 'playing_dab');
});

test('DAB: the service name reaches the decoder exactly, trailing spaces included', async function() {
  var args = fs.readFileSync('/tmp/fake-args-fn-dab', 'utf8').split('\n');
  // The gain is measured by the decoder itself unless the user has set a step
  assert.deepStrictEqual(args.slice(0, 5), ['-C', '12B', '-P', DAB_NAME, '-Q']);
  assert.deepStrictEqual(args.slice(5, 9), ['-D', '30', '-i', '/tmp/dab/']);
});

test('DAB: with automatic gain switched off, the step the user set reaches the decoder', async function() {
  plugin.config.set('dab_gain_auto', false);
  plugin.config.set('dab_gain', 70);
  try {
    await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
    await sleep(300);
    var args = fs.readFileSync('/tmp/fake-args-fn-dab', 'utf8').split('\n');
    assert.deepStrictEqual(args.slice(0, 6), ['-C', '12B', '-P', DAB_NAME, '-G', '70']);
    assert.deepStrictEqual(plugin.dabGainArgs(), ['-G', '70']);
  } finally {
    plugin.config.set('dab_gain_auto', true);
    assert.deepStrictEqual(plugin.dabGainArgs(), ['-Q']);
    await plugin.stop();
  }
});

test('DAB: a name full of shell characters is an argument and nothing else', async function() {
  var nasty = 'A"B $(touch /tmp/pwned) `touch /tmp/pwned2`; touch /tmp/pwned3 ';
  await plugin.clearAddPlayTrack(dabTrack(nasty));
  await sleep(400);
  assert.strictEqual(fs.readFileSync('/tmp/fake-args-fn-dab', 'utf8').split('\n')[3], nasty);
  assert.ok(!fs.existsSync('/tmp/pwned') && !fs.existsSync('/tmp/pwned2') && !fs.existsSync('/tmp/pwned3'));
});

test('DAB: a channel that is not a DAB channel is refused', async function() {
  await assert.rejects(Promise.resolve(plugin.clearAddPlayTrack(dabTrack(DAB_NAME, '12B;reboot'))));
});

test('three stations asked for at once: the last one plays, alone', async function() {
  var a = plugin.clearAddPlayTrack(fmTrack('91.0'));
  var b = plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  var c = plugin.clearAddPlayTrack(fmTrack('97.3'));
  await Promise.all([a, b, c].map(function(p) { return Promise.resolve(p).catch(function() {}); }));
  await sleep(500);
  assert.deepStrictEqual(running(), ['aplay', 'fn-redsea', 'fn-rtl_fm', 'sox']);
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), /^-f 97\.3M /);
  assert.strictEqual(plugin.deviceState, 'playing_fm');
});

test('stop: when it resolves nothing is left running, and stopping again is harmless', async function() {
  await plugin.stop();
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.deviceState, 'idle');
  await plugin.stop();
  await plugin.stop();
  assert.deepStrictEqual(running(), []);
});

test('stop, then play at once: the new station is not caught by the stop', async function() {
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  var stopped = plugin.stop();
  var played = plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  await stopped;
  await played;
  await sleep(500);
  assert.deepStrictEqual(running(), ['aplay', 'fn-dab', 'sox']);
});

test('a decoder that dies is reported, and the player is not left showing "playing"', async function() {
  toasts.length = 0;
  coreStops = 0;
  fs.readdirSync('/proc').forEach(function(entry) {
    try {
      if (/^\d+$/.test(entry) && fs.readFileSync('/proc/' + entry + '/comm', 'utf8').trim() === 'fn-dab') {
        process.kill(parseInt(entry, 10), 'SIGKILL');
      }
    } catch (e) { /* gone */ }
  });
  await sleep(800);
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.deviceState, 'idle');
  assert.ok(toasts.some(function(t) { return t.type === 'error' && /fn-dab ended/.test(t.message); }), JSON.stringify(toasts));
  assert.ok(coreStops >= 1, 'the stop went through Volumio');
});

test('pause stops the station through Volumio, so that the player shows it as stopped', async function() {
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  await sleep(500);
  assert.deepStrictEqual(running(), ['aplay', 'fn-dab', 'sox']);
  coreStops = 0;
  coreStopSaw = null;
  await plugin.pause();
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.deviceState, 'idle');
  // Volumio's pause says nothing to the screens; its stop does
  assert.strictEqual(coreStops, 1);
  // and the station had been stopped by then: its queue item carries its own picture
  assert.strictEqual(coreStopSaw, 'idle');

  // Paused, it plays again
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  await sleep(500);
  assert.deepStrictEqual(running(), ['aplay', 'fn-dab', 'sox']);
  await plugin.stop();
});

test('a dongle that delivers nothing: every wait ends, the player shows stopped, and the user is told what to do', async function() {
  var kept = { gain: plugin.GAIN_LIMIT, fm: plugin.FM_SILENT_LIMIT, dab: plugin.DAB_SILENT_LIMIT, audio: plugin.DAB_AUDIO_LIMIT };
  function told(text) { return toasts.some(function(t) { return t.type === 'error' && text.test(t.message); }); }
  var SILENT = /not delivering a signal\. Unplug it, plug it in again/;
  async function ended(what) {
    assert.deepStrictEqual(running(), [], what + ': nothing left running');
    assert.strictEqual(plugin.deviceState, 'idle', what);
    assert.ok(coreStops >= 1, what + ': stopped through Volumio');
  }
  try {
    // FM, the gain tool says the dongle gave it nothing: no receiver is started
    plugin.stationsDb.fm = [];
    toasts.length = 0; coreStops = 0; states.length = 0;
    process.env.FAKE_GAIN_SILENT = '1';
    await plugin.clearAddPlayTrack(fmTrack('97.3'));
    await sleep(400);
    delete process.env.FAKE_GAIN_SILENT;
    await ended('gain tool');
    assert.ok(told(SILENT), JSON.stringify(toasts));
    // Volumio had been told the station was starting before the measurement began
    assert.ok(states.some(function(s) { return s.status === 'play' && s.uri === 'rtlsdr://fm/97.3'; }));

    // FM, a gain tool that never ends is ended, with the same outcome
    toasts.length = 0; coreStops = 0;
    plugin.GAIN_LIMIT = 300;
    process.env.FAKE_GAIN_SECONDS = '30';
    await plugin.clearAddPlayTrack(fmTrack('97.3'));
    await sleep(900);
    delete process.env.FAKE_GAIN_SECONDS;
    plugin.GAIN_LIMIT = kept.gain;
    await ended('gain limit');
    assert.ok(told(SILENT), JSON.stringify(toasts));

    // FM, stop while the gain is being measured reaches the plugin and nothing starts afterwards
    toasts.length = 0;
    process.env.FAKE_GAIN_SECONDS = '2';
    var starting = Promise.resolve(plugin.clearAddPlayTrack(fmTrack('97.3'))).catch(function() {});
    await sleep(300);
    assert.deepStrictEqual(running(), ['fn-rtl-gain']);
    await plugin.stop();
    delete process.env.FAKE_GAIN_SECONDS;
    await starting;
    await sleep(400);
    assert.deepStrictEqual(running(), []);
    assert.strictEqual(toasts.length, 0, JSON.stringify(toasts));

    // FM, a receiver that gives no signal
    toasts.length = 0; coreStops = 0;
    plugin.FM_SILENT_LIMIT = 400;
    process.env.FAKE_FM_SILENT = '1';
    await plugin.clearAddPlayTrack(fmTrack('97.3'));
    await sleep(1200);
    delete process.env.FAKE_FM_SILENT;
    plugin.FM_SILENT_LIMIT = kept.fm;
    await ended('FM receiver');
    assert.ok(told(SILENT), JSON.stringify(toasts));

    // DAB, a decoder that never measures its gain: the dongle gives it nothing
    toasts.length = 0; coreStops = 0;
    plugin.DAB_SILENT_LIMIT = 400;
    process.env.FAKE_DAB_SILENT = '1';
    await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
    await sleep(1200);
    delete process.env.FAKE_DAB_SILENT;
    plugin.DAB_SILENT_LIMIT = kept.dab;
    await ended('DAB decoder silent');
    assert.ok(told(SILENT), JSON.stringify(toasts));

    // DAB, a decoder that gets samples, finds no station and does not end by itself
    toasts.length = 0; coreStops = 0;
    plugin.DAB_AUDIO_LIMIT = 500;
    process.env.FAKE_DAB_NO_AUDIO = '1';
    await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
    await sleep(1400);
    delete process.env.FAKE_DAB_NO_AUDIO;
    plugin.DAB_AUDIO_LIMIT = kept.audio;
    await ended('DAB decoder without audio');
    assert.ok(told(/could not be received: no usable DAB signal on channel/), JSON.stringify(toasts));
    assert.ok(!told(SILENT));
  } finally {
    ['FAKE_GAIN_SILENT', 'FAKE_GAIN_SECONDS', 'FAKE_FM_SILENT', 'FAKE_DAB_SILENT', 'FAKE_DAB_NO_AUDIO'].forEach(function(k) { delete process.env[k]; });
    plugin.GAIN_LIMIT = kept.gain; plugin.FM_SILENT_LIMIT = kept.fm; plugin.DAB_SILENT_LIMIT = kept.dab; plugin.DAB_AUDIO_LIMIT = kept.audio;
    await plugin.stop();
  }

  // And a dongle that works is not disturbed by any of it
  toasts.length = 0;
  await plugin.clearAddPlayTrack(fmTrack('97.3'));
  await sleep(600);
  assert.deepStrictEqual(running(), ['aplay', 'fn-redsea', 'fn-rtl_fm', 'sox']);
  await plugin.stop();
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  await sleep(600);
  assert.deepStrictEqual(running(), ['aplay', 'fn-dab', 'sox']);
  await plugin.stop();
  assert.strictEqual(toasts.length, 0, JSON.stringify(toasts));
});

test('a DAB service that is not found ends the playback with a message', async function() {
  toasts.length = 0;
  process.env.FAKE_DAB_FAILS = '1';
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  await sleep(700);
  delete process.env.FAKE_DAB_FAILS;
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.deviceState, 'idle');
  // Said in words a user can act on, with the station and the channel; the decoder's
  // own line goes to the log
  assert.ok(toasts.some(function(t) { return t.type === 'error' && /could not be received: no usable DAB signal on channel/.test(t.message); }), JSON.stringify(toasts));
  assert.ok(!toasts.some(function(t) { return /code 22/.test(t.message); }), JSON.stringify(toasts));
  assert.ok(logs.some(function(l) { return /Playback stopped: fn-dab ended with code 22/.test(l); }));
});

test('the gain for a station is measured on the slice the receiver reads', async function() {
  // The rate fn-rtl_fm reads the dongle at, as it works it out: a power of two times the
  // receiver rate, at least a million (its own words at 240k: "Sampling at 1920000 S/s")
  assert.strictEqual(plugin.fmCaptureRate('171k', false), 1368000);
  assert.strictEqual(plugin.fmCaptureRate('200k', false), 1600000);
  assert.strictEqual(plugin.fmCaptureRate('240k', false), 1920000);
  assert.strictEqual(plugin.fmCaptureRate('300k', false), 2400000);
  assert.strictEqual(plugin.fmCaptureRate('171k', true), 2736000);

  var list = plugin.stationsDb.fm;
  var rate = plugin.config.get('fm_sample_rate');
  plugin.stationsDb.fm = [plugin.transformStationToV2({ frequency: '94.9', name: 'FM 94.9' }, 'fm')];
  try {
    plugin.config.set('fm_sample_rate', '240k');
    var runs = gainRuns();
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    assert.strictEqual(gainRuns(), runs + 1);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8'), /^-f 94900000 -s 1920000$/m);
    assert.strictEqual(plugin.stationsDb.fm[0].gainSlice, 1920000);
    await plugin.stop();

    // Played again at the same rate: the gain is kept
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    assert.strictEqual(gainRuns(), runs + 1, 'the gain was kept');
    await plugin.stop();

    // At another receiver rate the receiver reads another slice: measured again, on that one
    plugin.config.set('fm_sample_rate', '300k');
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    assert.strictEqual(gainRuns(), runs + 2);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8'), /^-f 94900000 -s 2400000$/m);
    await plugin.stop();
  } finally {
    plugin.config.set('fm_sample_rate', rate);
    plugin.stationsDb.fm = list;
  }
});

test('FM is brought to the level of everything else, whatever the receiver rate', async function() {
  // A fully modulated station at 1 dB below full scale: 75 kHz of 240k is -10.1 dB, of 171k -7.2 dB.
  // The level comes after sox's resampler ("rate" named before it): applied before, it would
  // cut off what the receiver delivers above the audio band.
  assert.strictEqual(plugin.fmLevelGain('240k').toFixed(2), '9.10');
  assert.strictEqual(plugin.fmLevelGain('171k').toFixed(2), '6.16');
  assert.strictEqual(plugin.fmLevelGain(200000).toFixed(2), '7.52');
  assert.strictEqual(plugin.fmLevelGain('nonsense'), null);
  assert.strictEqual(plugin.fmLevelGain('50k'), null);

  var rate = plugin.config.get('fm_sample_rate');
  try {
    plugin.config.set('fm_sample_rate', '240k');
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    assert.match(fs.readFileSync('/tmp/fake-args-sox', 'utf8').trim(), / -c 2 - lowpass -1 3183\.1 rate vol 9\.10dB$/);
    await plugin.stop();
    plugin.config.set('fm_sample_rate', '171k');
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    assert.match(fs.readFileSync('/tmp/fake-args-sox', 'utf8').trim(), / -r 171k .* - lowpass -1 3183\.1 rate vol 6\.16dB$/);
    await plugin.stop();
  } finally {
    plugin.config.set('fm_sample_rate', rate);
  }

  // Oversampling is applied where the dongle can deliver it (171k) and nowhere else:
  // at a higher rate the receiver would give noise at full level, which this gain
  // would make louder still
  assert.strictEqual(plugin.fmCanOversample('171k'), true);
  assert.strictEqual(plugin.fmCanOversample('200k'), false);
  assert.strictEqual(plugin.fmCanOversample('240k'), false);
  assert.strictEqual(plugin.fmCanOversample('300k'), false);
  var over = plugin.config.get('fm_oversampling');
  try {
    plugin.config.set('fm_oversampling', true);
    plugin.config.set('fm_sample_rate', '240k');
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    assert.doesNotMatch(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), / -o 4/);
    assert.ok(logs.some(function(l) { return /FM oversampling is not used at 240k/.test(l); }));
    await plugin.stop();
    plugin.config.set('fm_sample_rate', '171k');
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), / -s 171k -o 4 /);
    await plugin.stop();
  } finally {
    plugin.config.set('fm_oversampling', over);
    plugin.config.set('fm_sample_rate', rate);
  }

  // A DAB station comes at the broadcaster's level and is left there
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  await sleep(500);
  assert.doesNotMatch(fs.readFileSync('/tmp/fake-args-sox', 'utf8'), /vol/);
  await plugin.stop();
});

test('de-emphasis is the region\'s unless one is chosen, applied to the sound and not by the receiver', async function() {
  var region = plugin.config.get('fm_region', 'europe');
  var choice = plugin.config.get('fm_deemphasis_choice', 'region');
  async function played() {
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    var args = { receiver: fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8').trim(), sox: fs.readFileSync('/tmp/fake-args-sox', 'utf8').trim() };
    await plugin.stop();
    return args;
  }
  var EU = / -c 2 - lowpass -1 3183\.1 rate vol [\d.]+dB$/;
  var US = / -c 2 - lowpass -1 2122\.1 rate vol [\d.]+dB$/;
  var NONE = / -c 2 - rate vol [\d.]+dB$/;
  try {
    // a new installation takes the region's
    assert.strictEqual(choice, 'region');
    // Europe: 50 microseconds, one pole at 3183 Hz, before the resampler and the level
    plugin.config.set('fm_region', 'europe');
    var europe = await played();
    assert.match(europe.sox, EU);
    // the receiver is not asked for its own: it has the 75 microsecond curve only, and
    // the RDS decoder and the reception meter want the signal as it is
    assert.doesNotMatch(europe.receiver, /-E/);
    // the Americas: 75 microseconds, 2122 Hz
    plugin.config.set('fm_region', 'americas');
    var americas = await played();
    assert.match(americas.sox, US);
    assert.doesNotMatch(americas.receiver, /-E/);
    // a region of one's own: 50 microseconds
    plugin.config.set('fm_region', 'custom');
    assert.match((await played()).sox, EU);

    // a country that differs from its region: East Asia's band with 75 microseconds
    plugin.config.set('fm_region', 'east_asia');
    assert.match((await played()).sox, EU);
    logs.length = 0;
    await plugin.saveFmRegion({ fm_region: { value: 'east_asia' }, fm_deemphasis_choice: { value: '75', label: 'x' } });
    assert.strictEqual(plugin.config.get('fm_deemphasis_choice'), '75');
    assert.match((await played()).sox, US);
    assert.ok(logs.some(function(m) { return /De-emphasis: 75 us \(chosen; region: east_asia\)/.test(m); }), logs.join('\n'));
    assert.match(plugin.receptionSettings()['FM de-emphasis'], /^75 us \(chosen\)$/);
    // none at all
    await plugin.saveFmRegion({ fm_region: 'east_asia', fm_deemphasis_choice: 'off' });
    assert.match((await played()).sox, NONE);
    // what is no choice is not kept
    await plugin.saveFmRegion({ fm_region: 'east_asia', fm_deemphasis_choice: { value: '60' } });
    assert.strictEqual(plugin.config.get('fm_deemphasis_choice'), 'off');
    // and back to the region's
    await plugin.saveFmRegion({ fm_region: 'east_asia', fm_deemphasis_choice: { value: 'region' } });
    assert.match((await played()).sox, EU);
    assert.match(plugin.receptionSettings()['FM de-emphasis'], /^50 us \(the region's\)$/);

    // the settings page: the choice in force, and the first choice says what the region's is
    plugin.config.set('fm_region', 'americas');
    plugin.config.set('fm_deemphasis_choice', '50');
    var page = JSON.parse(fs.readFileSync(__dirname + '/../plugin/UIConfig.json', 'utf8'));
    plugin.populateUIConfig(page);
    var field = page.sections[2].content.find(function(item) { return item.id === 'fm_deemphasis_choice'; });
    assert.deepStrictEqual(field.value, { value: '50', label: '50 µs (most of the world)' });
    assert.deepStrictEqual(field.options.map(function(o) { return o.value; }), ['region', '50', '75', 'off']);
    assert.strictEqual(field.options[0].label, 'The region\'s own (75 µs)');
    assert.ok(page.sections[2].saveButton.data.indexOf('fm_deemphasis_choice') !== -1);
    // the switch of earlier versions is gone, in every region
    plugin.config.set('fm_region', 'custom');
    page = JSON.parse(fs.readFileSync(__dirname + '/../plugin/UIConfig.json', 'utf8'));
    plugin.populateUIConfig(page);
    assert.ok(!page.sections[2].content.some(function(item) { return item.id === 'fm_deemphasis'; }));
    assert.ok(page.sections[2].content.some(function(item) { return item.id === 'fm_deemphasis_choice'; }));

    // coming from a version with the switch: a Custom region keeps what it was set to
    plugin.config.delete('fm_deemphasis_choice');
    plugin.config.set('fm_deemphasis', false);
    plugin.carryDeemphasisOver();
    assert.strictEqual(plugin.config.get('fm_deemphasis_choice'), 'off');
    plugin.config.delete('fm_deemphasis_choice');
    plugin.config.set('fm_deemphasis', true);
    plugin.carryDeemphasisOver();
    assert.strictEqual(plugin.config.get('fm_deemphasis_choice'), '50');
    // any other region had its own, and has it still
    plugin.config.delete('fm_deemphasis_choice');
    plugin.config.set('fm_region', 'americas');
    plugin.carryDeemphasisOver();
    assert.strictEqual(plugin.config.get('fm_deemphasis_choice'), 'region');
    // and a choice once made is left alone
    plugin.config.set('fm_deemphasis_choice', '75');
    plugin.config.set('fm_region', 'custom');
    plugin.carryDeemphasisOver();
    assert.strictEqual(plugin.config.get('fm_deemphasis_choice'), '75');
  } finally {
    plugin.config.set('fm_region', region);
    plugin.config.set('fm_deemphasis_choice', choice);
    plugin.config.delete('fm_deemphasis');
    modals.length = 0;
  }
  assert.deepStrictEqual(running(), []);
});

test('the browse lists count their stations, not the lines beside them', async function() {
  var before = JSON.parse(JSON.stringify(plugin.stationsDb.fm));
  function counted(view) {
    var list = view.navigation.lists[0];
    return { title: list.title, stations: list.items.filter(function(item) { return /^rtlsdr:\/\/(fm|dab)\//.test(item.uri || ''); }).length, lines: list.items.length };
  }
  try {
    // none: the list says so in a line of its own, and that line is no station
    plugin.stationsDb.fm = [];
    var none = counted(await plugin.showFmView());
    assert.strictEqual(none.title, 'FM Radio (0 stations)');
    assert.strictEqual(none.stations, 0);
    assert.ok(none.lines > 0);
    var hiddenNone = counted(await plugin.showHiddenView());
    assert.strictEqual(hiddenNone.title, 'Hidden Stations (0)');
    assert.ok(hiddenNone.lines > 0);

    // three, of which one is hidden and one deleted
    plugin.stationsDb.fm = [
      { frequency: '88.1', name: 'FM 88.1', playCount: 0 },
      { frequency: '94.9', name: 'FM 94.9', playCount: 0 },
      { frequency: '96.7', name: 'FM 96.7', playCount: 0, hidden: true },
      { frequency: '99.1', name: 'FM 99.1', playCount: 0, deleted: true }
    ];
    var some = counted(await plugin.showFmView());
    assert.strictEqual(some.stations, 2);
    assert.strictEqual(some.title, 'FM Radio (2 stations)');
    assert.ok(some.lines > some.stations);
    var hiddenSome = counted(await plugin.showHiddenView());
    assert.strictEqual(hiddenSome.title, 'Hidden Stations (' + hiddenSome.stations + ')');
    assert.ok(hiddenSome.stations >= 1);
  } finally {
    plugin.stationsDb.fm = before;
  }
});

test('FM: a station that sends no pilot is marked MONO beside its dots', async function() {
  var before = JSON.parse(JSON.stringify(plugin.stationsDb.fm));
  var DOTS = '[◦●]{5}';
  assert.match(plugin.fmTrackType(3, true), new RegExp('^FM MONO ' + DOTS + '$'));
  assert.match(plugin.fmTrackType(3, false), new RegExp('^FM ' + DOTS + '$'));
  function shown() {
    return states.length ? states[states.length - 1].trackType : null;
  }
  try {
    // the station list knows 101.2 MHz as one without a pilot: marked from the start
    plugin.stationsDb.fm = [
      { frequency: '101.2', name: 'FM 101.2', playCount: 0, mono: true },
      { frequency: '94.9', name: 'FM 94.9', playCount: 0, mono: false }
    ];
    assert.match(plugin.fmStartState('101.2', 'FM 101.2').trackType, /^FM MONO /);
    assert.match(plugin.fmStartState('94.9', 'FM 94.9').trackType, /^FM (?!MONO)/);
    assert.match(plugin.fmStartState('88.1', 'FM 88.1').trackType, /^FM (?!MONO)/);

    // while it plays, the reading says what the station sends
    async function read(db, frequency, byCarrier) {
      plugin.considerFmLevel(db, frequency, 'FM ' + frequency, byCarrier);
      await sleep(30);
      return shown();
    }
    function tuned() {
      plugin.currentRds = {};
      plugin.lastRdsState = null;
      plugin.lastRdsUpdate = 0;
      plugin.lastSignalLevel = undefined;
      states.length = 0;
    }
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(300);
    tuned();
    // a pilot of 34 dB: no mark
    assert.match(await read(34, '94.9', false), /^FM (?!MONO)/);
    // the pilot goes and the carrier stays clear: marked at once, at the same level
    assert.match(await read(34, '94.9', true), /^FM MONO /);
    assert.ok(logs.some(function(m) { return /FM reception: 34 dB, level 4\/5 \(no pilot: read from the carrier\)/.test(m); }));
    // and comes back
    assert.match(await read(34, '94.9', false), /^FM (?!MONO)/);
    // too weak to say either: the list's word holds, and for 94.9 MHz that is a pilot
    assert.match(await read(2, '94.9', false), /^FM (?!MONO)/);
    assert.strictEqual(states.filter(function(s) { return /MONO/.test(s.trackType); }).length, 1);

    // 101.2 MHz, too weak to read: the list knows it as one without a pilot
    states.length = 0;
    await plugin.clearAddPlayTrack(fmTrack('101.2'));
    await sleep(300);
    assert.ok(states.length > 0 && states.every(function(s) { return /^FM MONO /.test(s.trackType); }), JSON.stringify(states));
    tuned();
    assert.match(await read(2, '101.2', false), /^FM MONO /);
    // a pilot stands on it after all: the list is out of date, and the mark goes at once
    assert.match(await read(34, '101.2', false), /^FM (?!MONO)/);
  } finally {
    await plugin.stop();
    plugin.stationsDb.fm = before;
  }
  assert.deepStrictEqual(running(), []);
});

test('the level of FM and of DAB can be taken down, and the log says whether the sound fitted', async function() {
  // What the settings page sends is kept only when it is a level: 0 down to -12 dB
  assert.strictEqual(plugin.levelFromForm({ value: 0, label: '0 dB' }), 0);
  assert.strictEqual(plugin.levelFromForm({ value: -6, label: '-6 dB' }), -6);
  assert.strictEqual(plugin.levelFromForm('-3'), -3);
  assert.strictEqual(plugin.levelFromForm(3), null);
  assert.strictEqual(plugin.levelFromForm(-13), null);
  assert.strictEqual(plugin.levelFromForm('loud'), null);
  assert.strictEqual(plugin.levelFromForm(''), null);

  function soundLine(pattern) {
    return logs.some(function(l) { return pattern.test(l); });
  }
  var rate = plugin.config.get('fm_sample_rate');
  try {
    plugin.config.set('fm_sample_rate', '240k');
    await plugin.saveFmSettings({ fm_level: { value: -6, label: '-6 dB' } });
    assert.strictEqual(plugin.config.get('fm_level'), -6);
    // Not a level: what was set stays
    await plugin.saveFmSettings({ fm_level: { value: 4, label: '4 dB' } });
    assert.strictEqual(plugin.config.get('fm_level'), -6);

    // FM at -6 dB: the level goes into the one figure sox is given. What sox reports
    // as it ends reaches the log, with the station and the level in force.
    logs.length = 0;
    process.env.FAKE_SOX_CLIPPED = '22000';
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    assert.match(fs.readFileSync('/tmp/fake-args-sox', 'utf8').trim(), / -c 2 - lowpass -1 3183\.1 rate vol 3\.10dB$/);
    await plugin.stop();
    await sleep(200);
    delete process.env.FAKE_SOX_CLIPPED;
    assert.ok(soundLine(/Sound of FM 94\.9 MHz, level -6 dB: cut off at full scale \(22000 samples in vol\)/), logs.join('\n'));

    // A sample or two at full scale is what a resampler makes of a loud broadcast: named, not as a fault
    logs.length = 0;
    process.env.FAKE_SOX_CLIPPED = '1';
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(1500);
    await plugin.stop();
    await sleep(200);
    delete process.env.FAKE_SOX_CLIPPED;
    assert.ok(soundLine(/Sound of FM 94\.9 MHz, level -6 dB: touched full scale now and then, too seldom to hear \(1 sample in vol\)/), logs.join('\n'));

    // Back at 0 dB FM is where it was, and a station that fitted is said to have fitted
    await plugin.saveFmSettings({ fm_level: { value: 0, label: '0 dB' } });
    assert.strictEqual(plugin.config.get('fm_level'), 0);
    logs.length = 0;
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(500);
    assert.match(fs.readFileSync('/tmp/fake-args-sox', 'utf8').trim(), / -c 2 - lowpass -1 3183\.1 rate vol 9\.10dB$/);
    await plugin.stop();
    await sleep(200);
    assert.ok(soundLine(/Sound of FM 94\.9 MHz, level 0 dB: stayed below full scale/), logs.join('\n'));

    // DAB: untouched at 0 dB (the test before this one), taken down when asked
    await plugin.saveDabSettings({ dab_level: { value: -4, label: '-4 dB' } });
    assert.strictEqual(plugin.config.get('dab_level'), -4);
    logs.length = 0;
    await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
    await sleep(500);
    assert.match(fs.readFileSync('/tmp/fake-args-sox', 'utf8').trim(), / -c 2 - vol -4\.00dB$/);
    await plugin.stop();
    await sleep(200);
    assert.ok(soundLine(/Sound of DAB \S+ .+, level -4 dB: stayed below full scale/), logs.join('\n'));
  } finally {
    delete process.env.FAKE_SOX_CLIPPED;
    plugin.config.set('fm_level', 0);
    plugin.config.set('dab_level', 0);
    plugin.config.set('fm_sample_rate', rate);
  }

  // A level that got into the configuration some other way never raises the sound
  plugin.config.set('fm_level', 5);
  assert.strictEqual(plugin.levelSetting('fm_level'), 0);
  plugin.config.set('fm_level', -40);
  assert.strictEqual(plugin.levelSetting('fm_level'), -12);
  plugin.config.set('fm_level', 0);
});

test('FM scan: the band is surveyed as a job of its own, and the stations it shows are kept', async function() {
  plugin.stationsDb.fm = [
    { frequency: '100.0', name: 'FM 100.0', customName: 'Kiss', favorite: true, playCount: 4 },
    { frequency: '98.3', name: 'FM 98.3', customName: 'Not on the air' },
    { frequency: '99.3', name: 'FM 99.3', playCount: 0 },
    { frequency: '87.25', name: 'FM 87.25', playCount: 0 }
  ];
  toasts.length = 0;
  var found = await plugin.scanFm();
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.deviceState, 'idle');
  // a fast scan unless set otherwise, and the stations the list holds are listened to whatever they show
  assert.strictEqual(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8').trim(),
    '-b 87.50M:108M:100k -n 100000000 -n 98300000 -n 99300000 -n 87250000');
  assert.strictEqual(found.length, 23);

  var fm = plugin.stationsDb.fm;
  var kiss = fm.find(function(s) { return s.frequency === '100.0'; });
  // what the user made of a station stays; what the scan measured is added
  assert.deepStrictEqual([kiss.customName, kiss.favorite, kiss.playCount], ['Kiss', true, 4]);
  assert.ok(kiss.quality > 30 && kiss.level === 4, JSON.stringify(kiss));
  // a station the user keeps and the scan did not find is not removed
  assert.ok(fm.some(function(s) { return s.frequency === '98.3' && s.customName === 'Not on the air'; }));
  // one an earlier scan listed and nobody touched goes with this scan; the user is told
  assert.ok(!fm.some(function(s) { return s.frequency === '99.3'; }));
  assert.ok(toasts.some(function(t) { return /1 station\(s\) no longer found were removed/.test(t.message); }), JSON.stringify(toasts));
  // one the scan did not look at (off the raster) is left alone
  assert.ok(fm.some(function(s) { return s.frequency === '87.25'; }));
  // a station found for the first time
  var classic = fm.find(function(s) { return s.frequency === '100.9'; });
  assert.deepStrictEqual([classic.name, classic.level, classic.deleted], ['FM 100.9', 4, false]);
  // the channels beside a station are not in the list
  assert.ok(!fm.some(function(s) { return s.frequency === '100.1' || s.frequency === '100.8'; }));
  // the stations strong enough for RDS were listened to, strongest first, each at the
  // gain of its part of the band, and their PI codes kept; the others were not
  assert.deepStrictEqual(fm.filter(function(s) { return s.pi; }).map(function(s) { return s.frequency + ' ' + s.pi; }),
    ['89.6 c201', '98.5 c201', '100.9 c201', '105.4 c201']);
  assert.strictEqual(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8').trim(), '-f 98.5M -M fm -s 171k -l 0 -A std -g 49.6 -F 9');
  assert.strictEqual(kiss.pi, undefined);
  assert.strictEqual(fm.length, 25);
  var status = JSON.parse((await get('/api/status')).text);
  assert.strictEqual(status.scan, null);

  // Scanned again: a station whose code is kept is not listened to a second time
  fs.removeSync('/tmp/fake-args-fn-rtl_fm');
  await plugin.scanFm();
  assert.ok(!fs.existsSync('/tmp/fake-args-fn-rtl_fm'));
  assert.strictEqual(plugin.stationsDb.fm.find(function(s) { return s.frequency === '100.9'; }).pi, 'c201');
  assert.deepStrictEqual(running(), []);
});

test('FM scan: signals made in an overloaded tuner are left out, and named in the log', async function() {
  plugin.stationsDb.fm = [];
  logs.length = 0;
  process.env.FAKE_SURVEY = 'fm-survey-overloaded.txt';
  try {
    var found = await plugin.scanFm();
    assert.deepStrictEqual(found.map(function(s) { return s.frequency; }), ['88.8', '89.1']);
  } finally {
    delete process.env.FAKE_SURVEY;
  }
  assert.ok(logs.some(function(m) { return /the signal at 88\.30 MHz is made in the tuner, not a station/.test(m); }));
  plugin.stationsDb.fm = [];
});

test('FM scan: a dongle that tunes off is found out, and the receiver is set on the carrier from then on', async function() {
  var before = JSON.parse(JSON.stringify(plugin.stationsDb.fm));
  plugin.stationsDb.fm = [];
  logs.length = 0;
  assert.strictEqual(plugin.fmCorrection(), 0);
  // every carrier 5.3 kHz below its channel, as a dongle 54 parts per million high gives
  // them, on top of the 1 the surveying dongle was itself off by
  process.env.FAKE_SURVEY = 'fm-survey-off.txt';
  try {
    await plugin.scanFm();
    assert.strictEqual(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8').trim(), '-b 87.50M:108M:100k');
    assert.strictEqual(plugin.fmCorrection(), 55);
    assert.ok(logs.some(function(m) { return /by the carriers of \d+ stations the dongle tunes 55 parts per million high \(5\.5 kHz at 100 MHz\)/.test(m); }), logs.join('\n'));
    assert.ok(logs.some(function(m) { return /FM tuning correction set to 55 parts per million for this dongle/.test(m); }));

    // played: the gain is measured and the station received with the correction
    await plugin.clearAddPlayTrack(fmTrack('98.8'));
    await sleep(300);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8'), /^-f 98800000 -s 1368000 -p 55$/m);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), /^-f 98\.8M .* -F 9 -p 55$/m);
    await plugin.stop();

    // scanned again, now with the correction, and the carriers within a few hundred
    // hertz of their channels: it holds
    process.env.FAKE_SURVEY = 'fm-survey-carrier.txt';
    await plugin.scanFm();
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8').trim(), /^-b 87\.50M:108M:100k( -n \d+){30} -p 55$/);
    assert.strictEqual(plugin.fmCorrection(), 55);

    // another dongle in its place: the correction was the other one's
    var name = plugin.dongleName;
    plugin.dongleName = function() { return '0bda:2838:Nooelec:NESDR SMArt v5:1'; };
    try {
      assert.strictEqual(plugin.fmCorrection(), 0);
      assert.deepStrictEqual(plugin.fmCorrectionArgs(), []);
      // its own scan: carriers on their channels, nothing to correct, and that is kept for it
      await plugin.scanFm();
      assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8').trim(), /^-b 87\.50M:108M:100k( -n \d+)+$/);
      assert.strictEqual(plugin.config.get('fm_ppm_found'), 0);
      assert.strictEqual(plugin.config.get('fm_ppm_dongle'), '0bda:2838:Nooelec:NESDR SMArt v5:1');
    } finally {
      plugin.dongleName = name;
    }
    // the first dongle back: not corrected until a scan has seen it again
    assert.strictEqual(plugin.fmCorrection(), 0);
  } finally {
    delete process.env.FAKE_SURVEY;
    plugin.config.set('fm_ppm_found', 0);
    plugin.config.set('fm_ppm_dongle', '');
    plugin.stationsDb.fm = before;
    plugin.saveStations();
  }
  assert.deepStrictEqual(running(), []);
});

test('FM scan: a station without a pilot is listed, and one the list holds stays on a little less', async function() {
  var before = JSON.parse(JSON.stringify(plugin.stationsDb.fm));
  // 99.3 MHz holds nothing in this survey
  plugin.stationsDb.fm = [{ frequency: '99.3', name: 'FM 99.3', playCount: 0 }];
  var sensitivity = plugin.config.get('scan_sensitivity', 8);
  logs.length = 0;
  process.env.FAKE_SURVEY = 'fm-survey-carrier.txt';
  try {
    var found = await plugin.scanFm();
    assert.strictEqual(found.length, 30);
    var mono = plugin.stationsDb.fm.find(function(s) { return String(s.frequency) === '101.2'; });
    assert.deepStrictEqual([mono.quality, mono.level, mono.mono], [27.6, 3, true]);
    // the others send a pilot, and the list says so
    assert.strictEqual(plugin.stationsDb.fm.filter(function(s) { return s.mono; }).length, 1);
    assert.strictEqual(plugin.stationsDb.fm.find(function(s) { return String(s.frequency) === '100.9'; }).mono, false);
    assert.ok(logs.some(function(m) { return /Found station: 101\.2 MHz \(no pilot: mono, carrier 27\.6 dB clear of the noise, level 3\/5/.test(m); }), logs.join('\n'));
    assert.ok(!plugin.stationsDb.fm.some(function(s) { return String(s.frequency) === '99.3'; }));

    // a bar of 18 dB: 93.8 MHz, with its pilot of 16.7 dB, is no new station at that, but
    // the list holds it
    plugin.config.set('scan_sensitivity', 18);
    logs.length = 0;
    var again = await plugin.scanFm();
    var kept = logs.filter(function(m) { return /kept as one the list holds/.test(m); });
    assert.strictEqual(kept.length, 1, logs.join('\n'));
    assert.match(kept[0], /Found station: 93\.8 MHz \(pilot 16\.7 dB/);
    plugin.stationsDb.fm = [];
    var fresh = await plugin.scanFm();
    assert.strictEqual(again.length - fresh.length, kept.length);
  } finally {
    delete process.env.FAKE_SURVEY;
    plugin.config.set('scan_sensitivity', sensitivity);
    plugin.config.set('fm_ppm_found', 0);
    plugin.config.set('fm_ppm_dongle', '');
    plugin.stationsDb.fm = before;
    plugin.saveStations();
  }
  assert.deepStrictEqual(running(), []);
});

test('FM scan: fast or detailed, by the setting or by the choice made in the Station Manager', async function() {
  var before = JSON.parse(JSON.stringify(plugin.stationsDb.fm));
  var depth = plugin.config.get('fm_scan_depth', 'fast');
  function surveyed() {
    return fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8').trim();
  }
  async function scanOver() {
    for (var i = 0; i < 100; i++) {
      await sleep(100);
      var status = JSON.parse((await get('/api/status')).text);
      if (status.deviceState === 'idle' && status.scan === null) {
        return status;
      }
    }
    throw new Error('the scan did not end');
  }
  try {
    plugin.stationsDb.fm = [{ frequency: '98.3', name: 'FM 98.3', customName: 'Mine' }, { frequency: '101.0', name: 'FM 101.0', deleted: true }];
    // fast: the channels that stand out, and the one station the list holds (not the deleted one)
    plugin.config.set('fm_scan_depth', 'fast');
    assert.strictEqual(JSON.parse((await get('/api/status')).text).fmScanDepth, 'fast');
    await plugin.scanFm();
    assert.strictEqual(surveyed(), '-b 87.50M:108M:100k -n 98300000');
    assert.ok(logs.some(function(m) { return /Starting FM scan \(fast\)/.test(m); }));

    // detailed, chosen in the Manager's dialog: every channel, and it is the setting from then on
    plugin.stationsDb.fm = [{ frequency: '98.3', name: 'FM 98.3', customName: 'Mine' }];
    assert.strictEqual((await post('/api/stations/scan-fm', { depth: 'detailed' })).status, 200);
    var status = await scanOver();
    assert.strictEqual(surveyed(), '-b 87.50M:108M:100k -e -n 98300000');
    assert.strictEqual(status.fmScanDepth, 'detailed');
    assert.strictEqual(plugin.config.get('fm_scan_depth'), 'detailed');
    assert.ok(logs.some(function(m) { return /Starting FM scan \(detailed\)/.test(m); }));

    // asked for without a choice, or with one that is none: as set
    plugin.stationsDb.fm = [];
    await post('/api/stations/scan-fm', { depth: 'thorough' });
    await scanOver();
    assert.strictEqual(surveyed(), '-b 87.50M:108M:100k -e');
    plugin.stationsDb.fm = [];
    await post('/api/stations/scan-fm', {});
    await scanOver();
    assert.strictEqual(surveyed(), '-b 87.50M:108M:100k -e');

    // from the settings page, as the page sends it
    await plugin.saveFmSettings({ fm_scan_depth: { value: 'fast', label: 'Fast' } });
    assert.strictEqual(plugin.fmScanDepth(), 'fast');
    await plugin.saveFmSettings({ fm_scan_depth: { value: 'everything', label: '?' } });
    assert.strictEqual(plugin.fmScanDepth(), 'fast');
    // and the dongle report surveys as a scan would, and says which
    assert.strictEqual(plugin.receptionSettings()['FM scan'], 'fast');
  } finally {
    plugin.config.set('fm_scan_depth', depth);
    plugin.config.set('fm_ppm_found', 0);
    plugin.config.set('fm_ppm_dongle', '');
    plugin.stationsDb.fm = before;
    plugin.saveStations();
  }
  assert.deepStrictEqual(running(), []);
});

// A stand-in for the player's queue, for the tune dialog: it plays what it is told through
// the plugin, as Volumio does
function standInPlayer(queue) {
  var player = { queue: queue, position: 0, status: 'stop', did: [] };
  function state() {
    var item = player.queue[player.position];
    return { status: player.status, position: player.position, service: item ? item.service : undefined, uri: item ? item.uri : undefined };
  }
  function halt() {
    var ours = player.status === 'play' && player.queue[player.position] && player.queue[player.position].service === 'rtlsdr_radio';
    player.status = 'stop';
    return ours ? plugin.stop() : Promise.resolve();
  }
  var was = {};
  ['volumioGetState', 'volumioGetQueue', 'volumioPushQueue', 'volumioPushState', 'addQueueItems', 'volumioPlay', 'volumioStop', 'volumioRemoveQueueItem'].forEach(function(name) {
    was[name] = Object.getOwnPropertyDescriptor(coreCommand, name);
  });
  var machine = coreCommand.stateMachine;
  var stopWas = machine.stop;
  coreCommand.volumioGetState = state;
  coreCommand.volumioGetQueue = function() { return player.queue; };
  coreCommand.volumioPushQueue = function() { player.did.push('queue pushed'); };
  coreCommand.volumioPushState = function() { player.did.push('state pushed'); };
  coreCommand.addQueueItems = function(items) {
    return Promise.resolve(plugin.explodeUri(items[0].uri)).then(function(tracks) {
      var last = player.queue[player.queue.length - 1];
      if (last && last.uri === tracks[0].uri) {
        return { firstItemIndex: player.queue.length - 1 };   // Volumio does not add the last item a second time
      }
      player.queue = player.queue.concat(tracks);
      return { firstItemIndex: player.queue.length - 1 };
    });
  };
  coreCommand.volumioPlay = function(n) {
    return halt().then(function() {
      player.position = n;
      player.status = 'play';
      return player.queue[n].service === 'rtlsdr_radio' ? plugin.clearAddPlayTrack(player.queue[n]) : null;
    });
  };
  coreCommand.volumioStop = halt;
  coreCommand.volumioRemoveQueueItem = function(which) {
    player.did.push('removed ' + player.queue[which.value].uri);
    // as Volumio does: asked to remove the item it is on, it stops, stays on that position
    // and never answers
    if (player.position === which.value) {
      halt().then(function() { player.queue.splice(which.value, 1); });
      return new Promise(function() {});
    }
    if (player.position > which.value) {
      player.position--;
    }
    player.queue.splice(which.value, 1);
    return Promise.resolve();
  };
  machine.stop = function() { return halt(); };
  machine.playQueue = { saveQueue: function() { player.did.push('queue saved'); } };
  Object.defineProperty(machine.playQueue, 'arrayQueue', { get: function() { return player.queue; } });
  Object.defineProperty(machine, 'currentPosition', { configurable: true, get: function() { return player.position; }, set: function(n) { player.position = n; } });
  player.uris = function() { return player.queue.map(function(item) { return item.uri; }); };
  player.away = function() {
    Object.keys(was).forEach(function(name) {
      delete coreCommand[name];
    });
    machine.stop = stopWas;
    delete machine.playQueue;
    delete machine.currentPosition;
  };
  return player;
}

test('tune dialog: the channels around a station, as a scan would judge them', async function() {
  var before = JSON.parse(JSON.stringify(plugin.stationsDb.fm));
  plugin.stationsDb.fm = [
    { frequency: '100.9', name: 'FM 100.9', customName: 'Classic', playCount: 12 },
    { frequency: '101.3', name: 'FM 101.3', customName: 'Mystery', playCount: 4 },
    { frequency: '101.4', name: 'FM 101.4', playCount: 2 },
    { frequency: '99.9', name: 'FM 99.9', deleted: true }
  ];
  var player = standInPlayer([{ service: 'rtlsdr_radio', uri: 'rtlsdr://fm/100.9', name: 'Classic' }]);
  process.env.FAKE_SURVEY = 'fm-survey-every.txt';
  try {
    // the band the page steps through
    assert.deepStrictEqual(JSON.parse((await get('/api/status')).text).fmBand, { start: 87.5, end: 108, step_khz: 100 });

    // a station of ours is playing: it is stopped for the look, as for a scan
    await coreCommand.volumioPlay(0);
    await sleep(300);
    assert.strictEqual(plugin.deviceState, 'playing_fm');
    logs.length = 0;
    var answer = await post('/api/tune/survey', { frequency: '101.3' });
    assert.strictEqual(answer.status, 200, answer.text);
    var found = JSON.parse(answer.text);
    assert.deepStrictEqual(running(), []);
    assert.strictEqual(player.status, 'stop');
    assert.strictEqual(plugin.deviceState, 'idle');
    // five channels either side on the region's raster, every one listened to, with the
    // stations of the list named to the tool and the dongle's correction applied as in a scan
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8'), /^-b 100\.80M:101\.80M:100k -e -n 100900000 -n 101300000 -n 101400000$/m);
    assert.deepStrictEqual([found.frequency, found.step_khz, found.gain], ['101.3', 100, 25.4]);
    assert.deepStrictEqual(found.channels.map(function(c) { return c.frequency; }),
      ['100.8', '100.9', '101.0', '101.1', '101.2', '101.3', '101.4', '101.5', '101.6', '101.7', '101.8']);
    var by = {};
    found.channels.forEach(function(c) { by[c.frequency] = c; });
    assert.deepStrictEqual([by['101.2'].says, by['101.2'].reading, by['101.2'].level, by['101.2'].mono, by['101.2'].held], ['mono', 27.5, 3, true, null]);
    assert.deepStrictEqual([by['101.4'].says, by['101.4'].reading, by['101.4'].level, by['101.4'].held], ['stereo', 31.5, 4, 'FM 101.4']);
    assert.deepStrictEqual([by['100.9'].says, by['100.9'].held], ['stereo', 'Classic']);
    assert.deepStrictEqual([by['101.3'].says, by['101.3'].own, by['101.3'].held], ['off channel', true, null]);
    assert.deepStrictEqual([by['100.8'].says, by['100.8'].reading], ['neighbour', null]);
    // the best: the nearest a scan would list that no other station of the list holds
    assert.strictEqual(found.best, '101.2');
    assert.deepStrictEqual(found.channels.filter(function(c) { return c.best; }).map(function(c) { return c.frequency; }), ['101.2']);
    assert.ok(logs.some(function(m) { return /Tune: around 101\.3 MHz: .*101\.2 mono 27\.5 dB.*; best: 101\.2$/.test(m); }), logs.join('\n'));

    // looked around another frequency than the station's own: the station is still the one being tuned
    found = JSON.parse((await post('/api/tune/survey', { frequency: '101.5', station: '101.3' })).text);
    assert.deepStrictEqual(found.channels.filter(function(c) { return c.own; }).map(function(c) { return c.frequency; }), ['101.3']);
    assert.strictEqual(found.channels.filter(function(c) { return c.frequency === '101.3'; })[0].held, null);
    // nearest to where it looked; of two equally near, 101.4 is held, so 101.2 it is
    assert.strictEqual(found.best, '101.2');

    // at the edge of the band there are fewer channels
    found = JSON.parse((await post('/api/tune/survey', { frequency: '107.9' })).text);
    assert.deepStrictEqual(found.channels.map(function(c) { return c.frequency; }), ['107.4', '107.5', '107.6', '107.7', '107.8', '107.9', '108.0']);

    // what is no frequency of the band is refused
    assert.strictEqual((await post('/api/tune/survey', { frequency: '12' })).status, 400);
    assert.strictEqual((await post('/api/tune/survey', {})).status, 400);

    // a tool that cannot read the dongle: an answer in words, and nothing left running
    process.env.FAKE_GAIN_FAILS = '1';
    answer = await post('/api/tune/survey', { frequency: '101.3' });
    assert.strictEqual(answer.status, 500);
    assert.match(JSON.parse(answer.text).error, /cannot open device/);
  } finally {
    delete process.env.FAKE_GAIN_FAILS;
    delete process.env.FAKE_SURVEY;
    player.away();
    plugin.stationsDb.fm = before;
  }
  assert.deepStrictEqual(running(), []);
});

test('tune dialog: a frequency is listened to as an item of the queue, and the player is put back', async function() {
  var before = JSON.parse(JSON.stringify(plugin.stationsDb.fm));
  plugin.stationsDb.fm = [
    { frequency: '100.9', name: 'FM 100.9', customName: 'Classic', playCount: 12 },
    { frequency: '101.3', name: 'FM 101.3', customName: 'Mystery', playCount: 4 }
  ];
  var player = standInPlayer([{ service: 'mpd', uri: 'music/a.flac', name: 'A song' }, { service: 'mpd', uri: 'music/b.flac', name: 'B' }]);
  try {
    // the player is stopped on its second item
    player.position = 1;
    assert.strictEqual(JSON.parse((await get('/api/status')).text).tune, null);

    var answer = await post('/api/tune/listen', { frequency: '101.3' });
    assert.strictEqual(answer.status, 200, answer.text);
    await sleep(400);
    assert.deepStrictEqual(running(), ['aplay', 'fn-redsea', 'fn-rtl_fm', 'sox']);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), /^-f 101\.3M /);
    assert.deepStrictEqual(player.uris(), ['music/a.flac', 'music/b.flac', 'rtlsdr://fm/101.3']);
    assert.deepStrictEqual([player.position, player.status], [2, 'play']);
    // the page is told what is being tried, and reads the reception from the status
    plugin.considerFmLevel(31.5, '101.3', 'x', false);
    var status = JSON.parse((await get('/api/status')).text);
    assert.strictEqual(status.tune, '101.3');
    assert.deepStrictEqual([status.signal.type, status.signal.level, status.signal.db, status.signal.mono], ['fm', 4, 31.5, false]);

    // a step: the dialog's item is given the next frequency, and nothing is removed for it
    await post('/api/tune/listen', { frequency: 101.2 });
    await sleep(400);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), /^-f 101\.2M /);
    assert.deepStrictEqual(player.uris(), ['music/a.flac', 'music/b.flac', 'rtlsdr://fm/101.2']);
    assert.deepStrictEqual([player.queue[2].name, player.queue[2].artist, player.position, player.status], ['FM 101.2', '101.2 MHz', 2, 'play']);
    assert.ok(!player.did.some(function(what) { return /^removed/.test(what); }), player.did.join());
    // two steps asked for at once: one after the other, and one item at the end of it
    await Promise.all([post('/api/tune/listen', { frequency: '101.1' }), post('/api/tune/listen', { frequency: '101.0' })]);
    await sleep(400);
    assert.deepStrictEqual(player.uris(), ['music/a.flac', 'music/b.flac', 'rtlsdr://fm/101.0']);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), /^-f 101M /);

    // done: stopped, the item gone, the player on the item it was on
    answer = JSON.parse((await post('/api/tune/end')).text);
    assert.strictEqual(answer.ended, true);
    assert.deepStrictEqual(running(), []);
    assert.deepStrictEqual(player.uris(), ['music/a.flac', 'music/b.flac']);
    assert.deepStrictEqual([player.position, player.status], [1, 'stop']);
    assert.strictEqual(JSON.parse((await get('/api/status')).text).tune, null);
    // listening was no play of a station of the list
    assert.deepStrictEqual(plugin.stationsDb.fm.map(function(s) { return s.playCount; }), [12, 4]);
    assert.ok(!plugin.stationsDb.fm.some(function(s) { return s.lastPlayed; }));
    // and nothing was added to the list
    assert.strictEqual(plugin.stationsDb.fm.length, 2);
    // ended twice is no fault
    assert.strictEqual(JSON.parse((await post('/api/tune/end')).text).ended, false);

    // what was playing before plays again
    player.queue.push({ service: 'rtlsdr_radio', uri: 'rtlsdr://fm/100.9', name: 'Classic' });
    await coreCommand.volumioPlay(2);
    await sleep(300);
    assert.strictEqual(plugin.stationsDb.fm[0].playCount, 13);
    await post('/api/tune/listen', { frequency: '101.3' });
    await sleep(300);
    assert.deepStrictEqual([player.position, player.uris()[3]], [3, 'rtlsdr://fm/101.3']);
    await post('/api/tune/end');
    await sleep(400);
    assert.deepStrictEqual(player.uris(), ['music/a.flac', 'music/b.flac', 'rtlsdr://fm/100.9']);
    assert.deepStrictEqual([player.position, player.status], [2, 'play']);
    assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_fm', 'utf8'), /^-f 100\.9M /);
    // put on again by the dialog, it is not played once more by the count
    assert.strictEqual(plugin.stationsDb.fm[0].playCount, 13);

    // the frequency tried is the queue's last item already: it is the user's, and stays
    await post('/api/tune/listen', { frequency: '100.9' });
    await sleep(300);
    assert.strictEqual(player.uris().length, 3);
    await post('/api/tune/end');
    await sleep(300);
    assert.deepStrictEqual(player.uris(), ['music/a.flac', 'music/b.flac', 'rtlsdr://fm/100.9']);
    assert.deepStrictEqual([player.position, player.status, plugin.stationsDb.fm[0].playCount], [2, 'play', 13]);

    // a queue that held nothing: the dialog's item is the one the player is on, and goes all the same
    await coreCommand.volumioStop();
    var held = player.queue;
    player.queue = [];
    player.position = 0;
    await post('/api/tune/listen', { frequency: '101.3' });
    await sleep(300);
    assert.deepStrictEqual([player.uris(), player.status], [['rtlsdr://fm/101.3'], 'play']);
    await post('/api/tune/end');
    assert.deepStrictEqual([player.uris(), player.status], [[], 'stop']);
    assert.deepStrictEqual(running(), []);
    player.queue = held;
    player.position = 2;

    // the user has put something else on meanwhile: it is left alone, only the item goes
    await coreCommand.volumioStop();
    await post('/api/tune/listen', { frequency: '101.3' });
    await sleep(300);
    await coreCommand.volumioPlay(0);
    assert.deepStrictEqual([player.position, player.status], [0, 'play']);
    await post('/api/tune/end');
    assert.deepStrictEqual(player.uris(), ['music/a.flac', 'music/b.flac', 'rtlsdr://fm/100.9']);
    assert.deepStrictEqual([player.position, player.status], [0, 'play']);

    assert.strictEqual((await post('/api/tune/listen', { frequency: 'loud' })).status, 400);
  } finally {
    await plugin.tuneEnd();
    await plugin.stop();
    player.away();
    plugin.stationsDb.fm = before;
    plugin.saveStations();
  }
  assert.deepStrictEqual(running(), []);
});

test('tune dialog: a station is given the frequency, with all that is its own', async function() {
  var before = JSON.parse(JSON.stringify(plugin.stationsDb.fm));
  plugin.stationsDb.fm = [
    { frequency: '100.9', name: 'FM 100.9', customName: 'Classic', playCount: 12 },
    { frequency: '101.3', name: 'FM 101.3', customName: 'Mystery', playCount: 4, favorite: true, pi: 'C4B1' },
    { frequency: '101.4', name: 'FM 101.4', playCount: 2 },
    { frequency: '101.2', name: 'FM 101.2', deleted: true },
    { frequency: '98.5', name: 'FM 98.5' }
  ].map(function(station) { return plugin.transformStationToV2(station, 'fm'); });
  plugin.stationsDb.fm[1].favorite = true;
  plugin.stationsDb.fm[1].playCount = 4;
  plugin.stationsDb.fm[3].deleted = true;
  var player = standInPlayer([{ service: 'rtlsdr_radio', uri: 'rtlsdr://fm/101.3', name: 'Mystery', artist: '101.3 MHz' }, { service: 'mpd', uri: 'music/a.flac' }]);
  fs.ensureDirSync(plugin.logos.dir);
  fs.writeFileSync(plugin.logos.dir + '/fm-10130.png', pngOf(600, 600));
  plugin.logos.index.logos['fm-10130'] = { file: 'fm-10130.png', url: 'https://x.example/a.png', by: 'name', ref: 'X' };
  process.env.FAKE_SURVEY = 'fm-survey-every.txt';
  function list() {
    return plugin.stationsDb.fm.map(function(s) { return s.frequency + (s.deleted ? ' deleted' : ''); });
  }
  try {
    await post('/api/tune/survey', { frequency: '101.3' });

    // another station holds the frequency: nothing is changed, and the answer names it
    var answer = await post('/api/tune/keep', { from: '101.3', to: '101.4' });
    assert.strictEqual(answer.status, 409);
    assert.deepStrictEqual(JSON.parse(answer.text), { conflict: { frequency: '101.4', name: 'FM 101.4' } });
    assert.deepStrictEqual(list(), ['100.9', '101.3', '101.4', '101.2 deleted', '98.5']);

    // a free frequency (a deleted entry there is no station): the station moves
    answer = await post('/api/tune/keep', { from: '101.3', to: '101.2' });
    assert.strictEqual(answer.status, 200, answer.text);
    var kept = JSON.parse(answer.text);
    assert.deepStrictEqual([kept.success, kept.removed, kept.station.frequency], [true, null, '101.2']);
    assert.deepStrictEqual(list(), ['100.9', '101.2', '101.4', '98.5']);
    var station = plugin.stationsDb.fm[1];
    assert.deepStrictEqual([station.customName, station.favorite, station.playCount, station.pi, station.deleted], ['Mystery', true, 4, 'C4B1', false]);
    // a name that was only the frequency follows it, and what the survey read there is noted
    assert.strictEqual(station.name, 'FM 101.2');
    assert.deepStrictEqual([station.quality, station.level, station.mono], [27.5, 3, true]);
    // the list is saved
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(CONFIG_DIR + '/stations.json', 'utf8')).fm.map(function(s) { return s.frequency; }), ['100.9', '101.2', '101.4', '98.5']);
    // the logo went with it
    assert.strictEqual(plugin.logos.describe(station).file, 'fm-10120.png');
    assert.ok(!fs.existsSync(plugin.logos.dir + '/fm-10130.png'));
    // and the queue item that is this station follows
    assert.deepStrictEqual(player.uris(), ['rtlsdr://fm/101.2', 'music/a.flac']);
    assert.strictEqual(player.queue[0].artist, '101.2 MHz');
    assert.deepStrictEqual(player.did, ['queue pushed', 'queue saved']);

    // onto a frequency another station holds, this one kept: the other leaves the list
    answer = await post('/api/tune/keep', { from: '101.2', to: '101.4', keep: 'this' });
    kept = JSON.parse(answer.text);
    assert.deepStrictEqual([answer.status, kept.removed, kept.station.customName], [200, '101.4', 'Mystery']);
    assert.deepStrictEqual(list(), ['100.9', '101.4', '98.5']);
    assert.strictEqual(plugin.stationsDb.fm[1].playCount, 4);
    assert.strictEqual(plugin.logos.describe(plugin.stationsDb.fm[1]).file, 'fm-10140.png');

    // the other kept: this one is deleted, to be restored if wanted, and the queue goes to the other
    answer = await post('/api/tune/keep', { from: '101.4', to: '100.9', keep: 'other' });
    kept = JSON.parse(answer.text);
    assert.deepStrictEqual([answer.status, kept.removed, kept.deleted, kept.station.customName], [200, '101.4', true, 'Classic']);
    assert.deepStrictEqual(list(), ['100.9', '101.4 deleted', '98.5']);
    assert.deepStrictEqual(player.uris(), ['rtlsdr://fm/100.9', 'music/a.flac']);

    // the same frequency again changes nothing; one that is no station's, or deleted, is refused
    answer = await post('/api/tune/keep', { from: '98.5', to: '98.5' });
    assert.deepStrictEqual([answer.status, JSON.parse(answer.text).removed], [200, null]);
    assert.strictEqual((await post('/api/tune/keep', { from: '99.9', to: '99.8' })).status, 404);
    assert.strictEqual((await post('/api/tune/keep', { from: '101.4', to: '99.8' })).status, 404);
    assert.strictEqual((await post('/api/tune/keep', { from: '98.5', to: 'up' })).status, 400);
    assert.deepStrictEqual(list(), ['100.9', '101.4 deleted', '98.5']);
  } finally {
    delete process.env.FAKE_SURVEY;
    player.away();
    plugin.logos.index.logos = {};
    plugin.stationsDb.fm = before;
    plugin.saveStations();
  }
  assert.deepStrictEqual(running(), []);
});

test('FM scan: a tool that cannot read the dongle is a failed scan, and the station list is left alone', async function() {
  plugin.stationsDb.fm = [{ frequency: '100.0', name: 'FM 100.0' }];
  toasts.length = 0;
  process.env.FAKE_GAIN_FAILS = '1';
  try {
    await assert.rejects(Promise.resolve(plugin.scanFm()), /cannot open device 0/);
  } finally {
    delete process.env.FAKE_GAIN_FAILS;
  }
  assert.strictEqual(plugin.deviceState, 'idle');
  assert.deepStrictEqual(plugin.stationsDb.fm, [{ frequency: '100.0', name: 'FM 100.0' }]);
  assert.ok(toasts.some(function(t) { return t.type === 'error'; }));
  plugin.stationsDb.fm = [];
});

test('a scan that is stopped is no failure and does not disturb what follows', async function() {
  toasts.length = 0;
  process.env.FAKE_GAIN_SECONDS = '30';
  var scan = Promise.resolve(plugin.scanFm()).catch(function(e) { return e; });
  await sleep(400);
  assert.strictEqual(plugin.deviceState, 'scanning_fm');
  assert.deepStrictEqual(JSON.parse((await get('/api/status')).text).scan, { type: 'fm', percent: 0 });
  delete process.env.FAKE_GAIN_SECONDS;
  await plugin.stopCurrentOperation();
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await scan;
  await sleep(300);
  assert.strictEqual(plugin.deviceState, 'playing_fm');
  assert.ok(!toasts.some(function(t) { return t.type === 'error'; }), JSON.stringify(toasts));
  await plugin.stop();
});

test('spectrum scan: stops our playback, returns the readings', async function() {
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  var response = await post('/api/antenna/spectrum-scan');
  assert.strictEqual(response.status, 200, response.text);
  var body = JSON.parse(response.text);
  assert.strictEqual(body.success, true);
  assert.ok(body.spectrum.length >= 1);
  await sleep(200);
  assert.deepStrictEqual(running(), []);
});

test('DAB validation: a channel is checked, the scanner is gone afterwards', async function() {
  var response = await post('/api/antenna/validate-dab', { channels: ['12b'] });
  assert.strictEqual(response.status, 200, response.text);
  assert.match(response.text, /"channel":"12B","sync":true,"services":2/);
  assert.match(response.text, /"status":"complete"/);
  await sleep(300);
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.tuner.busy(), null);
});

test('DAB validation: anything but a list of DAB channels is refused', async function() {
  var bad = [['12B; touch /tmp/pwned4'], ['$(touch /tmp/pwned4)'], [{}], 'x', [], null];
  for (var i = 0; i < bad.length; i++) {
    var response = await post('/api/antenna/validate-dab', { channels: bad[i] });
    assert.strictEqual(response.status, 400, JSON.stringify(bad[i]));
  }
  assert.ok(!fs.existsSync('/tmp/pwned4'));
});

test('SNR scan: a step of zero does not hang the player', async function() {
  fs.removeSync('/tmp/fake-args-fn-rtl_power');
  var response = await post('/api/antenna/snr-scan', { channels: ['12B'], gainStart: 40, gainStop: 42, gainStep: 0, integration: 1 });
  assert.strictEqual(response.status, 200, response.text);
  assert.match(response.text, /"gainRange":\{"start":40,"stop":42,"step":1\}/);
  assert.strictEqual(fs.readFileSync('/tmp/fake-args-fn-rtl_power', 'utf8').trim().split('\n').length, 3);
  await sleep(200);
  assert.strictEqual(plugin.tuner.busy(), null);
});

test('saving stations through the manager: a broken list is refused and nothing is lost', async function() {
  var good = await post('/api/stations', { fm: [], dab: [] });
  assert.strictEqual(good.status, 200, good.text);
  var bad = await post('/api/stations', { fm: 'x', dab: [] });
  assert.strictEqual(bad.status, 400);
  assert.ok(fs.existsSync(CONFIG_DIR + '/stations.json'));
});

test('the playing queue item carries the artwork of the moment, and the station\'s icon again after the stop', async function() {
  // Volumio shows the artwork of the queue item, not that of the state it is given
  var track = dabTrack(DAB_NAME);
  var icon = '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg';
  var item = { service: 'rtlsdr_radio', uri: track.uri, albumart: icon };
  var other = { service: 'mpd', uri: 'mnt/x.mp3', albumart: '/albumart?path=x' };
  coreCommand.stateMachine.playQueue = { arrayQueue: [other, item] };
  coreCommand.stateMachine.currentPosition = 1;

  states.length = 0;
  await plugin.clearAddPlayTrack(track);
  await sleep(300);
  assert.ok(states.length > 0);
  plugin.pushPlayingState(Object.assign({}, states[states.length - 1], { albumart: '/albumart?web=Artist/Album/extralarge' }));
  assert.strictEqual(item.albumart, '/albumart?web=Artist/Album/extralarge');
  assert.strictEqual(other.albumart, '/albumart?path=x', 'no other item is touched');

  await plugin.stop();
  assert.strictEqual(item.albumart, icon);
  // Stopped or paused, Volumio shows the item's name as the title: an item without one
  // (queued by an earlier version) has been given the station's
  assert.strictEqual(item.name, DAB_NAME.trim());
  var exploded = await plugin.explodeUri(track.uri);
  assert.strictEqual(exploded[0].name, exploded[0].title);
  assert.strictEqual((await plugin.explodeUri('rtlsdr://fm/94.9'))[0].name, 'FM 94.9');

  // An item that is not this plugin's is left alone, whatever is pushed
  coreCommand.stateMachine.currentPosition = 0;
  await plugin.clearAddPlayTrack(track);
  await sleep(300);
  assert.strictEqual(other.albumart, '/albumart?path=x');
  await plugin.stop();
  delete coreCommand.stateMachine.playQueue;
  delete coreCommand.stateMachine.currentPosition;
});

// What the music database says of a song, for the artwork tests; whatever it is not
// told of, it does not know
var lookedUp = [];
function musicDatabase(answers, delay) {
  var metadata = require('../plugin/lib/metadata');
  metadata.lastfmLookup = function(artist, title, callback) {
    lookedUp.push(artist + ' - ' + title);
    var answer = answers[(artist + '|' + title).toLowerCase()] || { found: false };
    setTimeout(function() { callback(null, answer); }, delay || 0);
  };
}

// The picture each pushed state carries: the cover's artist and album, or "station"
function pictures() {
  return states.map(function(state) {
    var cover = /[?&]web=([^&]*)/.exec(state.albumart);
    return cover ? decodeURIComponent(cover[1]).replace('/extralarge', '') : 'station';
  });
}

test('artwork: a song named again changes nothing, and a picture gives way only to another picture', async function() {
  plugin.config.set('artwork_threshold', 20);
  plugin.config.set('artwork_persistence', 'artist');
  plugin.albumLookupCache = {};
  plugin.lastValidArtwork = null;
  lookedUp.length = 0;
  musicDatabase({
    'blondie|maria': { found: true, artist: 'Blondie', title: 'Maria', album: 'Greatest Hits', albumArtwork: 'http://covers.example/blondie.jpg' },
    'abba|waterloo': { found: true, artist: 'ABBA', title: 'Waterloo', album: 'Gold', albumArtwork: 'http://covers.example/gold.jpg' },
    'the nobodies|no cover song': { found: true, artist: 'The Nobodies', title: 'No Cover Song' }
  }, 30);
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  // Past the station's own second push of its starting state, half a second in
  await sleep(800);

  // The first song: nothing is shown yet but the station's picture; then its cover
  states.length = 0;
  plugin.handleDabDls('Playing... Maria -- Blondie');
  await sleep(120);
  assert.deepStrictEqual(pictures(), ['station', 'Blondie/Greatest Hits']);

  // The station's texts of the next minute, as a station sends them: a slogan, the
  // song in other words, the song again. The cover stays; the station's picture never
  // shows in between; the song is looked up once.
  states.length = 0;
  plugin.handleDabDls('Magic Radio -- The Best Variety from the 80s to Now');
  await sleep(60);
  plugin.handleDabDls('Blondie with Maria -- on Magic Radio');
  await sleep(60);
  plugin.handleDabDls('Discover more at magic.co.uk');
  await sleep(60);
  plugin.handleDabDls('Playing... Maria -- Blondie');
  await sleep(60);
  assert.deepStrictEqual(pictures(), ['Blondie/Greatest Hits', 'Blondie/Greatest Hits', 'Blondie/Greatest Hits', 'Blondie/Greatest Hits']);
  assert.deepStrictEqual(states.map(function(s) { return s.artist; }), ['Magic Radio -- The Best Variety from the 80s to Now',
    'Blondie with Maria -- on Magic Radio', 'Discover more at magic.co.uk', 'Playing... Maria -- Blondie'], 'every text is shown');
  assert.deepStrictEqual(lookedUp, ['Blondie - Maria']);

  // A presenter's line read as artist and title: no one knows such a song, the cover stays
  states.length = 0;
  plugin.handleDabDls('Mel is here for your Saturday night with the Best Variety from the 80s to Now.');
  await sleep(120);
  assert.deepStrictEqual(pictures(), ['Blondie/Greatest Hits']);
  assert.strictEqual(lookedUp.length, 2);

  // The next song: the cover on the screen stays until the new one is there
  states.length = 0;
  plugin.handleDabDls('Playing... Waterloo -- ABBA');
  await sleep(120);
  assert.deepStrictEqual(pictures(), ['Blondie/Greatest Hits', 'ABBA/Gold']);

  // A song that is known and has no cover: the station's picture, not the cover of the
  // song before; and that cover does not come back with the next slogan
  states.length = 0;
  plugin.handleDabDls('Playing... No Cover Song -- The Nobodies');
  await sleep(120);
  plugin.handleDabDls('Discover more at magic.co.uk');
  await sleep(60);
  assert.deepStrictEqual(pictures(), ['ABBA/Gold', 'station', 'station']);

  // A cover whose time is up (the artwork timeout) and a new song: the old cover stays
  // until the new one is there, and does not give way to the station's picture first
  plugin.config.set('artwork_ttl', 2);
  try {
    plugin.handleDabDls('Playing... Maria -- Blondie');
    await sleep(60);
    plugin.artworkTimestamp = Date.now() - 3 * 60 * 1000;
    plugin.albumLookupCache = {};
    states.length = 0;
    plugin.handleDabDls('Playing... Waterloo -- ABBA');
    await sleep(120);
    assert.deepStrictEqual(pictures(), ['Blondie/Greatest Hits', 'ABBA/Gold']);

    // With nothing to take its place, a cover whose time is up does leave the screen
    plugin.artworkTimestamp = Date.now() - 3 * 60 * 1000;
    states.length = 0;
    plugin.handleDabDls('Discover more at magic.co.uk');
    await sleep(60);
    assert.deepStrictEqual(pictures(), ['station']);

    // And so does one that only a text nobody knows as a song follows
    plugin.handleDabDls('Playing... Maria -- Blondie');
    await sleep(120);
    plugin.artworkTimestamp = Date.now() - 3 * 60 * 1000;
    states.length = 0;
    plugin.handleDabDls('Mel is here for your Saturday night with the Best Variety from the 80s to Now.');
    await sleep(120);
    assert.deepStrictEqual(pictures(), ['Blondie/Greatest Hits', 'station']);
  } finally {
    plugin.config.set('artwork_ttl', 0);
  }

  await plugin.stop();
  plugin.config.set('artwork_threshold', 60);
  plugin.lastValidArtwork = null;
});

test('artwork on FM: the same song in other words keeps its cover, and a new song keeps the picture until its own is found', async function() {
  plugin.config.set('artwork_threshold', 20);
  plugin.config.set('artwork_persistence', 'artist');
  plugin.albumLookupCache = {};
  plugin.lastValidArtwork = null;
  musicDatabase({
    'blondie|maria': { found: true, artist: 'Blondie', title: 'Maria', album: 'Greatest Hits', albumArtwork: 'http://covers.example/blondie.jpg' },
    'abba|waterloo': { found: true, artist: 'ABBA', title: 'Waterloo', album: 'Gold', albumArtwork: 'http://covers.example/gold.jpg' }
  }, 30);
  var between = plugin.RDS_UPDATE_INTERVAL;
  plugin.RDS_UPDATE_INTERVAL = 0;
  try {
    await plugin.clearAddPlayTrack(fmTrack('94.9'));
    await sleep(800);
    states.length = 0;
    plugin.handleRdsUpdate({ radiotext: 'Blondie - Maria' }, '94.9', 'FM 94.9');
    await sleep(120);
    assert.deepStrictEqual(pictures(), ['station', 'Blondie/Greatest Hits']);

    states.length = 0;
    plugin.handleRdsUpdate({ radiotext: 'Now playing: Blondie - Maria' }, '94.9', 'FM 94.9');
    await sleep(60);
    plugin.handleRdsUpdate({ radiotext: 'More music on 94.9' }, '94.9', 'FM 94.9');
    await sleep(60);
    plugin.handleRdsUpdate({ radiotext: 'ABBA - Waterloo' }, '94.9', 'FM 94.9');
    await sleep(120);
    var shown = pictures();
    assert.ok(shown.indexOf('station') === -1, 'the station\'s picture never showed in between: ' + shown.join(', '));
    assert.strictEqual(shown[shown.length - 1], 'ABBA/Gold');
    assert.strictEqual(shown[shown.length - 2], 'Blondie/Greatest Hits', 'the cover before stays until the new one is there');
  } finally {
    plugin.RDS_UPDATE_INTERVAL = between;
    plugin.config.set('artwork_threshold', 60);
    plugin.lastValidArtwork = null;
    await plugin.stop();
  }
});

test('artwork: a lookup that fails is not taken for an answer, and is made again', async function() {
  var metadata = require('../plugin/lib/metadata');
  plugin.albumLookupCache = {};
  var asked = 0;
  metadata.lastfmLookup = function(artist, title, callback) {
    asked++;
    callback(asked === 1 ? new Error('network down') : null,
      asked === 1 ? null : { found: true, artist: artist, title: title, album: 'An Album', albumArtwork: 'http://covers.example/a.jpg' });
  };
  var first = await new Promise(function(resolve) { plugin.lookupAlbum('Some Band', 'Some Song', function(e, r) { resolve(r); }); });
  assert.strictEqual(first, null);
  var second = await new Promise(function(resolve) { plugin.lookupAlbum('Some Band', 'Some Song', function(e, r) { resolve(r); }); });
  assert.strictEqual(second.album, 'An Album');
  assert.strictEqual(asked, 2);
});

test('artwork cool-off: a picture stays its time before another takes its place; the text is never held back', async function() {
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  // Past the station's own second push of its starting state, half a second in
  await sleep(800);
  // The states of this test are pushed by hand: the station's own look at its text,
  // which would push states of its own in between, is stopped
  clearInterval(plugin.dlsMonitorInterval);
  var begun = states[states.length - 1];
  plugin.config.set('artwork_hold', 1);
  try {
    function push(text, art) {
      plugin.pushPlayingState(Object.assign({}, begun, { artist: text, albumart: '/albumart?web=' + art + '/extralarge' }));
    }
    function shown() {
      return states.map(function(s, i) { return s.artist + ':' + pictures()[i]; });
    }
    // The first picture after the station's own goes out at once: the hold counts from
    // when a picture was shown, and the station's picture has had its time
    states.length = 0;
    plugin.artShown.since = Date.now() - 5000;
    push('one', 'A/1');
    push('two', 'B/2');
    push('three', 'C/3');
    assert.deepStrictEqual(shown(), ['one:A/1', 'two:A/1', 'three:A/1'], 'the texts go out at once, with the picture that is on the screen');
    await sleep(1200);
    assert.deepStrictEqual(shown(), ['one:A/1', 'two:A/1', 'three:A/1', 'three:C/3'], 'the last picture follows when the time is up; the one between was never shown');

    // A change back to the picture on the screen within the time: nothing follows
    states.length = 0;
    plugin.artShown.since = Date.now() - 5000;
    push('four', 'D/4');
    push('five', 'E/5');
    push('six', 'D/4');
    await sleep(1200);
    assert.deepStrictEqual(shown(), ['four:D/4', 'five:D/4', 'six:D/4']);

    // A station that is stopped pushes nothing later
    push('seven', 'F/6');
    await plugin.stop();
    var count = states.length;
    await sleep(1200);
    assert.strictEqual(states.filter(function(s) { return s.artist === 'seven'; }).length, 1);
    assert.ok(!states.slice(count).some(function(s) { return /F\/6/.test(s.albumart); }));
  } finally {
    plugin.config.set('artwork_hold', 0);
  }
});

test('DAB: a picture the station sends is shown as it arrives, under an address a screen can load', async function() {
  process.env.FAKE_DAB_SLIDE = '0.3';
  plugin.DLS_POLL_INTERVAL = 150;
  states.length = 0;
  try {
    await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
    var shown = null;
    for (var i = 0; i < 60 && !shown; i++) {
      await sleep(100);
      shown = states.filter(function(s) { return /slides\/slide_0000\.jpg/.test(String(s.albumart)); })[0];
    }
    assert.ok(shown, 'no state carried the picture: ' + JSON.stringify(states.map(function(s) { return s.albumart; }).slice(-3)));
    assert.match(shown.albumart, /^\/albumart\?sourceicon=music_service\/rtlsdr_radio\/slides\/slide_0000\.jpg&v=[0-9a-z]+$/);
    assert.ok(!/file:/.test(shown.albumart), 'not a file on the player, which no screen could load');
    assert.strictEqual(fs.readFileSync(__dirname + '/../plugin/slides/slide_0000.jpg').slice(0, 2).toString('hex'), 'ffd8',
      'and the address leads to the picture');
  } finally {
    delete process.env.FAKE_DAB_SLIDE;
    plugin.DLS_POLL_INTERVAL = 2000;
    await plugin.stop();
  }
});

test('station logos through the manager: the state is told, a refresh is taken, and no network is no error', async function() {
  var station = { channel: '12B', exactName: DAB_NAME, name: 'BBC Radio1', ensemble: 'BBC National DAB',
    ensembleId: 'CE15', serviceId: 'C221', deleted: false };
  plugin.stationsDb.dab = [station];
  plugin.stationsDb.fm = [];
  // What earlier tests left waiting for a network is dropped
  plugin.logos.stop();
  assert.match(plugin.dabIcon(station), /^music_service\/rtlsdr_radio\/assets\/dab\.svg&v=[0-9a-z]+$/,
    'the DAB icon while no logo is kept, under an address that carries the installation\'s mark');

  var before = JSON.parse((await get('/api/logos/status')).text);
  assert.strictEqual(before.stations, 1);
  assert.strictEqual(before.none, 1);

  logs.length = 0;
  var refresh = await post('/api/logos/refresh');
  assert.strictEqual(refresh.status, 200, refresh.text);
  await sleep(100);
  var after = JSON.parse((await get('/api/logos/status')).text);
  assert.strictEqual(after.state, 'waiting');
  assert.strictEqual(after.queued, 1);
  assert.ok(logoChecks > 0);
  assert.deepStrictEqual(logs.filter(function(l) { return /^(ERROR|WARN)/.test(l); }), []);
  assert.ok(fs.lstatSync(__dirname + '/../plugin/logos').isSymbolicLink(), 'the pictures are reached through a link in the plugin folder');

  // FM stations count too, and are shown with the FM icon while no logo is kept
  var fm = { frequency: '100.0', name: 'FM 100.0', customName: 'Kiss' };
  plugin.stationsDb.fm = [fm];
  assert.strictEqual(JSON.parse((await get('/api/logos/status')).text).stations, 2);
  assert.match(plugin.fmIcon(fm), /^music_service\/rtlsdr_radio\/assets\/fm\.svg&v=[0-9a-z]+$/);
  var listed = await plugin.handleBrowseUri('rtlsdr://fm');
  var item = listed.navigation.lists[0].items.find(function(i) { return i.uri === 'rtlsdr://fm/100.0'; });
  assert.match(item.albumart, /^\/albumart\?sourceicon=music_service\/rtlsdr_radio\/assets\/fm\.svg&v=/);
  plugin.stationsDb.dab = [];
  plugin.stationsDb.fm = [];
});

test('a station\'s logo through the manager: uploaded, refused with the reason, shown, and given back', async function() {
  var fm = { frequency: '100.0', name: 'FM 100.0', customName: 'Kiss' };
  var dab = { channel: '12B', exactName: DAB_NAME, name: 'BBC Radio1', ensembleId: 'CE15', serviceId: 'C221', deleted: false };
  plugin.stationsDb.fm = [fm];
  plugin.stationsDb.dab = [dab];
  var shown = JSON.parse((await get('/api/logos/stations')).text);
  assert.deepStrictEqual(shown, { fm: { '100.0': { url: null, from: null, ref: null } },
    dab: { ['12B|' + DAB_NAME]: { url: null, from: null, ref: null } } });

  // A picture of the user's own
  var picture = pngOf(600, 600);
  var sent = await upload('/api/logos/upload', { type: 'fm', frequency: '100.0' }, { name: 'kiss.png', body: picture });
  assert.strictEqual(sent.status, 200, sent.text);
  var logo = JSON.parse(sent.text).logo;
  assert.deepStrictEqual([logo.from, logo.ref], ['user', 'kiss.png']);
  assert.match(logo.url, /^\/logos\/user-fm-10000\.png\?v=[0-9a-z]+$/);
  var page = await fetchRaw(logo.url);
  assert.strictEqual(page.status, 200);
  assert.match(page.headers['content-type'], /^image\/png/);
  assert.ok(page.body.equals(picture));
  // Volumio's lists and the play state take it from then on
  assert.match(plugin.fmIcon(fm), /^music_service\/rtlsdr_radio\/logos\/user-fm-10000\.png&v=[0-9a-z]+$/);
  assert.strictEqual(JSON.parse((await get('/api/logos/stations')).text).fm['100.0'].from, 'user');

  // A DAB station is named by its channel and its exact name, trailing spaces and all
  sent = await upload('/api/logos/upload', { type: 'dab', channel: '12B', exactName: DAB_NAME }, { name: 'r1.png', body: picture });
  assert.strictEqual(sent.status, 200, sent.text);
  assert.match(plugin.dabIcon(dab), /logos\/user-dab-ce15-c221\.png&v=/);

  // What cannot be a logo is refused, each with its reason
  var refused = [
    [{ name: 'tiny.png', body: pngOf(40, 40) }, 400, 'too-small'],
    [{ name: 'paper.pdf', body: Buffer.from('%PDF-1.7 not a picture at all') }, 400, 'not-a-picture'],
    [{ name: 'huge.png', body: pngOf(600, 600, 2 * 1024 * 1024 + 4096) }, 413, 'too-large'],
    [{ name: 'evil.svg', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') }, 400, 'unsafe']
  ];
  for (var i = 0; i < refused.length; i++) {
    var answer = await upload('/api/logos/upload', { type: 'fm', frequency: '100.0' }, refused[i][0]);
    assert.strictEqual(answer.status, refused[i][1], refused[i][0].name + ': ' + answer.text);
    assert.strictEqual(JSON.parse(answer.text).error, refused[i][2], refused[i][0].name);
  }
  assert.match(plugin.fmIcon(fm), /user-fm-10000\.png/, 'a refused picture leaves the one before in place');
  assert.strictEqual((await upload('/api/logos/upload', { type: 'fm', frequency: '99.9' }, { name: 'a.png', body: picture })).status, 404);
  assert.deepStrictEqual(fs.readdirSync('/tmp').filter(function(f) { return /^[0-9a-f]{32}$/.test(f); }), [], 'nothing of an upload is left behind');

  // An SVG is taken as it is, and is served so that it can draw and nothing else
  var drawing = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
  sent = await upload('/api/logos/upload', { type: 'fm', frequency: '100.0' }, { name: 'kiss.svg', body: drawing });
  assert.strictEqual(sent.status, 200, sent.text);
  page = await fetchRaw(JSON.parse(sent.text).logo.url);
  assert.match(page.headers['content-type'], /^image\/svg\+xml/);
  assert.match(page.headers['content-security-policy'], /sandbox/);
  assert.ok(page.body.equals(drawing));

  // The store's own files are not pictures, and nothing outside it is reached
  assert.strictEqual((await fetchRaw('/logos/index.json')).status, 404);
  assert.strictEqual((await fetchRaw('/logos/..%2Fconfig.json')).status, 404);

  // The library names what is kept on the player; one of those can be chosen
  var library = JSON.parse((await get('/api/logos/library?q=bbc')).text);
  assert.deepStrictEqual(library.kept.map(function(k) { return [k.name, k.file]; }), [['BBC Radio1', 'user-dab-ce15-c221.png']]);
  assert.strictEqual(library.rules.least, 128);
  var chosen = await post('/api/logos/choose', { station: { type: 'fm', frequency: '100.0' }, source: 'kept', file: 'user-dab-ce15-c221.png', name: 'BBC Radio1' });
  assert.strictEqual(chosen.status, 200, chosen.text);
  assert.deepStrictEqual([JSON.parse(chosen.text).logo.from, JSON.parse(chosen.text).logo.ref], ['user', 'BBC Radio1']);
  assert.strictEqual((await post('/api/logos/choose', { station: { type: 'fm', frequency: '100.0' }, source: 'list', url: 'http://elsewhere.example/a.png' })).status, 400);
  assert.strictEqual((await post('/api/logos/choose', { station: { type: 'fm', frequency: '100.0' }, source: 'kept', file: '../index.json' })).status, 400);

  // Back to automatic
  var cleared = await post('/api/logos/clear', { station: { type: 'fm', frequency: '100.0' } });
  assert.deepStrictEqual(JSON.parse(cleared.text).logo, { url: null, from: null, ref: null });
  assert.match(plugin.fmIcon(fm), /assets\/fm\.svg/);
  await post('/api/logos/clear', { station: { type: 'dab', channel: '12B', exactName: DAB_NAME } });
  plugin.stationsDb.fm = [];
  plugin.stationsDb.dab = [];
});

test('a stations backup carries the user\'s own logos, and a restore puts them back', async function() {
  // A station as the list keeps one, or the list is not saved
  var fm = plugin.transformStationToV2({ frequency: '100.0', name: 'FM 100.0' }, 'fm');
  fm.customName = 'Kiss';
  fm.favorite = true;
  plugin.stationsDb.fm = [fm];
  plugin.stationsDb.dab = [];
  assert.strictEqual(plugin.saveStations(), true);
  var live = plugin.stationsDbFile;

  // Without a logo of the user's own, a backup is the station list as it is
  await plugin.createStationsBackup('2026-01-01T00-00-00-000Z');
  var plain = fs.readJsonSync('/data/rtlsdr_radio_backups/stations/stations-2026-01-01T00-00-00-000Z.json');
  assert.strictEqual(plain.userLogos, undefined);
  assert.deepStrictEqual(plain, fs.readJsonSync(live));

  var picture = pngOf(600, 600);
  assert.strictEqual((await upload('/api/logos/upload', { type: 'fm', frequency: '100.0' }, { name: 'kiss.png', body: picture })).status, 200);
  await plugin.createStationsBackup('2026-01-02T00-00-00-000Z');
  var backup = fs.readJsonSync('/data/rtlsdr_radio_backups/stations/stations-2026-01-02T00-00-00-000Z.json');
  assert.deepStrictEqual(Object.keys(backup.userLogos), ['fm-10000']);
  assert.ok(Buffer.from(backup.userLogos['fm-10000'].data, 'base64').equals(picture));
  assert.strictEqual(backup.fm[0].customName, 'Kiss');
  assert.strictEqual(fs.readJsonSync(live).userLogos, undefined, 'the list in use never carries the pictures');

  // The logo is lost (another card, a store that was emptied); the restore brings it back
  await post('/api/logos/clear', { station: { type: 'fm', frequency: '100.0' } });
  assert.match(plugin.fmIcon(fm), /assets\/fm\.svg/);
  await plugin.restoreStationsBackup('2026-01-02T00-00-00-000Z');
  assert.match(plugin.fmIcon(fm), /logos\/user-fm-10000\.png&v=/);
  assert.strictEqual(fs.readJsonSync(live).userLogos, undefined);
  assert.strictEqual(fs.readJsonSync(live).fm[0].customName, 'Kiss');

  // A list that reaches the plugin with the pictures in it (taken from a backup at the
  // start, or by a version before this one) gives them up when it is loaded
  await post('/api/logos/clear', { station: { type: 'fm', frequency: '100.0' } });
  fs.writeJsonSync(live, backup);
  await plugin.loadStations();
  assert.strictEqual(plugin.stationsDb.userLogos, undefined);
  assert.strictEqual(fs.readJsonSync(live).userLogos, undefined);
  assert.match(plugin.fmIcon(plugin.stationsDb.fm[0]), /logos\/user-fm-10000\.png&v=/);

  await post('/api/logos/clear', { station: { type: 'fm', frequency: '100.0' } });
  plugin.stationsDb.fm = [];
  plugin.saveStations();
});

test('plugin update through the manager: the store is asked through the player, and only a signed-in player is answered', async function() {
  var view = JSON.parse((await get('/api/update')).text);
  assert.strictEqual(view.current, require('../plugin/package.json').version);
  assert.strictEqual(view.channel, 'stable');
  assert.deepStrictEqual(view.problems, { store: 'store-login' });
  assert.strictEqual(view.available, false);

  // Signed in, and the store names its versions the way the player shows them
  var store = 'https://plugins.volumio.workers.dev/pluginsv2/download/rtlsdr_radio/';
  coreCommand.getMyVolumioStatus = function() { return Promise.resolve({ loggedIn: true }); };
  coreCommand.getPluginDetails = function(data) {
    assert.deepStrictEqual(data, { name: 'rtlsdr_radio' });
    return Promise.resolve({ title: 'FM/DAB Radio', buttons: [
      { name: 'Install v1.3.9 (stable)', emit: 'installPlugin', payload: { url: store + '1.3.9/volumio/bookworm/arm' } },
      { name: 'Install v9.9.9 (beta)', emit: 'installPlugin', payload: { url: store + '9.9.9/volumio/bookworm/arm' } },
      { name: 'Close', class: 'btn btn-warning' }
    ] });
  };
  view = JSON.parse((await post('/api/update/check')).text);
  assert.deepStrictEqual(view.problems, {});
  assert.deepStrictEqual(view.newest, { stable: '1.3.9', beta: '9.9.9', preview: null });
  assert.strictEqual(view.offer.version, '1.3.9');
  assert.strictEqual(view.available, false, 'the stable channel offers nothing newer');

  assert.strictEqual((await post('/api/update/channel', { channel: 'nightly' })).status, 400);

  // A test channel is chosen, but the player is not in Volumio's plugin test mode
  fs.removeSync('/data/testplugins');
  view = JSON.parse((await post('/api/update/channel', { channel: 'beta' })).text);
  assert.strictEqual(view.chosen, 'beta');
  assert.strictEqual(view.testMode, false);
  assert.strictEqual(view.channel, 'stable', 'so the stable channel stays in force');
  assert.strictEqual(view.available, false);

  // The switch on the player's /dev page, as Volumio sets it: the choice applies
  fs.writeFileSync('/data/testplugins', ' ');
  view = JSON.parse((await get('/api/update')).text);
  assert.strictEqual(view.testMode, true);
  assert.strictEqual(view.channel, 'beta');
  assert.strictEqual(view.offer.version, '9.9.9');
  assert.strictEqual(view.offer.source, 'store');
  assert.strictEqual(view.available, true);
});

test('plugin update through the manager: the player\'s plugin manager installs it, then the backend is restarted', async function() {
  var asked = [];
  coreCommand.updatePlugin = function(data) { asked.push(data); return Promise.resolve(); };
  fs.writeJsonSync('/data/configuration/plugins.json', { music_service: { rtlsdr_radio: { enabled: { type: 'boolean', value: true } } } });
  function stationBackups() {
    try { return fs.readdirSync('/data/rtlsdr_radio_backups/stations').length; } catch (e) { return 0; }
  }
  var backups = stationBackups();
  updateDid.length = 0;

  var started = await post('/api/update/install');
  assert.strictEqual(started.status, 200, started.text);
  var view;
  for (var i = 0; i < 100; i++) {
    view = JSON.parse((await get('/api/update')).text);
    if (view.job && (view.job.state === 'restarting' || view.job.state === 'failed')) { break; }
    await sleep(50);
  }
  assert.strictEqual(view.job.state, 'restarting', JSON.stringify(view.job));
  assert.deepStrictEqual(asked, [{ url: 'https://plugins.volumio.workers.dev/pluginsv2/download/rtlsdr_radio/9.9.9/volumio/bookworm/arm',
    category: 'music_service', name: 'rtlsdr_radio' }]);
  assert.deepStrictEqual(updateDid, ['keep', 'restart']);
  assert.strictEqual(stationBackups(), backups + 1, 'the station list was backed up first');
  assert.strictEqual(view.previous.version, require('../plugin/package.json').version);

  // A second request while the backend is on its way down starts nothing new
  assert.strictEqual(view.last.phase, 'restarting');
  plugin.updater.job = null;
  plugin.config.set('update_channel', 'stable');
});

test('plugin update through the manager: a store that never answers is given up on', async function() {
  plugin.STORE_TIMEOUT = 100;
  coreCommand.getPluginDetails = function() { return new Promise(function() {}); };
  var view = JSON.parse((await post('/api/update/check')).text);
  assert.deepStrictEqual(view.problems, { store: 'store' });
  assert.deepStrictEqual(logs.filter(function(l) { return /^ERROR/.test(l) && /Update/.test(l); }), []);
});

test('station logos are looked for a while after the start, not in the middle of it', async function() {
  await plugin.onStop();
  logoChecks = 0;
  plugin.LOGOS_START_DELAY = 150;
  plugin.stationsDb.dab = [];
  // An update has taken the link to the pictures away with the plugin's folder
  fs.removeSync(__dirname + '/../plugin/logos');
  await plugin.onStart();
  assert.ok(fs.lstatSync(__dirname + '/../plugin/logos').isSymbolicLink(), 'the start puts the link back');
  plugin.stationsDb.dab = [{ channel: '12B', exactName: DAB_NAME, name: 'BBC Radio1', ensembleId: 'CE15', serviceId: 'C221' }];
  await sleep(60);
  assert.strictEqual(logoChecks, 0, 'not yet');
  await sleep(250);
  assert.ok(logoChecks > 0, 'now');
  assert.strictEqual(plugin.logos.status().state, 'waiting');
  plugin.stationsDb.dab = [];
});

test('FM scan with a tuner that mirrors: the copies are not listed, and the log says what they are', async function() {
  var before = JSON.parse(JSON.stringify(plugin.stationsDb.fm));
  process.env.FAKE_SURVEY = 'fm-survey-mirror.txt';
  logs.length = 0;
  try {
    await plugin.scanFm();
  } finally {
    delete process.env.FAKE_SURVEY;
  }
  var found = plugin.stationsDb.fm.filter(function(s) { return !s.deleted; }).map(function(s) { return String(s.frequency); });
  assert.ok(found.indexOf('98.1') === -1 && found.indexOf('100.3') === -1, found.join(' '));
  assert.ok(found.indexOf('91.3') !== -1 && found.indexOf('98.8') !== -1 && found.indexOf('100.6') !== -1, found.join(' '));
  assert.ok(logs.some(function(m) { return /the signal at 98\.10 MHz is the tuner's mirror of a stronger station, not a station \(pilot 10\.5 dB, -0\.7 dB with the tuner set elsewhere\)/.test(m); }), logs.join('\n'));
  assert.ok(logs.some(function(m) { return /the signal at 100\.30 MHz is the tuner's mirror/.test(m); }));
  assert.ok(logs.some(function(m) { return /Found station: 91\.3 MHz \(pilot 25\.3 dB/.test(m); }), 'the station under a mirror, with its own pilot');
  var kept = plugin.stationsDb.fm.filter(function(s) { return String(s.frequency) === '91.3'; })[0];
  assert.ok(kept && !kept.deleted);
  plugin.stationsDb.fm = before;
  plugin.saveStations();
  assert.deepStrictEqual(running(), []);
});

// A dongle report is made with the stand-ins of the tools; the ZIP file is a list of
// what would be in it, there being no zip in the test image
var REPORT_DIR = '/data/rtlsdr_radio_report';
async function reportEnds(limit) {
  for (var i = 0; i < (limit || 15000) / 100; i++) {
    var view = JSON.parse((await get('/api/dongle-report')).text);
    if (view.phase !== 'running') {
      return view;
    }
    await sleep(100);
  }
  throw new Error('the report did not end');
}

test('dongle report: made step by step, and handed out as one file', async function() {
  plugin.dongleReport.options.pack = function(folder, file) {
    fs.writeFileSync(file, fs.readdirSync(folder).sort().join('\n'));
    return Promise.resolve();
  };
  plugin.dongleReport.times.test = 300;
  plugin.dongleReport.times.record = 200;
  plugin.dongleReport.times.end = 600;
  plugin.stationsDb.dab = [{ name: 'A', exactName: 'A', channel: '12B' }, { name: 'B', exactName: 'B', channel: '12B' },
    { name: 'C', exactName: 'C', channel: '11D' }, { name: 'D', exactName: 'D', channel: '11A', deleted: true }];
  fs.removeSync('/tmp/fake-args-fn-rtl_sdr');
  assert.strictEqual(JSON.parse((await get('/api/dongle-report')).text).phase, 'idle');
  assert.strictEqual((await get('/api/dongle-report/download')).status, 404);
  assert.strictEqual((await get('/api/dongle-report/summary')).status, 404);

  // A station is playing: it is stopped through Volumio, as for an antenna tool
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await sleep(300);
  coreStops = 0;
  logs.length = 0;
  var started = await post('/api/dongle-report/start', {});
  assert.strictEqual(started.status, 200);
  var view = JSON.parse(started.text);
  assert.strictEqual(view.phase, 'running');
  assert.strictEqual(view.of, 6);
  assert.ok(coreStops >= 1, 'the stop went through Volumio');

  // A second one is refused while the first is being made
  var second = await post('/api/dongle-report/start', {});
  assert.strictEqual(second.status, 409);
  assert.strictEqual(JSON.parse(second.text).error.code, 'busy');

  view = await reportEnds();
  assert.strictEqual(view.phase, 'done', JSON.stringify(view));
  assert.strictEqual(view.step, 6);
  assert.strictEqual(view.error, null);
  assert.strictEqual(view.summary.device, 'Nooelec, SMArt XTR v5, SN: 00000001');
  assert.strictEqual(view.summary.tuner, 'Elonics E4000');
  assert.strictEqual(view.summary.gainSteps, 14);
  assert.strictEqual(view.summary.selftest, true);
  var expected = fmscan.stations(fmscan.parse(fs.readFileSync(__dirname + '/fixtures/fm-survey.txt', 'utf8')), { sensitivity: plugin.config.get('scan_sensitivity', 8) }).length;
  assert.strictEqual(view.summary.stations, expected);
  assert.deepStrictEqual(view.summary.problems, []);
  assert.match(view.zip.name, /^dongle-report-\d{8}-\d{6}\.zip$/);
  assert.strictEqual(view.zip.path, undefined, 'where the file lies on the player is not told');

  // The tools ran in order, each with what it needs; the band is the region's
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_test', 'utf8'), /^-s 2400000\s*$/);
  var recorded = fs.readFileSync('/tmp/fake-args-fn-rtl_sdr', 'utf8').trim().split('\n');
  assert.strictEqual(recorded.length, view.summary.recordings);
  assert.match(recorded[0], /^-f \d+ -s 2400000 -g 42\.0 \/data\/rtlsdr_radio_report\/files\/fm-\d+-42\.0\.iq$/);
  // The DAB channels of the list, the fullest first, and none of a deleted station
  assert.deepStrictEqual(recorded.filter(function(line) { return /-s 2048000 /.test(line); }).map(function(line) { return line.split(' ')[1]; }),
    ['225648000', '225648000', '222064000', '222064000']);
  assert.ok(logs.some(function(l) { return /Dongle report: step 3 of 6: surveying the FM band/.test(l); }));
  assert.ok(logs.some(function(l) { return /Dongle report: done: dongle-report-/.test(l); }));

  // What is kept: the summary, the data, what the tools said; the recordings are in the file only
  var kept = fs.readdirSync(REPORT_DIR + '/files').sort();
  assert.deepStrictEqual(kept, ['fm-gain.txt', 'fm-survey.err', 'fm-survey.txt', 'report.json', 'report.txt', 'rtl_test.txt', 'selftest.txt']);
  var packed = fs.readFileSync(REPORT_DIR + '/' + view.zip.name, 'utf8').split('\n');
  assert.strictEqual(packed.filter(function(name) { return /\.iq$/.test(name); }).length, view.summary.recordings);
  var report = fs.readJsonSync(REPORT_DIR + '/files/report.json');
  assert.strictEqual(report.form, 3);
  // The gain for the strongest stations was measured as for playing: on the receiver's slice
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8'), / -s \d+$/m);
  assert.deepStrictEqual(report.fm.mirrors, []);
  assert.strictEqual(report.player.plugin, require('../plugin/package.json').version);
  assert.strictEqual(report.fm.band, 'europe, 87.50 to 108 MHz, raster 100 kHz');
  assert.strictEqual(report.settings['FM gain'], 'automatic');
  assert.strictEqual(report.recordings.length, view.summary.recordings);
  assert.ok(report.recordings.every(function(recording) { return recording.bytes === 4096; }));

  // Over the manager: the summary as text, the file as a download
  var summary = await get('/api/dongle-report/summary');
  assert.strictEqual(summary.status, 200);
  assert.match(summary.text, /Tuner: +Elonics E4000\n/);
  var download = await fetchRaw('/api/dongle-report/download');
  assert.strictEqual(download.status, 200);
  assert.match(String(download.headers['content-disposition']), /attachment; filename="dongle-report-\d{8}-\d{6}\.zip"/);

  // The dongle is free again and nothing is left running
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.tuner.busy(), null);
  assert.strictEqual(plugin.deviceState, 'idle');

  // A plugin started anew finds the report on the player and offers it as it was
  var DongleReport = require('../plugin/lib/donglereport.js');
  var again = new DongleReport({ dir: REPORT_DIR }).view();
  assert.strictEqual(again.phase, 'done');
  assert.deepStrictEqual(again.summary, view.summary);
  assert.deepStrictEqual(again.zip, view.zip);
  assert.strictEqual(again.startedAt, report.made);
  // And nothing where none was left
  assert.strictEqual(new DongleReport({ dir: '/tmp/no-report-here' }).view().phase, 'idle');
});

test('dongle report: without recordings, with no dongle, cancelled, and pushed aside by a station', async function() {
  // Without recordings: one step fewer, and the recorder is not run
  fs.removeSync('/tmp/fake-args-fn-rtl_sdr');
  var view = JSON.parse((await post('/api/dongle-report/start', { recordings: false })).text);
  assert.strictEqual(view.of, 5);
  view = await reportEnds();
  assert.strictEqual(view.phase, 'done', JSON.stringify(view));
  assert.strictEqual(view.summary.recordings, 0);
  assert.ok(!fs.existsSync('/tmp/fake-args-fn-rtl_sdr'));
  assert.match(fs.readFileSync(REPORT_DIR + '/files/report.txt', 'utf8'), /Recordings\n  none \(not asked for\)\n/);

  // No dongle: said so, and the report of before is gone with its file
  process.env.FAKE_TEST_NONE = '1';
  await post('/api/dongle-report/start', {});
  view = await reportEnds();
  delete process.env.FAKE_TEST_NONE;
  assert.strictEqual(view.phase, 'failed');
  assert.strictEqual(view.error.code, 'no-dongle');
  assert.match(view.error.message, /No supported devices found/);
  assert.strictEqual(view.zip, null);
  assert.strictEqual((await get('/api/dongle-report/download')).status, 404);
  assert.deepStrictEqual(running(), []);

  // Cancelled in the middle of the survey: the tool is stopped and the dongle let go
  process.env.FAKE_GAIN_SECONDS = '5';
  await post('/api/dongle-report/start', {});
  await sleep(900);
  assert.deepStrictEqual(running(), ['fn-rtl-gain']);
  view = JSON.parse((await post('/api/dongle-report/cancel')).text);
  assert.strictEqual(view.phase, 'cancelled');
  assert.strictEqual(view.error.code, 'cancelled');
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.tuner.busy(), null);

  // A station started while a report is being made takes the dongle; the report ends there
  await post('/api/dongle-report/start', {});
  await sleep(900);
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  delete process.env.FAKE_GAIN_SECONDS;
  await sleep(500);
  view = await reportEnds();
  assert.strictEqual(view.phase, 'failed');
  assert.strictEqual(view.error.code, 'interrupted');
  assert.strictEqual(plugin.deviceState, 'playing_fm');
  assert.deepStrictEqual(running(), ['aplay', 'fn-redsea', 'fn-rtl_fm', 'sox']);
  await plugin.stop();

  // A scan or an antenna tool that has the dongle is not pushed aside
  var busy = plugin.tuner.busy;
  plugin.tuner.busy = function() { return 'scanning_fm'; };
  try {
    var refused = await post('/api/dongle-report/start', {});
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(JSON.parse(refused.text).error.code, 'in-use');
  } finally {
    plugin.tuner.busy = busy;
  }
  assert.deepStrictEqual(running(), []);
});

test('the plugin stops: nothing is left running and the port is free', async function() {
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await sleep(200);
  await plugin.onStop();
  assert.deepStrictEqual(running(), []);
  assert.ok(fs.existsSync('/data/rtlsdr_radio_backups/last-good/stations.json'));
  assert.strictEqual(plugin.logos.status().state, 'idle', 'and no logo is waited for any longer');
});
