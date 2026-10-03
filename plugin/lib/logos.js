'use strict';

// The station logos kept on the player.
//
// Logos are fetched once from the broadcasters (lib/radiodns.js) and kept in the plugin's
// own folder, because Volumio's artwork endpoint serves pictures from there to every
// screen (the plugin's FM and DAB icons travel the same way). An update of the plugin
// empties the folder; the logos are then simply fetched again.

var fs = require('fs-extra');
var path = require('path');
var radiodns = require('./radiodns');

var DIR = path.join(__dirname, '..', 'logos');
var ICON_PREFIX = 'music_service/rtlsdr_radio/logos/';

// A station whose broadcaster lists no logo is asked about again after a week
var RETRY_AFTER = 7 * 24 * 3600 * 1000;

function Logos(options) {
  options = options || {};
  this.dir = options.dir || DIR;
  this.lookup = options.lookup || new radiodns.Lookup();
  this.logger = options.logger || { info: function() {}, error: function() {} };
  this.pending = {};
  this.index = { logos: {}, misses: {}, gcc: {} };
  try {
    var stored = fs.readJsonSync(path.join(this.dir, 'index.json'));
    this.index.logos = stored.logos || {};
    this.index.misses = stored.misses || {};
    this.index.gcc = stored.gcc || {};
  } catch (e) {
    // nothing kept yet
  }
}

function clean(value) {
  var text = String(value || '').toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{4,8}$/.test(text) ? text : null;
}

// The name a DAB station's logo is kept under, or null when the station lacks the
// identifiers (a station typed in by hand, for one).
Logos.prototype.dabKey = function(station) {
  var eid = station && clean(station.ensembleId);
  var sid = station && clean(station.serviceId);
  return eid && sid && sid !== '0000' ? 'dab-' + eid + '-' + sid : null;
};

// The picture to hand to Volumio's artwork endpoint (sourceicon) for a station,
// or null when none is kept.
Logos.prototype.icon = function(key) {
  var entry = key && this.index.logos[key];
  if (!entry || !fs.existsSync(path.join(this.dir, entry.file))) {
    return null;
  }
  return ICON_PREFIX + entry.file;
};

Logos.prototype._save = function() {
  try {
    fs.ensureDirSync(this.dir);
    var file = path.join(this.dir, 'index.json');
    fs.writeJsonSync(file + '.tmp', this.index);
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    this.logger.error('[RTL-SDR Radio] Logos: cannot write the index: ' + e);
  }
};

// Whether a lookup is due for this station: no logo kept, and not asked in vain lately
Logos.prototype.wanted = function(key) {
  if (!key || this.icon(key)) {
    return false;
  }
  var missed = this.index.misses[key];
  return !(missed && Date.now() - missed < RETRY_AFTER);
};

// Fetch the logo of a DAB station. Resolves with true when a logo is kept afterwards.
// Never rejects: without a network, or without a logo, the station keeps its icon.
Logos.prototype.fetchDab = function(station, regionSetting) {
  var self = this;
  var key = self.dabKey(station);
  if (!key) {
    return Promise.resolve(false);
  }
  if (self.icon(key)) {
    return Promise.resolve(true);
  }
  if (!self.wanted(key)) {
    return Promise.resolve(false);
  }
  if (self.pending[key]) {
    return self.pending[key];
  }

  var eid = clean(station.ensembleId);
  var candidates = radiodns.dabCandidates(eid, clean(station.serviceId), regionSetting, self.index.gcc[eid]);

  self.pending[key] = self.lookup.find(candidates).then(function(found) {
    if (found) {
      self.index.gcc[eid] = found.gcc;
    }
    if (!found || !found.logo) {
      self.index.misses[key] = Date.now();
      self._save();
      return false;
    }
    return self.lookup.fetchImage(found.logo.url).then(function(image) {
      fs.ensureDirSync(self.dir);
      var file = key + '.' + image.extension;
      fs.writeFileSync(path.join(self.dir, file + '.tmp'), image.body);
      fs.renameSync(path.join(self.dir, file + '.tmp'), path.join(self.dir, file));
      self.index.logos[key] = { file: file, url: found.logo.url, fetched: new Date().toISOString() };
      delete self.index.misses[key];
      self._save();
      return true;
    });
  }).catch(function(e) {
    // No network, or the broadcaster's server is down: not recorded, so it is tried again
    self.logger.info('[RTL-SDR Radio] Logos: ' + key + ': ' + (e && e.message || e));
    return false;
  }).then(function(result) {
    delete self.pending[key];
    return result;
  });
  return self.pending[key];
};

// Fetch the logos of all DAB stations that lack one, one after another.
// Resolves with the number fetched.
Logos.prototype.fetchAllDab = function(stations, regionSetting) {
  var self = this;
  var list = (stations || []).filter(function(station) {
    return !station.deleted && self.wanted(self.dabKey(station));
  });
  var fetched = 0;
  return list.reduce(function(before, station) {
    return before.then(function() {
      return self.fetchDab(station, regionSetting).then(function(got) {
        if (got) {
          fetched++;
        }
      });
    });
  }, Promise.resolve()).then(function() {
    return fetched;
  });
};

module.exports = Logos;
module.exports.ICON_PREFIX = ICON_PREFIX;
