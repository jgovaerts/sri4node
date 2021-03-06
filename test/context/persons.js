var Q = require('q');
var common = require('../../js/common.js');
var cl = common.cl;

exports = module.exports = function (roa, logverbose, extra) {
  'use strict';

  function debug(x) {
    if (logverbose) {
      cl(x);
    }
  }

  var isHrefAPermalink = function (href) {
    return href.match(/^\/[a-z\/]*\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
  };

  var $m = roa.mapUtils;
  var $s = roa.schemaUtils;
  var $q = roa.queryUtils;
  var $u = roa.utils;

  var checkMe = function (database, elements, me) {
    if (!me) {
      throw new Error('Missing `me` object');
    }

    return true;
  };

  var failOnBadUser = function (database, elements, me) {

    var deferred = Q.defer();

    if (me.email === 'daniella@email.be') {
      deferred.reject();
    } else {
      deferred.resolve();
    }

    return deferred.promise;
  };

  var forbidUser = function (database, elements, me) {

    var deferred = Q.defer();

    if (me.email === 'ingrid@email.be') {
      deferred.reject({
        statusCode: 403
      });
    } else {
      deferred.resolve();
    }

    return deferred.promise;
  };

  var checkElements = function (database, elements) {
    var element;
    if (!Array.isArray(elements)) {
      throw new Error('`elements` is not an array');
    }
    element = elements[0];
    if (!element.hasOwnProperty('path') || !element.hasOwnProperty('body') || !isHrefAPermalink(element.path)) {
      throw new Error('`elements` object in the array has wrong format');
    }

    return true;
  };

  var restrictReadPersons = function (req, resp, db, me) {
    // A secure function must take into account that a GET operation
    // can be either a GET for a regular resource, or a GET for a
    // list resource.
    var url, key, myCommunityKey, query;

    debug('** restrictReadPersons ');
    var deferred = Q.defer();
    if (req.method === 'GET') {
      debug('** req.path = ' + req.path);
      url = req.path;
      if (url === '/persons') {
        // Should allways restrict to /me community.
        debug('** req.query :');
        debug(req.query);
        if (req.query.communities) {
          debug('** me :');
          debug(me);
          if (req.query.communities === me.community.href) {
            debug('** restrictReadPersons resolves.');
            deferred.resolve();
          } else {
            debug('** restrictReadPersons rejecting - can only request persons from your own community.');
            deferred.reject();
          }
        } else {
          cl('** restrictReadPersons rejecting - must specify ?communities=... for GET on list resources');
          deferred.reject();
        }
      } else if (url === 'batch') {
        // special case, testing as batch always allow
        deferred.resolve();
      } else {
        key = url.split('/')[2];
        myCommunityKey = me.community.href.split('/')[2];
        debug('community key = ' + myCommunityKey);

        query = $u.prepareSQL('check-person-is-in-my-community');
        query.sql('select count(*) from persons where key = ')
          .param(key).sql(' and community = ').param(myCommunityKey);
        $u.executeSQL(db, query).then(function (result) {
          if (parseInt(result.rows[0].count, 10) === 1) {
            debug('** restrictReadPersons resolves.');
            deferred.resolve();
          } else {
            debug('results.rows[0].count = ' + result.rows[0].count);
            console.log('** security method restrictedReadPersons denies access.', key, myCommunityKey);
            deferred.reject();
          }
        }).fail(function (error) {
          debug('Unable to execute query for restrictedReadPersons :');
          debug(error);
          debug(error.stack);
        });
      } /* end handling regular resource request */
    } else {
      deferred.resolve();
    }

    return deferred.promise;
  };

  function disallowOnePerson(forbiddenKey) {
    return function (req) {
      var deferred = Q.defer();
      var key;

      if (req.method === 'GET') {
        key = req.path === 'batch' ? req.originalUrl.split('/').pop() : req.params.key;
        if (key === forbiddenKey) {
          cl('security method disallowedOnePerson for ' + forbiddenKey + ' denies access');
          deferred.reject();
        } else {
          deferred.resolve();
        }
      } else {
        deferred.resolve();
      }

      return deferred.promise;
    };
  }

  function simpleOutput(req, res, db) {

    var query;

    query = $u.prepareSQL('get-simple-person');
    query.sql('select firstname, lastname from persons where key = ')
      .param(req.params.key);
    $u.executeSQL(db, query).then(function (result) {
      db.done();
      if (result.rows.length === 1) {
        res.send({firstname: result.rows[0].firstname, lastname: result.rows[0].lastname});
      } else {
        res.status(409).end();
      }
    });

  }

  function wrongHandler(req, res, db) {

    var query;

    query = $u.prepareSQL('get-simple-person');
    query.sql('select firstname, lastname from person where key = ')
      .param(req.params.key);
    $u.executeSQL(db, query).then(function (result) {
      db.done();
      if (result.rows.length === 1) {
        res.send({firstname: result.rows[0].firstname, lastname: result.rows[0].lastname});
      } else {
        res.status(409).end();
      }
    }).catch(function () {
      res.status(500).end();
    });

  }

  var multipleMiddlewareCheck = 17;
  function customRouteMiddleware1(req, res, next) {
    debug('customRouteMiddleware1 resets multipleMiddlewareCheck to 0 (was 17).');
    multipleMiddlewareCheck = 0;
    next();
  }

  function customRouteMiddleware2(req, res, next) {
    debug('customRouteMiddleware2 increases from 0 -> 1, so the end result should be 1');
    multipleMiddlewareCheck++;
    next();
  }

  function multipleMiddlewareResultHandler(req, res) {
    res.status(200).send('' + multipleMiddlewareCheck);
  }

  var singleMiddlewareCheck = 29;
  function customRouteMiddleWare3(req, res, next) {
    debug('customRouteMiddleWare3 sets singleMiddlewareCheck to 0.');
    singleMiddlewareCheck = 0;
    next();
  }

  function singleMiddlewareResultHandler(req, res) {
    res.status(200).send('' + singleMiddlewareCheck);
  }

  var ret = {
    type: '/persons',
    'public': false, // eslint-disable-line
    map: {
      firstname: {},
      lastname: {},
      street: {},
      streetnumber: {},
      streetbus: {
        onread: $m.removeifnull
      },
      zipcode: {},
      city: {},
      phone: {
        onread: $m.removeifnull
      },
      email: {
        onread: $m.removeifnull
      },
      balance: {
        oninsert: $m.value(0),
        onupdate: $m.remove
      },
      mail4elas: {},
      community: {
        references: '/communities'
      }
    },
    secure: [
      restrictReadPersons,
      // Ingrid Ohno
      disallowOnePerson('da6dcc12-c46f-4626-a965-1a00536131b2')
    ],
    customroutes: [
      {route: '/persons/:key/simple', handler: simpleOutput},
      {route: '/persons/:key/wrong-handler', handler: wrongHandler},
      {
        route: '/persons/:key/single-middleware',
        method: 'GET',
        middleware: customRouteMiddleWare3,
        handler: singleMiddlewareResultHandler
      },
      {
        route: '/persons/:key/multiple-middleware',
        method: 'GET',
        middleware: [
          customRouteMiddleware1,
          customRouteMiddleware2
        ],
        handler: multipleMiddlewareResultHandler
      }
    ],
    schema: {
      $schema: 'http://json-schema.org/schema#',
      title: 'An object representing a person taking part in the LETS system.',
      type: 'object',
      properties: {
        firstname: $s.string('First name of the person.'),
        lastname: $s.string('Last name of the person.'),
        street: $s.string('Streetname of the address of residence.'),
        streetnumber: $s.string('Street number of the address of residence.'),
        streetbus: $s.string('Postal box of the address of residence.'),
        zipcode: $s.belgianzipcode('4 digit postal code of the city for the address of residence.'),
        city: $s.string('City for the address of residence.'),
        phone: $s.phone('The telephone number for this person. Can be a fixed or mobile phone number.'),
        email: $s.email('The email address the person can be reached on. ' +
          'It should be unique to this person. ' +
          'The email should not be shared with others.'),
        mail4elas: {
          type: 'string',
          description: 'Describes if, and how often this person wants messages to be emailed.',
          enum: ['never', 'daily', 'weekly', 'instant']
        }
      },
      required: ['firstname', 'lastname', 'street', 'streetnumber', 'zipcode', 'city', 'mail4elas']
    },
    validate: [],
    query: {
      communities: $q.filterReferencedType('/communities', 'community'),
      defaultFilter: $q.defaultFilter
    },
    afterread: [
      $u.addReferencingResources('/transactions', 'fromperson', '$$transactions'),
      $u.addReferencingResources('/transactions', 'fromperson', '$$transactionsExpanded', true),
      checkMe,
      failOnBadUser,
      forbidUser
    ],
    afterupdate: [
      checkMe, checkElements, failOnBadUser, forbidUser
    ],
    afterinsert: [checkMe, checkElements, failOnBadUser, forbidUser],
    afterdelete: [
      checkMe, checkElements, failOnBadUser, forbidUser
    ]
  };

  common.mergeObject(extra, ret);
  return ret;
};
