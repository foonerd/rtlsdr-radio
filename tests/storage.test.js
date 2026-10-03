'use strict';

// Run inside a throwaway container: the module works on fixed paths under /data.
//   scripts/test-plugin.sh

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs-extra');
var storage = require('../plugin/lib/storage');

var LEGACY = '/data/plugins/music_service/rtlsdr_radio';

function reset() {
  fs.removeSync(storage.DATA_DIR);
  fs.removeSync(storage.BACKUP_DIR);
  fs.removeSync(LEGACY);
}

test('a missing file reads as missing', function() {
  reset();
  assert.deepStrictEqual(storage.read('stations'), { missing: true });
});

test('what is written is read back, and no temporary file is left', function() {
  reset();
  var db = { version: 2, fm: [{ frequency: '94.9' }], dab: [] };
  storage.write('stations', db);
  assert.deepStrictEqual(storage.read('stations').data, db);
  assert.deepStrictEqual(fs.readdirSync(storage.DATA_DIR), ['stations.json']);
});

test('the first save keeps a last good copy with the backups', function() {
  reset();
  storage.write('blocklist', { phrases: ['a'] });
  assert.deepStrictEqual(fs.readJsonSync(storage.BACKUP_DIR + '/last-good/blocklist.json'), { phrases: ['a'] });
});

test('an unreadable file is moved aside, not read again and not overwritten', function() {
  reset();
  fs.ensureDirSync(storage.DATA_DIR);
  fs.writeFileSync(storage.file('stations'), '{"version": 2, "fm": [');
  var result = storage.read('stations');
  assert.strictEqual(result.unreadable, true);
  assert.ok(fs.existsSync(result.movedTo));
  assert.strictEqual(fs.readFileSync(result.movedTo, 'utf8'), '{"version": 2, "fm": [');
  assert.deepStrictEqual(storage.read('stations'), { missing: true });
});

test('a file left in the plugin folder is brought over once', function() {
  reset();
  fs.ensureDirSync(LEGACY);
  fs.writeJsonSync(LEGACY + '/stations.json', { version: 2, fm: [], dab: [{ channel: '12B' }] });
  assert.strictEqual(storage.migrateLegacy('stations'), true);
  assert.strictEqual(storage.read('stations').data.dab[0].channel, '12B');
  assert.strictEqual(storage.migrateLegacy('stations'), false);
});

test('the fallback is the newest readable copy that is accepted', function() {
  reset();
  var dir = storage.BACKUP_DIR + '/stations';
  fs.ensureDirSync(dir);
  fs.writeJsonSync(dir + '/stations-2026-01-01T00-00-00-000Z.json', { n: 1 });
  fs.writeJsonSync(dir + '/stations-2026-02-01T00-00-00-000Z.json', { n: 2 });
  fs.writeFileSync(dir + '/stations-2026-03-01T00-00-00-000Z.json', 'not json');
  fs.writeJsonSync(dir + '/notes.json', { n: 99 });
  fs.utimesSync(dir + '/stations-2026-01-01T00-00-00-000Z.json', 1000, 1000);
  fs.utimesSync(dir + '/stations-2026-02-01T00-00-00-000Z.json', 2000, 2000);
  fs.utimesSync(dir + '/stations-2026-03-01T00-00-00-000Z.json', 3000, 3000);

  assert.strictEqual(storage.fallback('stations').data.n, 2);
  var picked = storage.fallback('stations', function(data) { return data.n === 1 ? 'first' : null; });
  assert.strictEqual(picked.data.n, 1);
  assert.strictEqual(picked.accepted, 'first');
  assert.strictEqual(storage.fallback('stations', function() { return null; }), null);
});

test('the last good copy counts as a fallback when it is the newest', function() {
  reset();
  var dir = storage.BACKUP_DIR + '/stations';
  fs.ensureDirSync(dir);
  fs.writeJsonSync(dir + '/stations-2026-01-01T00-00-00-000Z.json', { n: 1 });
  fs.utimesSync(dir + '/stations-2026-01-01T00-00-00-000Z.json', 1000, 1000);
  storage.write('stations', { n: 7 });
  fs.removeSync(storage.file('stations'));
  assert.strictEqual(storage.fallback('stations').data.n, 7);
});

test('with nothing to fall back on the answer is null', function() {
  reset();
  assert.strictEqual(storage.fallback('stations'), null);
});
