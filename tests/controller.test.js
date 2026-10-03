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
  var names = ['fn-rtl_fm', 'fn-redsea', 'fn-dab', 'fn-dab-scanner', 'fn-rtl_power', 'fn-rtl-gain', 'sox', 'aplay'];
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
  assert.match(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8'), /^-f 94900000 -s 1200000$/m);
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
  assert.strictEqual(fs.readFileSync('/tmp/fake-args-fn-rtl-gain', 'utf8').trim(), '-b 87.50M:108M:100k');
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

  // An item that is not this plugin's is left alone, whatever is pushed
  coreCommand.stateMachine.currentPosition = 0;
  await plugin.clearAddPlayTrack(track);
  await sleep(300);
  assert.strictEqual(other.albumart, '/albumart?path=x');
  await plugin.stop();
  delete coreCommand.stateMachine.playQueue;
  delete coreCommand.stateMachine.currentPosition;
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

test('the plugin stops: nothing is left running and the port is free', async function() {
  await plugin.clearAddPlayTrack(fmTrack('94.9'));
  await sleep(200);
  await plugin.onStop();
  assert.deepStrictEqual(running(), []);
  assert.ok(fs.existsSync('/data/rtlsdr_radio_backups/last-good/stations.json'));
  assert.strictEqual(plugin.logos.status().state, 'idle', 'and no logo is waited for any longer');
});
