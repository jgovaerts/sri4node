/*
Utility function for reeading the information schema
of the database. Creates a global cache, and assumes
the information schema does not change at runtime.

It returns a 2-dimensional associative array that
can be accessed like this :

var is = require('./informationSchema.js')(database, configuration, logverbose);
var type = is['/communities']['phone'];
if(type === 'text') {
  // do something.
}
*/
var unique = require('array-unique');
var qo = require('./queryObject.js');
var Q = require('q');
var common = require('./common.js');
//var cl = common.cl;
var pgExec = common.pgExec;
var cache = null;

exports = module.exports = function (database, resources) {
  'use strict';
  var deferred = Q.defer();
  var q, tableNames;
  var i, type, table, tableName, row, typeCache, columnCache;

  /*function debug(x) {
    if (configuration.logdebug) {
      cl(x);
    }
  }*/

  if (cache !== null) {
    deferred.resolve(cache);
  } else {
    q = qo.prepareSQL('information-schema');
    tableNames = [];

    for (i = 0; i < resources.length; i++) {
      type = resources[i].type;
      table = resources[i].table;
      tableName = table ? table : type.split('/')[type.split('/').length - 1];
      tableNames.push(tableName);
    }
    tableNames = unique(tableNames);
    q.sql('select table_name, column_name, data_type from information_schema.columns');
    pgExec(database, q).then(function (results) {
      cache = {};
      for (i = 0; i < results.rows.length; i++) {
        row = results.rows[i];

        if (!cache['/' + row.table_name]) {
          cache['/' + row.table_name] = {};
        }
        typeCache = cache['/' + row.table_name];

        if (!typeCache[row.column_name]) {
          typeCache[row.column_name] = {};
        }
        columnCache = typeCache[row.column_name];

        // We may add extra fields like precision, etc.. in the future.
        columnCache.type = row.data_type;
      }
      deferred.resolve(cache);
    }).fail(function (e) {
      deferred.reject(e);
    });
  }

  return deferred.promise;
};
