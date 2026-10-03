'use strict';

// Station logos from the broadcasters themselves, found through RadioDNS.
//
// A broadcast service is named by identifiers it transmits. RadioDNS turns them into a
// DNS name; that name leads to the broadcaster, who publishes a list of its services
// (SI.xml) with their logos. Nothing is kept or licensed by this plugin: the pictures
// come from whoever runs the station.
//
//   DAB: <scids>.<sid>.<eid>.<gcc>.dab.radiodns.org
//   FM:  <frequency>.<pi>.<gcc>.fm.radiodns.org
//
// gcc is the service's country digit followed by the extended country code of its
// country. A receiver learns the extended code from the broadcast; the decoder here does
// not hand it on, so the few codes of the listener's part of the world are tried in turn.

var dns = require('dns');
var http = require('http');
var https = require('https');

// The extended country codes by part of the world, as the RDS and DAB standards assign
// them. Asia and the Pacific share one block: Australia is F0, New Zealand F1, Japan F2.
var EXTENDED_CODES = {
  europe: ['e1', 'e0', 'e2', 'e3', 'e4'],
  americas: ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
  asia_pacific: ['f0', 'f1', 'f2', 'f3', 'f4'],
  africa: ['d0', 'd1', 'd2', 'd3']
};

// The plugin's FM region setting, as a hint of where the listener is
var REGION_OF_SETTING = {
  europe: 'europe', italy: 'europe', oirt: 'europe',
  americas: 'americas',
  japan: 'asia_pacific', east_asia: 'asia_pacific', australia: 'asia_pacific'
};

var TIMEOUT = 10000;
var SI_MAX_BYTES = 4 * 1024 * 1024;
var IMAGE_MAX_BYTES = 2 * 1024 * 1024;

// The gcc values to try for a service, likeliest first.
// countryDigit: the first hex digit of a DAB service id or of an FM PI code.
function gccCandidates(countryDigit, regionSetting) {
  var digit = String(countryDigit).toLowerCase();
  if (!/^[1-9a-f]$/.test(digit)) {
    return [];
  }
  var first = REGION_OF_SETTING[regionSetting] || 'europe';
  var regions = [first].concat(Object.keys(EXTENDED_CODES).filter(function(r) { return r !== first; }));
  var list = [];
  regions.forEach(function(region) {
    EXTENDED_CODES[region].forEach(function(code) {
      list.push(digit + code);
    });
  });
  return list;
}

function hex(value, digits) {
  var text = String(value).toLowerCase().replace(/^0x/, '');
  return new RegExp('^[0-9a-f]{' + digits + '}$').test(text) ? text : null;
}

// The bearer of a DAB service as SI.xml writes it, or null when an identifier is not
// what such identifiers look like.
function dabBearer(gcc, ensembleId, serviceId, component) {
  var eid = hex(ensembleId, 4);
  var sid = hex(serviceId, 4) || hex(serviceId, 8);
  if (!/^[0-9a-f]{3}$/.test(gcc) || !eid || !sid) {
    return null;
  }
  return 'dab:' + gcc + '.' + eid + '.' + sid + '.' + (component || 0);
}

function dabName(gcc, ensembleId, serviceId, component) {
  var bearer = dabBearer(gcc, ensembleId, serviceId, component);
  if (!bearer) {
    return null;
  }
  return bearer.slice(4).split('.').reverse().join('.') + '.dab.radiodns.org';
}

// frequency in MHz; the name carries it in units of 10 kHz, five digits
function fmBearer(gcc, pi, frequency) {
  var code = hex(pi, 4);
  var units = Math.round(parseFloat(frequency) * 100);
  if (!/^[0-9a-f]{3}$/.test(gcc) || !code || !(units >= 6500 && units <= 10800)) {
    return null;
  }
  return 'fm:' + gcc + '.' + code + '.' + ('00000' + units).slice(-5);
}

function fmName(gcc, pi, frequency) {
  var bearer = fmBearer(gcc, pi, frequency);
  if (!bearer) {
    return null;
  }
  return bearer.slice(3).split('.').reverse().join('.') + '.fm.radiodns.org';
}

// The logos SI.xml lists for the service with the given bearer: [{ url, width, height, mime }]
function logosOf(siXml, bearer) {
  var wanted = bearer.toLowerCase();
  var services = siXml.match(/<service\b[\s\S]*?<\/service>/g) || [];
  for (var i = 0; i < services.length; i++) {
    var bearers = (services[i].match(/<bearer\b[^>]*>/g) || []).map(function(tag) {
      var id = /\bid="([^"]*)"/.exec(tag);
      return id ? id[1].toLowerCase() : '';
    });
    if (bearers.indexOf(wanted) === -1) {
      continue;
    }
    return (services[i].match(/<multimedia\b[^>]*>/g) || []).map(function(tag) {
      function attribute(name) {
        var found = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
        return found ? found[1].replace(/&amp;/g, '&') : null;
      }
      return {
        url: attribute('url'),
        width: parseInt(attribute('width'), 10) || 0,
        height: parseInt(attribute('height'), 10) || 0,
        mime: attribute('mimeValue') || ''
      };
    }).filter(function(logo) {
      return logo.url && /^https?:\/\//i.test(logo.url);
    });
  }
  return [];
}

// The logo to show: the largest square one, failing that the largest that is not a banner.
function bestLogo(logos) {
  var square = logos.filter(function(l) { return l.width > 0 && l.width === l.height; })
    .sort(function(a, b) { return b.width - a.width; });
  if (square.length > 0) {
    return square[0];
  }
  var others = logos.filter(function(l) { return l.height > 0 && l.width / l.height <= 2; })
    .sort(function(a, b) { return b.width * b.height - a.width * a.height; });
  return others[0] || null;
}

// --- the network, replaceable for tests -------------------------------------------------

function resolveProvider(name) {
  return dns.promises.resolveCname(name).then(function(names) {
    var provider = names[0];
    return dns.promises.resolveSrv('_radioepg._tcp.' + provider).then(function(records) {
      if (!records.length) {
        return null;
      }
      records.sort(function(a, b) { return a.priority - b.priority; });
      return { host: records[0].name, port: records[0].port };
    });
  }).catch(function() {
    return null;
  });
}

function get(url, maxBytes, redirects) {
  return new Promise(function(resolve, reject) {
    var client = /^https:/i.test(url) ? https : http;
    var request = client.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'rtlsdr_radio (Volumio plugin)' } }, function(response) {
      var status = response.statusCode;
      if (status >= 300 && status < 400 && response.headers.location && (redirects || 0) < 4) {
        response.resume();
        resolve(get(new URL(response.headers.location, url).toString(), maxBytes, (redirects || 0) + 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error('HTTP ' + status + ' for ' + url));
        return;
      }
      var chunks = [];
      var size = 0;
      response.on('data', function(chunk) {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error('answer larger than ' + maxBytes + ' bytes'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', function() {
        resolve({ body: Buffer.concat(chunks), type: String(response.headers['content-type'] || '') });
      });
    });
    request.on('timeout', function() { request.destroy(new Error('timeout for ' + url)); });
    request.on('error', reject);
  });
}

// A lookup with its own short memory of the service lists it has fetched, so that the
// stations of one broadcaster cost one download.
function Lookup(network) {
  this.network = network || { resolveProvider: resolveProvider, get: get };
  this.lists = {};
}

Lookup.prototype._list = function(provider) {
  var self = this;
  var port = provider.port === 80 || provider.port === 443 ? '' : ':' + provider.port;
  var url = (provider.port === 443 ? 'https' : 'http') + '://' + provider.host + port + '/radiodns/spi/3.1/SI.xml';
  if (!self.lists[url]) {
    self.lists[url] = self.network.get(url, SI_MAX_BYTES).then(function(answer) {
      return answer.body.toString('utf8');
    });
    self.lists[url].catch(function() { delete self.lists[url]; });
  }
  return self.lists[url];
};

// Find the logo of a service. candidates: [{ gcc, name, bearer }], tried in turn.
// Resolves with { gcc, logo: { url, width, height, mime } } or null when there is none.
Lookup.prototype.find = function(candidates) {
  var self = this;
  var at = 0;

  function next() {
    if (at >= candidates.length) {
      return Promise.resolve(null);
    }
    var candidate = candidates[at++];
    return self.network.resolveProvider(candidate.name).then(function(provider) {
      if (!provider) {
        return next();
      }
      // The broadcaster is found; whether it lists a logo or not, the search ends here.
      // A list that cannot be fetched is a failure of the network, not an answer, and
      // is passed on as such.
      return self._list(provider).then(function(xml) {
        return { gcc: candidate.gcc, logo: bestLogo(logosOf(xml, candidate.bearer)) };
      });
    });
  }
  return next();
};

// Fetch the picture itself. Resolves with { body, extension }.
Lookup.prototype.fetchImage = function(url) {
  return this.network.get(url, IMAGE_MAX_BYTES).then(function(answer) {
    var body = answer.body;
    var extension = null;
    if (body.length > 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) {
      extension = 'png';
    } else if (body.length > 3 && body[0] === 0xff && body[1] === 0xd8) {
      extension = 'jpg';
    }
    if (!extension) {
      throw new Error('not a PNG or JPEG picture: ' + url);
    }
    return { body: body, extension: extension };
  });
};

function dabCandidates(ensembleId, serviceId, regionSetting, knownGcc) {
  var sid = hex(serviceId, 4) || hex(serviceId, 8);
  if (!sid) {
    return [];
  }
  // A 16-bit service id starts with the country digit; a 32-bit one carries the
  // extended code in its first two digits and the country digit third
  var gccs = sid.length === 8 ? [sid[2] + sid.slice(0, 2)] : gccCandidates(sid[0], regionSetting);
  if (knownGcc && gccs.indexOf(knownGcc) !== -1) {
    gccs = [knownGcc].concat(gccs.filter(function(g) { return g !== knownGcc; }));
  }
  return gccs.map(function(gcc) {
    return { gcc: gcc, name: dabName(gcc, ensembleId, sid), bearer: dabBearer(gcc, ensembleId, sid) };
  }).filter(function(candidate) { return candidate.name; });
}

function fmCandidates(pi, frequency, regionSetting, knownGcc) {
  var code = hex(pi, 4);
  if (!code) {
    return [];
  }
  var gccs = gccCandidates(code[0], regionSetting);
  if (knownGcc && gccs.indexOf(knownGcc) !== -1) {
    gccs = [knownGcc].concat(gccs.filter(function(g) { return g !== knownGcc; }));
  }
  return gccs.map(function(gcc) {
    return { gcc: gcc, name: fmName(gcc, code, frequency), bearer: fmBearer(gcc, code, frequency) };
  }).filter(function(candidate) { return candidate.name; });
}

module.exports = {
  Lookup: Lookup,
  gccCandidates: gccCandidates,
  dabName: dabName,
  dabBearer: dabBearer,
  fmName: fmName,
  fmBearer: fmBearer,
  dabCandidates: dabCandidates,
  fmCandidates: fmCandidates,
  logosOf: logosOf,
  bestLogo: bestLogo
};
