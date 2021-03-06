// Utility methods for calling the SRI interface
var assert = require('assert');
var sriclient = require('sri4node-client');
var doGet = sriclient.get;
var doPut = sriclient.put;

exports = module.exports = function (base) {
  'use strict';

  describe('Modify resource', function () {

    it('it should have the field created with a valid timestamp', function () {
      return doGet(base + '/alldatatypes/e7e49d48-010b-480d-9f90-cdcd802a3096', 'kevin@email.be', 'pwd')
      .then(function (response) {
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.id, 38);
        assert(response.body.$$meta.created);
      });
    });

    it('it should have the field modified with a timestamp after the previous one after the resource is updated',
    function () {
      var currentModified;
      var newModified;
      return doGet(base + '/alldatatypes/e7e49d48-010b-480d-9f90-cdcd802a3096', 'kevin@email.be', 'pwd')
      .then(function (response) {
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.id, 38);
        currentModified = new Date(response.body.$$meta.modified).getTime();
        return response.body;
      }).then(function (current) {
        return doPut(base + '/alldatatypes/e7e49d48-010b-480d-9f90-cdcd802a3096', current, 'kevin@email.be', 'pwd')
          .then(
            function () {
              return doGet(base + '/alldatatypes/e7e49d48-010b-480d-9f90-cdcd802a3096', 'kevin@email.be', 'pwd');
            }
          )
          .then(
            function (response) {
              assert.equal(response.statusCode, 200);
              assert.equal(response.body.id, 38);
              newModified = new Date(response.body.$$meta.modified).getTime();
              assert(newModified > currentModified);
            }
          );
      });
    });

    it('it should support modifiedSince as a filter (backward compatibility)', function () {

      return doGet(base + '/alldatatypes/e7e49d48-010b-480d-9f90-cdcd802a3096', 'kevin@email.be', 'pwd')
      .then(function (response) {
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.id, 38);
        return response.body.$$meta.modified;
      }).then(
        function (currentModified) {
          return doGet(base + '/alldatatypes?modifiedSince=' + currentModified, 'kevin@email.be', 'pwd');
        })
        .then(
        function (response) {
          assert.equal(response.statusCode, 200);
          assert(response.body.results.length > 0);
        });
    });

  });

};
