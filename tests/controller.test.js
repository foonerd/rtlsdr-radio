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
    stop: function() { coreStops++; return plugin.stop(); }
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
var plugin = new Controller({ coreCommand: coreCommand, logger: logger, configManager: {} });
plugin.tuner.settle = 100;
plugin.tuner.grace = 400;

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
  var names = ['fn-rtl_fm', 'fn-redsea', 'fn-dab', 'fn-dab-scanner', 'fn-rtl_power', 'sox', 'aplay'];
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

test('DAB straight after FM: the FM chain is gone before the DAB decoder starts', async function() {
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  await sleep(500);
  assert.deepStrictEqual(running(), ['aplay', 'fn-dab', 'sox']);
  assert.strictEqual(plugin.deviceState, 'playing_dab');
});

test('DAB: the service name reaches the decoder exactly, trailing spaces included', async function() {
  var args = fs.readFileSync('/tmp/fake-args-fn-dab', 'utf8').split('\n');
  assert.deepStrictEqual(args.slice(0, 6), ['-C', '12B', '-P', DAB_NAME, '-G', '80']);
  assert.deepStrictEqual(args.slice(6, 10), ['-D', '30', '-i', '/tmp/dab/']);
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

test('a DAB service that is not found ends the playback with a message', async function() {
  toasts.length = 0;
  process.env.FAKE_DAB_FAILS = '1';
  await plugin.clearAddPlayTrack(dabTrack(DAB_NAME));
  await sleep(700);
  delete process.env.FAKE_DAB_FAILS;
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.deviceState, 'idle');
  assert.ok(toasts.some(function(t) { return /fn-dab ended with code 22/.test(t.message); }), JSON.stringify(toasts));
});

test('FM scan: runs as its own job and leaves the device idle', async function() {
  await Promise.resolve(plugin.scanFm()).catch(function() {});
  assert.deepStrictEqual(running(), []);
  assert.strictEqual(plugin.deviceState, 'idle');
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl_power', 'utf8'), /-f 87\.50M:108M:100k -i 10 -1 \/tmp\/fm_scan_/);
});

test('a scan that is stopped is no failure and does not disturb what follows', async function() {
  toasts.length = 0;
  process.env.FAKE_POWER_SECONDS = '30';
  var scan = Promise.resolve(plugin.scanFm()).catch(function(e) { return e; });
  await sleep(400);
  assert.strictEqual(plugin.deviceState, 'scanning_fm');
  delete process.env.FAKE_POWER_SECONDS;
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

test('station logos through the manager: the state is told, a refresh is taken, and no network is no error', async function() {
  var station = { channel: '12B', exactName: DAB_NAME, name: 'BBC Radio1', ensemble: 'BBC National DAB',
    ensembleId: 'CE15', serviceId: 'C221', deleted: false };
  plugin.stationsDb.dab = [station];
  assert.strictEqual(plugin.dabIcon(station), 'music_service/rtlsdr_radio/assets/dab.svg', 'the DAB icon while no logo is kept');

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
  plugin.stationsDb.dab = [];
});

test('the plugin stops: nothing is left running and the port is free', async function() {
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await sleep(200);
  await plugin.onStop();
  assert.deepStrictEqual(running(), []);
  assert.ok(fs.existsSync('/data/rtlsdr_radio_backups/last-good/stations.json'));
  assert.strictEqual(plugin.logos.status().state, 'idle', 'and no logo is waited for any longer');
});
