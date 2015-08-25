/* Response handler (cache and validation) middleware */

var localCacheImpl = require('./cache/localCache');
var redisCacheImpl = require('./cache/redisCache');
var Q = require('q');
var common = require('./common.js');
var cl = common.cl;
var pgConnect = common.pgConnect;
var configuration;
var postgres;

// used to determine where to store the cached object (there are two stores, list
// and resource. The purge logic is different)
function responseIsList(response) {
  'use strict';
  return response.$$meta && response.$$meta.hasOwnProperty('count');
}

function validateRequest(mapping, req, res, resources) {
  'use strict';
  var promises;
  var deferred = Q.defer();
  if (!mapping.public && mapping.secure && mapping.secure.length > 0) {

    Q.all([pgConnect(postgres, configuration), mapping.getme(req)]).done(
      function (results) {

        promises = [];
        mapping.secure.forEach(function (f) {
          promises.push(f(req, res, results[0], results[1], resources));
        });

        Q.all(promises).then(function () {
          deferred.resolve();
        }).catch(function () {
          deferred.reject();
        }).finally(function () {
          results[0].done();
        });
      }
    );

  } else {
    deferred.resolve();
  }

  return deferred.promise;
}

function createStorableObject(res, buffer, resources) {
  'use strict';
  var object = {
    headers: {},
    data: buffer
  };

  if (resources) {
    object.resources = resources;
  }

  if (res.getHeader('Content-Type')) {
    object.headers['Content-Type'] = res.getHeader('Content-Type');
  }

  // used to know if the stored object is compressed or not
  if (res.getHeader('Content-Encoding')) {
    object.headers['Content-Encoding'] = res.getHeader('Content-Encoding');
  }

  // for binary transfers
  if (res.getHeader('Content-Disposition')) {
    object.headers['Content-Disposition'] = res.getHeader('Content-Disposition');
  }

  return object;

}

function getResources(response) {
  'use strict';
  var i;
  var results = [];

  if (response.$$meta) {
    if (response.$$meta.permalink) {
      return [response.$$meta.permalink];
    } else if (response.results) {
      for (i = 0; i < response.results.length; i++) {
        // only check access on expanded resources, anyone can see a href
        if (response.results[i].$$expanded) {
          results.push(response.results[i].href);
        }
      }
    }
  }

  return results;
}

function store(url, cache, req, res, mapping) {
  'use strict';

  var send = res.send; // hijack!
  var write = res.write;
  var end = res.end;
  var isList;
  var cacheSection = 'custom';
  var buffer;
  var ended = false;
  var resources;
  var validated = false;

  // proxy

  if (cache) {
    res.write = function (chunk, encoding) {

      if (!ended && chunk) {
        if (!buffer) {
          buffer = new Buffer(chunk);
        } else {
          buffer = Buffer.concat([buffer, chunk]);
        }
      }

      return write.call(this, chunk, encoding);

    };

    res.end = function (chunk, encoding) {
      ended = true;

      if (res.statusCode === 200) {
        if (chunk) {
          cache[cacheSection].set(url, createStorableObject(res, new Buffer(chunk), resources));
        } else if (buffer) {
          cache[cacheSection].set(url, createStorableObject(res, buffer, resources));
        }
      }

      return end.call(this, chunk, encoding);

    };
  }

  res.send = function (output) {

    var self;

    // express first send call tranforms a json into a string and calls send again
    // we only process the first send to store the object
    if (typeof output === 'object' && cache) {
      // first call
      isList = responseIsList(output);
      resources = getResources(output);

      cacheSection = isList ? 'list' : 'resources';
    }

    if (!validated) {
      validated = true;
      self = this; //eslint-disable-line

      validateRequest(mapping, req, res, resources).then(function () {
        send.call(self, output);
      }).catch(function () {
        res.status(403).send({
          type: 'access.denied',
          status: 403,
          body: 'Forbidden'
        });
      });
    } else {
      send.call(this, output);
    }

  };

}

exports = module.exports = function (mapping, config, pg) {
  'use strict';

  var header;

  var cache = false;
  var cacheImpl;
  var cacheStore;
  configuration = config;
  postgres = pg;

  if (mapping.cache) {
    cache = true;
    cl('sri4node cache active for resource ' + mapping.type);
    switch (mapping.cache.type) {
      case 'redis':
        cacheImpl = function () { return redisCacheImpl(mapping.cache.ttl, mapping.cache.redis); };
        break;
      default:
        cacheImpl = function () { return localCacheImpl(mapping.cache.ttl); };
        break;
    }
  }

  if (cache) {
    cacheStore = {
      resources: cacheImpl(),
      list: cacheImpl(),
      custom: cacheImpl()
    };
  }

  return function (req, res, next) {

    function handleResponse(value) {
      if (req.method === 'GET') {

        if (value) {
          validateRequest(mapping, req, res, value.resources).then(function () {
            for (header in value.headers) {

              if (value.headers.hasOwnProperty(header)) {

                res.set(header, value.headers[header]);
              }
            }

            res.send(value.data);
          }).catch(function () {
            res.status(403).send({
              type: 'access.denied',
              status: 403,
              body: 'Forbidden'
            });
          });

        } else {
          // register handler to process response when responding
          store(req.originalUrl, cacheStore, req, res, mapping);
          next();
        }
      } else if (req.method === 'PUT' || req.method === 'DELETE') {
        validateRequest(mapping, req, res).then(function () {
          if (cache) {
            cacheStore.resources.del(req.originalUrl);
            // TODO do this more efficiently? (only delete the entries where this resource is present)
            cacheStore.list.flushAll();
          }
          next();
        }).catch(function () {
          res.status(403).send({
            type: 'access.denied',
            status: 403,
            body: 'Forbidden'
          });
        });
      } else {
        next();
      }
    }

    if (cache) {
      Q.allSettled([cacheStore.resources.get(req.originalUrl), cacheStore.list.get(req.originalUrl),
        cacheStore.custom.get(req.originalUrl)]).done(function (results) {
          if (results[0].state === 'rejected' || results[2].state === 'rejected' || results[2].state === 'rejected') {
            cl('cache promise rejected !');
            cl(results);
          }
          handleResponse(results[0].value || results[1].value || results[2].value);
        });
    } else {
      handleResponse();
    }

  };

};