'use strict';

// The updater against a canned store, a canned GitHub and a plugin that only records
// what it is asked to do. No network, no plugin manager, no restart.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs-extra');
var crypto = require('crypto');
var Updater = require('../plugin/lib/update');

var ZIP = Buffer.from('the zip of the release, as far as these tests care');
var SHA = crypto.createHash('sha256').update(ZIP).digest('hex');

function release(version, more) {
  return Object.assign({
    tag_name: 'v' + version,
    html_url: 'https://github.example/releases/v' + version,
    body: 'Notes of ' + version,
    published_at: '2026-10-03T10:00:00Z',
    prerelease: true,
    draft: false,
    assets: [
      { name: 'other.txt', size: 3, browser_download_url: 'https://github.example/other.txt' },
      { name: 'rtlsdr_radio-' + version + '.zip', size: ZIP.length, digest: 'sha256:' + SHA,
        browser_download_url: 'https://github.example/download/rtlsdr_radio-' + version + '.zip' }
    ]
  }, more);
}

var STORE = [
  { version: '1.3.9', channel: 'stable', url: 'https://store.example/download/rtlsdr_radio/1.3.9' },
  { version: '1.3.8', channel: 'stable', url: 'https://store.example/download/rtlsdr_radio/1.3.8' },
  { version: '1.3.11', channel: 'beta', url: 'https://store.example/download/rtlsdr_radio/1.3.11' }
];

function make(options) {
  options = options || {};
  var base = options.base || '/tmp/update-test-' + Math.random().toString(36).slice(2);
  fs.ensureDirSync(base + '/plugin');
  fs.writeFileSync(base + '/plugin/index.js', '// installed');
  var rig = {
    base: base,
    did: [],
    lines: [],
    channel: options.channel || 'preview',
    store: options.store === undefined ? STORE : options.store,
    releases: options.releases || [release('1.3.12')],
    body: ZIP,
    breaks: 0
  };
  rig.open = function(version) {
    rig.updater = new Updater({
      dir: base + '/kept',
      version: version || options.version || '1.3.10',
      pluginPath: base + '/plugin',
      stagingDir: base + '/staging',
      channel: function() { return rig.channel; },
      waits: [5, 5],
      logger: { info: function(m) { rig.lines.push(m); }, error: function(m) { rig.lines.push('ERROR ' + m); } },
      network: {
        json: function(url) {
          rig.did.push('github ' + url);
          return rig.releases instanceof Error ? Promise.reject(rig.releases) : Promise.resolve(rig.releases);
        },
        download: function(url, file, limit, onProgress) {
          rig.did.push('download ' + url);
          if (rig.breaks > 0) {
            rig.breaks--;
            return Promise.reject(new Error('socket hang up'));
          }
          fs.writeFileSync(file, rig.body);
          onProgress(rig.body.length);
          return Promise.resolve({ bytes: rig.body.length, sha256: crypto.createHash('sha256').update(rig.body).digest('hex') });
        }
      },
      zip: function(folder, file) {
        rig.did.push('keep ' + folder);
        if (rig.zipFails) {
          return Promise.reject(new Error('no space left on device'));
        }
        fs.writeFileSync(file, 'the installed plugin, zipped');
        return Promise.resolve();
      },
      plugin: {
        storeVersions: function() {
          rig.did.push('store');
          return rig.store instanceof Error ? Promise.reject(rig.store) : Promise.resolve(rig.store);
        },
        testMode: function() { return true; },
        backup: function(label) { rig.did.push('backup ' + label); },
        apply: function(url) {
          rig.did.push('apply ' + url);
          return rig.applyFails ? Promise.reject(new Error('the plugin manager said no')) : Promise.resolve();
        },
        restart: function() { rig.did.push('restart'); }
      }
    });
    return rig.updater;
  };
  rig.open();
  return rig;
}

async function settled(rig) {
  for (var i = 0; i < 400; i++) {
    var job = rig.updater.job;
    if (job && (job.state === 'restarting' || job.state === 'failed')) {
      return job;
    }
    await new Promise(function(resolve) { setTimeout(resolve, 5); });
  }
  assert.fail('the update never came to an end: ' + JSON.stringify(rig.updater.job));
}

// --- versions, releases, channels -------------------------------------------------------

test('versions are compared by their numbers', function() {
  assert.strictEqual(Updater.compareVersions('1.3.10', '1.3.9'), 1);
  assert.strictEqual(Updater.compareVersions('1.3.9', '1.3.10'), -1);
  assert.strictEqual(Updater.compareVersions('v1.4.0', '1.4.0'), 0);
  assert.strictEqual(Updater.compareVersions('1.4.0-rc.1', '1.4.0'), -1, 'a version with a suffix ranks below the plain one');
  assert.strictEqual(Updater.compareVersions('nonsense', '1.0.0'), 0);
});

test('a release is read for the plugin\'s zip, its size and its digest', function() {
  var parsed = Updater.parseRelease(release('1.3.12'));
  assert.strictEqual(parsed.version, '1.3.12');
  assert.strictEqual(parsed.url, 'https://github.example/download/rtlsdr_radio-1.3.12.zip');
  assert.strictEqual(parsed.bytes, ZIP.length);
  assert.strictEqual(parsed.sha256, SHA);
  assert.strictEqual(parsed.notes, 'Notes of 1.3.12');
  assert.strictEqual(Updater.parseRelease(release('1.3.12', { draft: true })), null, 'a draft is no release');
  assert.strictEqual(Updater.parseRelease(release('1.3.12', { assets: [] })), null, 'nor is one without the zip');
  assert.strictEqual(Updater.parseRelease({ assets: [{ name: 'rtlsdr_radio-1.0.0.zip', size: 1 }] }).sha256, null);
});

test('the newest release is the one with the highest version, whatever order they come in', function() {
  var newest = Updater.newestRelease([release('1.3.11'), release('1.3.13'), release('1.4.0', { draft: true }), release('1.3.12')]);
  assert.strictEqual(newest.version, '1.3.13');
  assert.strictEqual(Updater.newestRelease([]), null);
  assert.throws(function() { Updater.newestRelease({ message: 'rate limited' }); }, /not a list/);
});

test('each channel offers what it should', function() {
  var github = Updater.parseRelease(release('1.3.12'));
  assert.strictEqual(Updater.offerFor('stable', STORE, github).version, '1.3.9');
  assert.strictEqual(Updater.offerFor('beta', STORE, github).version, '1.3.11');
  assert.strictEqual(Updater.offerFor('preview', STORE, github).version, '1.3.12');
  assert.strictEqual(Updater.offerFor('preview', STORE, github).source, 'github');

  // The same version in the store and on GitHub: the store's
  var same = Updater.offerFor('preview', STORE, Updater.parseRelease(release('1.3.11')));
  assert.strictEqual(same.source, 'store');
  assert.strictEqual(Updater.offerFor('stable', [], null), null);
  assert.deepStrictEqual(Updater.newestPerChannel(STORE, github), { stable: '1.3.9', beta: '1.3.11', preview: '1.3.12' });
});

// --- looking ----------------------------------------------------------------------------

test('a look asks the store and, on the preview channel only, GitHub; and is not repeated within the day', async function() {
  var rig = make();
  var view = await rig.updater.check(false);
  assert.strictEqual(view.current, '1.3.10');
  assert.strictEqual(view.offer.version, '1.3.12');
  assert.strictEqual(view.available, true);
  assert.deepStrictEqual(view.newest, { stable: '1.3.9', beta: '1.3.11', preview: '1.3.12' });
  assert.strictEqual(rig.did.length, 2);

  await rig.updater.check(false);
  assert.strictEqual(rig.did.length, 2, 'not asked again');
  await rig.updater.check(true);
  assert.strictEqual(rig.did.length, 4, 'asked again when the user says so');

  // Another channel is another question
  rig.channel = 'stable';
  rig.did.length = 0;
  view = await rig.updater.check(false);
  assert.deepStrictEqual(rig.did, ['store'], 'GitHub is not asked on the store\'s channels');
  assert.strictEqual(view.offer.version, '1.3.9');
  assert.strictEqual(view.available, false, 'older than what is installed');

  // Kept across a restart
  rig.did.length = 0;
  rig.open();
  assert.strictEqual((await rig.updater.check(false)).offer.version, '1.3.9');
  assert.strictEqual(rig.did.length, 0);
});

test('a source that does not answer is noted, and the other one stands', async function() {
  var rig = make({ store: Object.assign(new Error('not signed in'), { code: 'store-login' }) });
  var view = await rig.updater.check(true);
  assert.deepStrictEqual(view.problems, { store: 'store-login' });
  assert.strictEqual(view.offer.version, '1.3.12');

  var other = make({ releases: new Error('HTTP 403') });
  view = await other.updater.check(true);
  assert.deepStrictEqual(view.problems, { github: 'network' });
  assert.strictEqual(view.offer.version, '1.3.11', 'the store\'s newest');
  assert.ok(!other.lines.some(function(l) { return /^ERROR/.test(l); }));
});

// --- installing -------------------------------------------------------------------------

test('a preview is downloaded, checked, and installed by the plugin manager; then the backend restarts', async function() {
  var rig = make();
  await rig.updater.check(true);
  rig.did.length = 0;
  var view = await rig.updater.install();
  assert.strictEqual(view.job.kind, 'install');
  var job = await settled(rig);
  assert.strictEqual(job.state, 'restarting');
  assert.deepStrictEqual(rig.did, [
    'download https://github.example/download/rtlsdr_radio-1.3.12.zip',
    'backup before-1.3.12',
    'keep ' + rig.base + '/plugin',
    'apply http://127.0.0.1:3000/plugin-serve/rtlsdr_radio-1.3.12.zip',
    'restart'
  ]);
  assert.deepStrictEqual(fs.readFileSync(rig.base + '/staging/rtlsdr_radio-1.3.12.zip'), ZIP);
  assert.ok(fs.existsSync(rig.base + '/kept/previous-1.3.10.zip'));

  // The new version starts and finds that the update took
  rig.open('1.3.12');
  var after = rig.updater.view();
  assert.strictEqual(after.last.ok, true);
  assert.strictEqual(after.last.from, '1.3.10');
  assert.deepStrictEqual(after.previous.version, '1.3.10');
  assert.ok(rig.lines.some(function(l) { return /Update from 1.3.10 to 1.3.12 took/.test(l); }));
});

test('an update after which the old version is still running is said not to have taken', async function() {
  var rig = make();
  await rig.updater.check(true);
  await rig.updater.install();
  await settled(rig);
  rig.open('1.3.10');
  assert.strictEqual(rig.updater.view().last.ok, false);
  assert.ok(rig.lines.some(function(l) { return /did not take; running 1.3.10/.test(l); }));
});

test('a download that does not match the release\'s checksum is not installed', async function() {
  var rig = make();
  await rig.updater.check(true);
  rig.body = Buffer.concat([ZIP.slice(0, ZIP.length - 1), Buffer.from('X')]);
  rig.did.length = 0;
  await rig.updater.install();
  var job = await settled(rig);
  assert.strictEqual(job.state, 'failed');
  assert.strictEqual(job.error.code, 'checksum');
  assert.deepStrictEqual(rig.did.filter(function(d) { return /^(apply|restart|keep|backup)/.test(d); }), []);
  assert.deepStrictEqual(fs.readdirSync(rig.base + '/staging'), [], 'nothing is left where the plugin manager would find it');
});

test('a download of another size than the release states is not installed', async function() {
  var rig = make();
  await rig.updater.check(true);
  rig.body = ZIP.slice(0, 10);
  await rig.updater.install();
  var job = await settled(rig);
  assert.strictEqual(job.error.code, 'size');
  assert.ok(!rig.did.some(function(d) { return /^apply/.test(d); }));
});

test('a download that breaks is made again', async function() {
  var rig = make();
  await rig.updater.check(true);
  rig.breaks = 2;
  rig.did.length = 0;
  await rig.updater.install();
  assert.strictEqual((await settled(rig)).state, 'restarting');
  assert.strictEqual(rig.did.filter(function(d) { return /^download/.test(d); }).length, 3);

  // ...but not for ever
  var other = make();
  await other.updater.check(true);
  other.breaks = 5;
  await other.updater.install();
  var job = await settled(other);
  assert.strictEqual(job.error.code, 'network');
});

test('a release without a checksum is refused before anything is fetched', async function() {
  var bare = release('1.3.12');
  delete bare.assets[1].digest;
  var rig = make({ releases: [bare] });
  await rig.updater.check(true);
  rig.did.length = 0;
  await assert.rejects(rig.updater.install(), function(e) { return e.code === 'no-digest'; });
  assert.deepStrictEqual(rig.did, []);
});

test('a version of the store is installed from the store\'s address, by the plugin manager', async function() {
  var rig = make({ channel: 'beta' });
  await rig.updater.check(true);
  rig.did.length = 0;
  await rig.updater.install();
  assert.strictEqual((await settled(rig)).state, 'restarting');
  assert.deepStrictEqual(rig.did, [
    'backup before-1.3.11',
    'keep ' + rig.base + '/plugin',
    'apply https://store.example/download/rtlsdr_radio/1.3.11',
    'restart'
  ]);
});

test('nothing is installed when there is nothing newer, nothing known, or an update under way', async function() {
  var rig = make({ channel: 'stable' });
  await assert.rejects(rig.updater.install(), function(e) { return e.code === 'no-offer'; });
  await rig.updater.check(true);
  await assert.rejects(rig.updater.install(), function(e) { return e.code === 'up-to-date'; });

  rig.channel = 'preview';
  await rig.updater.check(true);
  var first = rig.updater.install();
  await assert.rejects(rig.updater.install(), function(e) { return e.code === 'busy'; });
  await first;
  await settled(rig);
});

test('without the installed version kept there is no update: the way back comes first', async function() {
  var rig = make();
  rig.zipFails = true;
  await rig.updater.check(true);
  await rig.updater.install();
  var job = await settled(rig);
  assert.strictEqual(job.error.code, 'keep');
  assert.ok(!rig.did.some(function(d) { return /^(apply|restart)/.test(d); }));
  assert.strictEqual(rig.updater.view().previous, null);
});

test('an update the plugin manager refuses is said to have failed, and the backend is not restarted', async function() {
  var rig = make();
  rig.applyFails = true;
  await rig.updater.check(true);
  await rig.updater.install();
  var job = await settled(rig);
  assert.strictEqual(job.error.code, 'apply');
  assert.ok(!rig.did.some(function(d) { return d === 'restart'; }));
  assert.strictEqual(rig.updater.view().last.phase, 'failed');

  // Another go is possible
  rig.applyFails = false;
  await rig.updater.install();
  assert.strictEqual((await settled(rig)).state, 'restarting');
});

// --- the way back -----------------------------------------------------------------------

test('the version before the update goes back the way the update came', async function() {
  var rig = make();
  await assert.rejects(rig.updater.rollback(), function(e) { return e.code === 'no-previous'; });

  await rig.updater.check(true);
  await rig.updater.install();
  await settled(rig);
  rig.open('1.3.12');
  rig.did.length = 0;

  var view = await rig.updater.rollback();
  assert.strictEqual(view.job.kind, 'rollback');
  assert.strictEqual((await settled(rig)).state, 'restarting');
  assert.deepStrictEqual(rig.did, [
    'backup before-1.3.10',
    'keep ' + rig.base + '/plugin',
    'apply http://127.0.0.1:3000/plugin-serve/rtlsdr_radio-1.3.10.zip',
    'restart'
  ]);
  assert.strictEqual(fs.readFileSync(rig.base + '/staging/rtlsdr_radio-1.3.10.zip', 'utf8'), 'the installed plugin, zipped');

  // Back on the old version: the one just left is the one kept now
  rig.open('1.3.10');
  assert.strictEqual(rig.updater.view().last.ok, true);
  assert.strictEqual(rig.updater.view().previous.version, '1.3.12');
  assert.ok(!fs.existsSync(rig.base + '/kept/previous-1.3.10.zip'), 'one version is kept, not a pile');
});
