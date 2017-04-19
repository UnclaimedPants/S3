import assert from 'assert';

import withV4 from '../support/withV4';
import BucketUtility from '../../lib/utility/bucket-util';

import {
    removeAllVersions,
    versioningEnabled,
} from '../../lib/utility/versioning-util.js';

const key = 'objectKey';

function _assertNoError(err, desc) {
    assert.ifError(err, `Unexpected err ${desc}: ${err}`);
}

function _assertError(err, statusCode, code) {
    assert.notEqual(err, null,
        'Expected failure but got success');
    assert.strictEqual(err.code, code);
    assert.strictEqual(err.statusCode, statusCode);
}

const testing = process.env.VERSIONING === 'no' ? describe.skip : describe;

testing('get object with versioning', function testSuite() {
    this.timeout(600000);

    withV4(sigCfg => {
        const bucketUtil = new BucketUtility('default', sigCfg);
        const s3 = bucketUtil.s3;
        let bucket;

        beforeEach(done => {
            bucket = `versioning-bucket-${Date.now()}`;
            s3.createBucket({ Bucket: bucket }, err => {
                _assertNoError(err, 'createBucket');
                return s3.putBucketVersioning({
                    Bucket: bucket,
                    VersioningConfiguration: versioningEnabled,
                }, done);
            });
        });

        afterEach(done => {
            removeAllVersions({ Bucket: bucket }, err => {
                _assertNoError(err, 'removeAllVersions');
                return s3.deleteBucket({ Bucket: bucket }, done);
            });
        });

        describe('get a delete marker', () => {
            beforeEach(function beforeEachF(done) {
                s3.deleteObject({ Bucket: bucket, Key: key },
                  (err, data) => {
                      _assertNoError(err, 'deleteObject');
                      this.currentTest.deleteVersionId = data.VersionId;
                      done(err);
                  });
            });

            it('should not be able to get a delete marker', function itF(done) {
                s3.getObject({
                    Bucket: bucket,
                    Key: key,
                    VersionId: this.test.deleteVersionId },
                err => {
                    _assertError(err, 405, 'MethodNotAllowed');
                    done();
                });
            });

            it('should not be able to get a delete marker without ' +
            'mentioning versionID ', done => {
                s3.getObject({
                    Bucket: bucket,
                    Key: key },
                err => {
                    _assertError(err, 404, 'NoSuchKey');
                    done();
                });
            });
        });

        describe('getting a object that has been deleted', () => {
            beforeEach(function beforeEachF(done) {
                s3.putObject({ Bucket: bucket, Key: key }, (err, data) => {
                    _assertNoError(err, 'putObject');
                    this.currentTest.versionId = data.VersionId;
                    s3.deleteObject({ Bucket: bucket, Key: key },
                      (err, data) => {
                          _assertNoError(err, 'deleteObject');
                          this.currentTest.deleteVersionId = data.VersionId;
                          done(err);
                      });
                });
            });

            it('should not be able to get a delete marker', function itF(done) {
                s3.getObject({
                    Bucket: bucket,
                    Key: key,
                    VersionId: this.test.deleteVersionId },
                err => {
                    _assertError(err, 405, 'MethodNotAllowed');
                    done();
                });
            });

            it('should be able to get an object using its versionId',
            function itF(done) {
                s3.getObject({
                    Bucket: bucket,
                    Key: key,
                    VersionId: this.test.versionId },
                (err, data) => {
                    _assertNoError(err, 'getObject');
                    assert.strictEqual(data.VersionId, this.test.versionId);
                    done();
                });
            });

            it('should not be able to get an object that has been delete ' +
            'without mentioning versionId',
            done => {
                s3.getObject({
                    Bucket: bucket,
                    Key: key },
                err => {
                    _assertError(err, 404, 'NoSuchKey');
                    done();
                });
            });
        });
    });
});
