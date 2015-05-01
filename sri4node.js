/*
  The core server for the REST api.
  It is configurable, and provides a simple framework for creating REST interfaces.
*/
var validator = require('jsonschema').Validator;
var Q = require("q");

var configuration;
var resources;
var logsql;
var pg;

// Q wrapper to get a node-postgres client from the client pool.
// It returns a Q promise to allow chaining, error handling, etc.. in Q-style.
var pgConnect = function () {
    var deferred = Q.defer();

    // ssl=true is required for heruko.com
    // ssl=false is required for development on local postgres (Cloud9)
    var dbUrl;
    if(process.env.DATABASE_URL) {
        dbUrl = process.env.DATABASE_URL + "?ssl=true";
    } else {
        dbUrl = configuration.defaultdatabaseurl;
    }
    //cl("Using database connection string : [" + dbUrl + "]");
    
    pg.connect(dbUrl, function (err, client, done) {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve({
                client: client,
                done: done
            });
        }
    });

    return deferred.promise;
};

// Q wrapper for executing SQL statement on a node-postgres client.
//
// Instead the db object is a node-postgres Query config object.
// See : https://github.com/brianc/node-postgres/wiki/Client#method-query-prepared.
//
// name : the name for caching as prepared statement, if desired.
// text : The SQL statement, use $1,$2, etc.. for adding parameters.
// values : An array of java values to be inserted in $1,$2, etc..
//
// It returns a Q promise to allow chaining, error handling, etc.. in Q-style.
var pgExec = function (db, query) {
    var deferred = Q.defer();

    if (logsql) {
        cl(query);
    }

    db.client.query(query, function (err, result) {
        if (err) {
            if (logsql) {
                cl("SQL error :");
                cl(err);
            }
            deferred.reject(err);
        } else {
            if (logsql) {
                cl("SQL result : ");
                cl(result.rows);
            }
            deferred.resolve(result);
        }
    });

    return deferred.promise;
};

// Creates a config object for q node-postgres prepared statement.
// It also adds some convenience functions for handling appending of SQL and parameters.
var prepare = function(name) {
    return {
        name: name,
        text: '',
        values: [],
        param: function(x) {
            // Convenience function for adding a parameter to the text, it
            // automatically adds $x to the SQL text, and adds the supplied value
            // to the 'value'-array.
            var index = this.values.length + 1;
            this.values.push(x);
            this.text = this.text + "$" + index;

            return this;
        },
        sql: function(x) {
            // Convenience function for adding a parameter to the SQL statement.
            this.text = this.text + x;

            return this;
        },
        array: function(x) {
            // Convenience function for adding an array of values to a SQL statement.
            // The values are added comma-separated.

            if(x && x.length && x.length > 0) {
                for(var i=0; i< x.length; i++) {
                    this.param(x[i]);
                    if (i < (x.length - 1)) {
                        this.text = this.text + ',';
                    }
                }
            }

            return this;
        },
        columns: function(o) {
            // Convenience function for adding all keys in an object (comma-separated)
            var columnNames = [];

            for (var key in o) {
                if (o.hasOwnProperty(key)) {
                    columnNames.push(key);
                }
            }
            var sqlColumnNames = '';
            for (var j = 0; j < columnNames.length; j++) {
                sqlColumnNames += columnNames[j];
                if (j < columnNames.length - 1) {
                    sqlColumnNames += ",";
                }
            }
            this.text = this.text + sqlColumnNames;

            return this;
        },
        object: function(o) {
            // Convenience function for adding all values of an object as parameters.
            // Same iteration order as 'columns'.
            var firstcolumn = true;
            for (var key in o) {
                if (o.hasOwnProperty(key)) {
                    if(!firstcolumn) {
                        this.text += ",";
                    } else {
                        firstcolumn = false;
                    }
                    this.param(o[key]);
                }
            }

            return this;
        }
    }
};

// Converts the configuration object for roa4node into an array per resource type.
var typeToConfig = function(config) {
    var ret = {};
    for (var i = 0; i < config.length; i++) {
        ret[config[i].type] = config[i];
    }
    return ret;
};

// Create a ROA resource, based on a row result from node-postgres.
function mapColumnsToObject(config, mapping, row, element) {
    var typeToMapping = typeToConfig(config);

    // add all mapped columns to output.
    for (var key in mapping.map) {
        if (mapping.map.hasOwnProperty(key)) {
            if (mapping.map[key].references) {
                var referencedType = mapping.map[key].references;
                element[key] = {href: typeToMapping[referencedType].type + '/' + row[key]};
            } else if (mapping.map[key].onlyinput) {
                // Skip on output !
            } else {
                element[key] = row[key];
            }
        }
    }
}

function sqlColumnNames(mapping) {
    var columnNames = [];

    for (var key in mapping.map) {
        if (mapping.map.hasOwnProperty(key)) {
            columnNames.push(key);
        }
    }
    var sqlColumnNames = 'guid,';
    for (var j = 0; j < columnNames.length; j++) {
        sqlColumnNames += columnNames[j];
        if (j < columnNames.length - 1) {
            sqlColumnNames += ",";
        }
    }

    return sqlColumnNames;
}

// apply extra parameters on request URL for a list-resource to a sselect.
function applyRequestParameters(mapping, req, select) {
    var urlparameters = req.query;

    var standard_parameters = ['orderby', 'descending', 'limit', 'offset'];

    if (mapping.query) {
        for (var key in urlparameters) {
            if (urlparameters.hasOwnProperty(key)) {
                if (standard_parameters.indexOf(key) == -1) {
                    if (mapping.query[key]) {
                        // Execute the configured function that will apply this URL parameter
                        // to the SELECT statement
                        mapping.query[key](urlparameters[key], select);
                    } else {
                        cl("Unknown query parameter [" + key + "]. Ignoring..");
                    }
                }
            }
        }
    }
}

// Execute registered mapping functions for elements of a ROA resource.
function executeOnFunctions(config, mapping, ontype, element) {
    for (var key in mapping.map) {
        if (mapping.map.hasOwnProperty(key)) {
            if (mapping.map[key][ontype]) {
                mapping.map[key][ontype](key, element);
            }
        }
    }
}

function queryByGuid(config, db, mapping, guid) {
    var columns = sqlColumnNames(mapping);
    var table = mapping.type.split("/")[1];

    var query = prepare('select-row-by-guid-from-' + table);
    query.sql('select ' + columns + ' from "' + table + '" where "guid" = ').param(guid);
    return pgExec(db, query).then(function (result) {
        var deferred = Q.defer();
        
        var rows = result.rows;
        if(rows.length == 1) {
            var row = result.rows[0];
            var output = {};
            mapColumnsToObject(config, mapping, row, output);
            executeOnFunctions(config, mapping, "onread", output);
            deferred.resolve(output);
        } else if (rows.length == 0) {
            deferred.reject("NOT FOUND");
        } else {
            var msg = "More than one entry with guid " + guid + " found for " + mapping.type;
            debug(msg);
            deferred.reject(new Error(msg));
        }    
        return deferred.promise;
    });
}

function getSchemaValidationErrors(json, schema) {
    var asCode = function (s) {
        // return any string as code for REST API error object.
        var ret = s;

        ret = ret.toLowerCase().trim();
        ret = ret.replace(/[^a-z0-9 ]/gmi, "");
        ret = ret.replace(/ /gmi, ".");

        return ret;
    };

    var v = new validator();
    var result = v.validate(json, schema);

    if (result.errors && result.errors.length > 0) {
        cl("Schema validation revealed errors.");
        cl(result.errors);
        cl("JSON schema was : ");
        cl(schema);
        cl("Document was : ");
        cl(json);
        var ret = {};
        ret.errors = [];
        ret.document = json;
        for (var i = 0; i < result.errors.length; i++) {
            var current = result.errors[i];
            var err = {};
            err.code = asCode(current.message);
            if(current.property && current.property.indexOf("instance.") == 0) {
                err.path = current.property.substring(9);
            }
            ret.errors.push(err);
        }
        return ret;
    }
}

function send500(resp) {
    return function (error) {
        cl("Error. Sending status 500.");
        cl(error);
        resp.status(500).send("Internal Server Error. [" + error.toString() + "]");
    };
}

function endResponse(resp) {
    return function () {
        resp.end();
    };
}

function cl(x) {
    console.log(x);
}

function debug(x) {
    if(configuration.debug) console.log(x);
}

// Security cache; stores a map 'e-mail' -> 'password'
// To avoid a database query for all API calls.
var knownPasswords = {};

// Force https in production.
function forceSecureSockets(req, res, next) {
    var isHttps = req.headers['x-forwarded-proto'] == 'https';
    if (!isHttps && req.get('Host').indexOf('localhost') < 0 && req.get('Host').indexOf('127.0.0.1') < 0) {
        return res.redirect('https://' + req.get('Host') + req.url);
    }

    next();
}

function checkBasicAuthentication(req, res, next) {
    var path = req.route.path;
    if(path !== '/me' && path != '/batch') {
        var typeToMapping = typeToConfig(resources);
        var type = '/' + req.route.path.split("/")[1];
        var mapping = typeToMapping[type];
        if(mapping.public) {
            next();
            return;
        }
    }
    
    var forbidden = function () {
        res.setHeader('WWW-Authenticate', 'Basic realm="Secure Area"');
        res.status(401).send("Forbidden");
    };

    if (req.headers.authorization) {
        var basic = req.headers.authorization;
        var encoded = basic.substr(6);
        var decoded = new Buffer(encoded, 'base64').toString('utf-8');
        var firstColonIndex = decoded.indexOf(':');
        if (firstColonIndex != -1) {    
            var email = decoded.substr(0, firstColonIndex);
            var password = decoded.substr(firstColonIndex + 1);
            if (email && password && email.length > 0 && password.length > 0) {
                if (knownPasswords[email]) {
                    if (knownPasswords[email] === password) {
                        next();
                    } else {
                        debug("Invalid password");
                        forbidden();
                    }
                } else {
                    var database;
                    pgConnect().then(function (db) {
                        database = db;

                        var q = prepare("select-count-from-persons-where-email-and-password");
                        q.sql('select count(*) from persons where email = ').param(email).sql(' and password = ').param(password);

                        return pgExec(db, q).then(function (result) {
                            var count = parseInt(result.rows[0].count);
                            if (count == 1) {
                                // Found matching record, add to cache for subsequent requests.
                                knownPasswords[email] = password;
                                next();
                            } else {
                                debug("Wrong combination of email / password. Found " + count + " records.");
                                forbidden();
                            }
                        });
                    }).then(function () {
                        database.done();
                    }).fail(function (err) {
                        cl("checking basic authentication against database failed.");
                        cl(err);
                        database.done(err);
                        forbidden();
                    });
                }
            } else forbidden();
        } else forbidden();
    } else {
        debug("No authorization header received from client. Rejecting.");
        forbidden();
    }
}

// Apply CORS headers.
// TODO : Change temporary URL into final deploy URL.
var allowCrossDomain = function(req, res, next) {
    res.header('Access-Control-Allow-Origin', 'https://sheltered-lowlands-3555.herokuapp.com');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    next();
};

function logRequests(req, res, next) {
    if(configuration.enableLoggingOfRequests) {
        cl(req.method + " " + req.path + " starting.");
        var start = Date.now();
        res.on('finish', function () {
            var duration = Date.now() - start;
            cl(req.method + " " + req.path + " took " + duration + " ms. ");
        });
    }
    next();
}

function executePutInsideTransaction(db, url, body) {
    var type = '/' + url.split("/")[1];
    var guid = url.split("/")[2];
    
    debug('PUT processing starting. Request body :');
    debug(body);
    
    var typeToMapping = typeToConfig(resources);
    // var type = '/' + req.route.path.split("/")[1];
    var mapping = typeToMapping[type];
    var table = mapping.type.split("/")[1];

    if (mapping.schemaUtils) {
        var errors = getSchemaValidationErrors(body, mapping.schemaUtils);
        if (errors) {
            var deferred = Q.defer();
            deferred.reject(errors);
            return deferred.promise;
        } else {
            debug("Schema validation passed.");
        }
    }

    // create an object that only has mapped properties
    var element = {};
    for (var key in mapping.map) {
        if (mapping.map.hasOwnProperty(key)) {
            if(body[key]) {
                element[key] = body[key];
            }
        }
    }
    
    // check and remove types from references.
    for (var key in mapping.map) {
        if (mapping.map.hasOwnProperty(key)) {
            if (mapping.map[key].references) {
                var value = element[key].href;
                if(!value) {
                    throw new Error("No href found inside reference " + key);
                }
                var referencedType = mapping.map[key].references;
                var referencedMapping = typeToMapping[referencedType];
                var parts = value.split("/");
                var type = '/' + parts[1];
                var refguid = parts[2];
                if (type === referencedMapping.type) {
                    element[key] = refguid;
                } else {
                    cl("Faulty reference detected [" + element[key].href + "], detected [" + type + "] expected [" + referencedMapping.type + "]");
                    return;
                }
            }
        }
    }
    debug('Converted references to values for update');

    var countquery = prepare('check-resource-exists-' + table);
    countquery.sql('select count(*) from ' + table + ' where "guid" = ').param(guid);
    return pgExec(db, countquery).then(function (results) {
        var deferred = Q.defer();

        if (results.rows[0].count == 1) {
            executeOnFunctions(resources, mapping, "onupdate", element);

            var update = prepare('update-' + table);
            update.sql('update ' + table + ' set ');
            var firstcolumn = true;
            for (var key in element) {
                if (element.hasOwnProperty(key)) {
                    if(!firstcolumn) {
                        update.sql(',');
                    } else {
                        firstcolumn = false;
                    }

                    update.sql(key + '=').param(element[key]);
                }
            }
            update.sql(" where guid = ").param(guid);

            return pgExec(db, update).then(function (results) {
                if (mapping.afterupdate && mapping.afterupdate.length > 0) {
                    if (mapping.afterupdate.length == 1) {
                        debug("Executing one afterupdate function...");
                        return mapping.afterupdate[0](db, element);
                    } else {
                        // TODO : Support more than one after* function.
                        cl("More than one after* function not supported yet. Ignoring");
                    }
                } else {
                    debug("No afterupdate functions...");
                }
            });
        } else {
            element.guid = guid;
            executeOnFunctions(resources, mapping, "oninsert", element);

            var insert = prepare("insert-"+ table);
            insert.sql('insert into ' + table + ' (').columns(element).sql(') values (').object(element).sql(') ');
            return pgExec(db, insert).then(function (results) {
                if (mapping.afterinsert && mapping.afterinsert.length > 0) {
                    if (mapping.afterinsert.length == 1) {
                        return mapping.afterinsert[0](db, element);
                    } else {
                        // TODO : Support more than one after* function.
                        cl("More than one after* function not supported yet. Ignoring");
                    }
                }
            });
        }
    }); // pgExec(db,countquery)...
}

// Local cache of known identities.
var knownIdentities = {};
// Returns a JSON object with the identity of the current user.
function getMe(req) {
    var deferred = Q.defer();
    
    var basic = req.headers.authorization;
    var encoded = basic.substr(6);
    var decoded = new Buffer(encoded, 'base64').toString('utf-8');
    var firstColonIndex = decoded.indexOf(':');
    if (firstColonIndex != -1) {
        var username = decoded.substr(0, firstColonIndex);
        if(knownIdentities[username]) {
            deferred.resolve(knownIdentities[username]);
        } else {
            var database;
            pgConnect().then(function (db) {
                database = db;
                return configuration.identity(username, db);
            }).then(function(me) {
                knownIdentities[username] = me;
                database.done();
                deferred.resolve(me);
            }).fail(function(err) {
                cl("Retrieving of identity had errors. Removing pg client from pool. Error : ")
                cl(err);
                database.done(err);
                deferred.reject(err);
            });
        }
    }
    
    return deferred.promise;
}

function validateAccessAllowed(mapping, db, req, resp, me) {
    var deferred = Q.defer();
    
    // Array of functions that returns promises. If any of the promises fail, 
    // the response will be 401 Forbidden. All promises must resolve (to empty values)
    var secure = mapping.secure;
    
    var promises = [];
    secure.forEach(function (f) {
        promises.push(f(req, resp, db, me));
    });
    
    if(secure.length > 0) {
        Q.all(promises).then(function(result) {
            deferred.resolve();
        }).catch(function(result) {
            deferred.reject("FORBIDDEN");
        });
    } else {
        deferred.resolve();
    }

    return deferred.promise;
}

/* express.js application, configuration for roa4node */
exports = module.exports = {
    configure: function (app, postgres, config) {
        configuration = config;
        resources = config.resources;
        logsql = config.logsql;
        pg = postgres;

        // All URLs force SSL and allow cross origin access.
        app.use(forceSecureSockets);
        app.use(allowCrossDomain);

        for (var configIndex = 0; configIndex < resources.length; configIndex++) {
            var mapping = resources[configIndex];
            var url;

            // register schema for external usage. public.
            url = mapping.type + '/schema';
            app.use(url, logRequests);
            app.get(url, function (req, resp) {
                var typeToMapping = typeToConfig(resources);
                var type = '/' + req.route.path.split("/")[1];
                var mapping = typeToMapping[type];

                resp.set('Content-Type', 'application/json');
                cl(mapping.schemaUtils);
                resp.send(mapping.schemaUtils);
            });

            // register list resource for this type.
            url = mapping.type;
            app.get(url, logRequests, checkBasicAuthentication, function (req, resp) {
                var typeToMapping = typeToConfig(resources);
                var type = '/' + req.route.path.split("/")[1];
                var mapping = typeToMapping[type];
                var columns = sqlColumnNames(mapping);
                var table = mapping.type.split("/")[1];

                var countquery = prepare();
                countquery.sql('select count(*) from "' + table + '" where 1=1 ');
                applyRequestParameters(mapping, req, countquery);
                var database;
                pgConnect().then(function (db) {
                    database = db;
                    return pgExec(db, countquery).then(function (results) {
                        var count = parseInt(results.rows[0].count);
                        var query = prepare();
                        query.sql('select ' + columns + ' from "' + table + '" where 1=1 ');
                        applyRequestParameters(mapping, req, query);

                        // All list resources support orderby, limit and offset.
                        var orderby = req.query.orderby;
                        var descending = req.query.descending;
                        if (orderby) {
                            var valid = true;
                            var orders = orderby.split(",");
                            for (var o = 0; o < orders.length; o++) {
                                var order = orders[o];
                                if (!mapping.map[order]) {
                                    valid = false;
                                    break;
                                }
                            }
                            if (valid) {
                                query.sql(" order by " + orders);
                                if (descending) query.sql(" desc");
                            } else {
                                cl("Can not order by [" + orderby + "]. One or more unknown properties. Ignoring orderby.");
                            }
                        }

                        if (req.query.limit) query.sql(" limit ").param(req.query.limit);
                        if (req.query.offset) query.sql(" offset ").param(req.query.offset);

                        return pgExec(db, query).then(function (result) {
                            var rows = result.rows;
                            var results = [];
                            for (var row = 0; row < rows.length; row++) {
                                var currentrow = rows[row];

                                var element = {
                                    href: mapping.type + '/' + currentrow.guid
                                };

                                if (req.query.expand !== 'full') {
                                    element.$$expanded = {
                                        $$meta: {
                                            permalink: mapping.type + '/' + currentrow.guid
                                        }
                                    };
                                    mapColumnsToObject(resources, mapping, currentrow, element.$$expanded);
                                    executeOnFunctions(resources, mapping, "onread", element.$$expanded);
                                }
                                results.push(element);
                            }

                            var output = {
                                $$meta: {
                                    count: count
                                },
                                results: results
                            };
                            resp.set('Content-Type', 'application/json');
                            resp.send(output);
                        });
                    })
                })
                    .then(function () {
                        database.done();
                        resp.end();
                    })
                    .fail(function (err) {
                        cl("GET processing had errors. Removing pg client from pool. Error : ");
                        cl(err);
                        database.done(err);
                        resp.status(500).send("Internal Server Error. [" + error.toString() + "]");
                        resp.end();
                    });
            }); // app.get - list resource

            // register single resource
            url = mapping.type + '/:guid';
            app.route(url).get(logRequests, checkBasicAuthentication, function (req, resp) {
                var typeToMapping = typeToConfig(resources);
                var type = '/' + req.route.path.split("/")[1];
                var mapping = typeToMapping[type];
                var guid = req.params.guid;

                var database;
                pgConnect().then(function(db) {
                    database = db;
                    if(!mapping.public) {
                        return getMe(req);
                    }
                }).then(function(me) {
                    // me == null if no authentication header was sent by the client.
                    if(!mapping.public) {
                        debug("running config.secure functions");
                        return validateAccessAllowed(mapping,database,req,resp,me);
                    }
                }).then(function () {
                    debug("query by guid");
                    return queryByGuid(resources, database, mapping, guid);
                }).then(function (element) {
                    element.$$meta = {permalink: mapping.type + '/' + guid};
                    resp.set('Content-Type', 'application/json');
                    resp.send(element);
                }).then(function () {
                    debug("done");
                    database.done();
                    resp.end();
                }).fail(function (err) {
                    if(err === "FORBIDDEN") {
                        debug("401 Forbidden");
                        database.done();
                        resp.status(401).send("Forbidden");
                        resp.end();
                    } else if(err == "NOT FOUND") {
                        debug("403 Not Found");
                        database.done();
                        resp.status(403).send("Not Found");
                        resp.end();
                    } else {
                        cl("GET processing had errors. Removing pg client from pool. Error : ");
                        cl(err);
                        database.done(err);
                        cl("Client removed from pool");
                        resp.status(500).send("Internal Server Error. [" + err.toString() + "]");
                        resp.end();
                    }
                });
            }).put(logRequests, checkBasicAuthentication, function(req, resp) {
                var url = req.path;
                pgConnect().then(function (db) {
                    var begin = prepare("begin-transaction");
                    begin.sql('BEGIN');
                    return pgExec(db, begin).then(function () {
                        return executePutInsideTransaction(db, url, req.body);
                    }).then(function () {
                        debug("PUT processing went OK. Committing database transaction.");
                        db.client.query("COMMIT", function (err) {
                            // If err is defined, client will be removed from pool.
                            db.done(err);
                            debug("COMMIT DONE.");
                            resp.send(true);
                            resp.end();
                        });
                    }).fail(function (puterr) {
                        cl("PUT processing failed. Rolling back database transaction. Error was :");
                        cl(puterr);
                        db.client.query("ROLLBACK", function (rollbackerr) {
                            // If err is defined, client will be removed from pool.
                            db.done(rollbackerr);
                            cl("ROLLBACK DONE.");
                            resp.status(409).send(puterr);
                            resp.end();
                        });
                    });
                }); // pgConnect
            }).delete(logRequests, checkBasicAuthentication, function (req, resp) {
                debug('sri4node DELETE invoked');
                var typeToMapping = typeToConfig(resources);
                var type = '/' + req.route.path.split("/")[1];
                var mapping = typeToMapping[type];
                var table = mapping.type.split("/")[1];

                pgConnect().then(function (db) {
                    var begin = prepare("begin-transaction");
                    begin.sql("BEGIN");
                    return pgExec(db, begin).then(function () {
                        var deletequery = prepare("delete-by-guid-" + table);
                        deletequery.sql('delete from "' + table + '" where "guid" = ').param(req.params.guid);

                        return pgExec(db, deletequery).then(function (results) {
                            if (results.rowCount == 1) {
                                if (mapping.afterdelete && mapping.afterdelete.length > 0) {
                                    if (mapping.afterdelete.length == 1) {
                                        return mapping.afterdelete[0](db, req.params.guid);
                                    } else {
                                        // TODO : Support more than one after* function.
                                        cl("More than one after* function not supported yet. Ignoring");
                                    }
                                }
                            }
                        }); // pgExec delete
                    }).then(function () {
                        debug("DELETE processing went OK. Committing database transaction.");
                        db.client.query("COMMIT", function (err) {
                            // If err is defined, client will be removed from pool.
                            db.done(err);
                            debug("COMMIT DONE.");
                            resp.send(true);
                            resp.end();
                        });
                    }).fail(function (delerr) {
                        cl("DELETE processing failed. Rolling back database transaction. Error was :");
                        cl(delerr);
                        db.client.query("ROLLBACK", function (rollbackerr) {
                            // If err is defined, client will be removed from pool.
                            db.done(rollbackerr);
                            cl("ROLLBACK DONE. Sending 500 Internal Server Error. [" + delerr.toString() + "]");
                            resp.status(500).send("Internal Server Error. [" + delerr.toString() + "]");
                            resp.end();
                        });
                    });
                }); // pgConnect
            }); // app.delete
        } // for all mappings.

        url = '/batch';
        app.put(url, logRequests, checkBasicAuthentication, function(req, resp) {
            // An array of objects with 'href', 'verb' and 'body'
            var batch = req.body;
            batch.reverse();

            pgConnect().then(function (db) {
                var begin = prepare('begin-transaction');
                begin.sql("BEGIN");
                return pgExec(db, begin).then(function () {
                    var promises = [];

                    function recurse(batch) {
                        if(batch.length > 0) {
                            var element = batch.pop();
                            var url = element.href;
                            cl("executing /batch section " + url);
                            var body = element.body;
                            var verb = element.verb;
                            if(verb === "PUT") {
                                return executePutInsideTransaction(db, url, body).then(function() {
                                    return recurse(batch);
                                });
                            } else {
                                cl("UNIMPLEMENTED - /batch ONLY SUPPORTS PUT OPERATIONS !!!");
                                throw new Error();
                            }
                        }
                    }

                    return recurse(batch);
                }) // pgExec(db,SQL("BEGIN")...
                    .then(function () {
                        cl("PUT processing went OK. Committing database transaction.");
                        db.client.query("COMMIT", function (err) {
                            // If err is defined, client will be removed from pool.
                            db.done(err);
                            cl("COMMIT DONE.");
                            resp.send(true);
                            resp.end();
                        });
                    })
                    .fail(function (puterr) {
                        cl("PUT processing failed. Rolling back database transaction. Error was :");
                        cl(puterr);
                        db.client.query("ROLLBACK", function (rollbackerr) {
                            // If err is defined, client will be removed from pool.
                            db.done(rollbackerr);
                            cl("ROLLBACK DONE.");
                            resp.status(500).send(puterr);
                            resp.end();
                        });
                    });
            }); // pgConnect
        }); // app.put('/batch');

        url = '/me';
        app.get(url, logRequests, checkBasicAuthentication, function (req, resp) {
            getMe(req).then(function(me) {
                resp.set('Content-Type', 'application/json');
                resp.send(me);
            }).fail(function() {
                resp.status(500).send("Internal Server Error. [" + error.toString() + "]");
                resp.end();
            });
        });

        app.put('/log', function (req, resp) {
            var error = req.body;
            cl("Client side error :");
            var lines = error.stack.split("\n");
            for(var i=0; i<lines.length; i++) {
                cl(lines[i]);
            }
            resp.end();
        });
    },

    utils: {
        // Call this is you want to clear the password and identity cache for the API.
        clearPasswordCache : function() {
            knownPasswords = {};
            knownIdentities = {};
        },

        // Utility to run arbitrary SQL in validation, beforeupdate, afterupdate, etc..
        executeSQL : pgExec,
        prepareSQL : prepare
    },

    mapUtils : {
        removeifnull : function(key, e) {
            if(e[key] == null) delete e[key];
        },
        remove : function(key, e) {
            delete e[key];
        },
        now : function(key, e) {
            e[key] = new Date().toISOString();
        },
        value : function(value) {
            return function(key, e) {
                e[key] = value;
            };
        },
        parse : function() {
            return function(key, e) {
                e[key] = JSON.parse(e[key]);
            };
        },
        stringify : function() {
            return function(key, e) {
                e[key] = JSON.stringify(e[key]);
            };
        }
    },

    schemaUtils : {
        permalink: function(type, description) {
            var parts = type.split("/");
            var name = parts[1];

            return {
                type: "object",
                properties: {
                    href: {
                        type: "string",
                        pattern: "^\/" + name + "\/[-0-9a-f].*$",
                        minLength: name.length + 38,
                        maxLength: name.length + 38,
                        description: description
                    }
                },
                required: ["href"]
            };
        },

        string: function(min, max, description) {
            return {
                type: "string",
                minLength: min,
                maxLength: max,
                description: description
            }
        },

        numeric: function(description) {
            return {
                type: "numeric",
                multipleOf: "1.0",
                description: description
            }
        },

        email: function(description) {
            return {
                type: "string",
                format: "email",
                minLength: 1,
                maxLength: 64,
                description: description
            }
        },

        url: function(description) {
            return {
                type: "string",
                minLength: 1,
                maxLength: 256,
                format: "uri",
                description: description
            }
        },

        zipcode: function(description) {
            return {
                type: "string",
                pattern: "^[0-9][0-9][0-9][0-9]$",
                description: description
            };
        },

        phone: function(description) {
            return {
                type: "string",
                pattern: "^[0-9]*$",
                minLength: 9,
                maxLength: 10,
                description: description
            };
        },

        timestamp : function(description) {
            return {
                type: "string",
                format: "date-time",
                description: description
            }
        },

        boolean : function(description) {
            return {
                type: "boolean",
                description: description
            }
        }
    }
}
