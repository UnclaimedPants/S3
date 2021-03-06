import async from 'async';

import { errors, versioning } from 'arsenal';

import collectCorsHeaders from '../utilities/collectCorsHeaders';
import services from '../services';
import { pushMetric } from '../utapi/utilities';
import createAndStoreObject from './apiUtils/object/createAndStoreObject';
import { decodeVersionId,
    preprocessingVersioningDelete } from './apiUtils/object/versioning';
import { metadataValidateBucketAndObj } from
'../metadata/metadataUtils';

const versionIdUtils = versioning.VersionID;
const skipError = new Error('skip');

/**
 * objectDelete - DELETE an object from a bucket
 * @param {AuthInfo} authInfo - requester's infos
 * @param {object} request - request object given by router,
 *                           includes normalized headers
 * @param {Logger} log - werelogs request instance
 * @param {function} cb - final cb to call with the result and response headers
 * @return {undefined}
 */
export default function objectDelete(authInfo, request, log, cb) {
    log.debug('processing request', { method: 'objectDelete' });
    if (authInfo.isRequesterPublicUser()) {
        log.debug('operation not available for public user');
        return cb(errors.AccessDenied);
    }
    const bucketName = request.bucketName;
    const objectKey = request.objectKey;

    const decodedVidResult = decodeVersionId(request.query);
    if (decodedVidResult instanceof Error) {
        log.trace('invalid versionId query', {
            versionId: request.query.versionId,
            error: decodedVidResult,
        });
        return cb(decodedVidResult);
    }
    const reqVersionId = decodedVidResult;

    const valParams = {
        authInfo,
        bucketName,
        objectKey,
        versionId: reqVersionId,
        requestType: 'objectDelete',
    };

    const canonicalID = authInfo.getCanonicalID();
    return async.waterfall([
        function validateBucketAndObj(next) {
            return metadataValidateBucketAndObj(valParams, log,
            (err, bucketMD, objMD) => {
                if (err) {
                    return next(err, bucketMD);
                }
                const versioningCfg = bucketMD.getVersioningConfiguration();
                if (!objMD) {
                    if (!versioningCfg) {
                        return next(errors.NoSuchKey, bucketMD);
                    }
                    // AWS does not return an error when trying to delete a
                    // specific version that does not exist. We skip to the end
                    // of the waterfall here.
                    // TODO: Look into AWS behavior for whether to create
                    // a delete marker if request is trying to delete a version
                    // that does not exist.
                    if (reqVersionId) {
                        log.debug('trying to delete specific version ' +
                        ' that does not exist');
                        return next(skipError, bucketMD);
                    }
                    // To adhere to AWS behavior, create a delete marker even
                    // if trying to delete an object that does not exist when
                    // versioning has been configured
                    return next(null, bucketMD, objMD);
                }
                if (objMD['content-length'] !== undefined) {
                    log.end().addDefaultFields({
                        bytesDeleted: objMD['content-length'],
                    });
                }
                return next(null, bucketMD, objMD);
            });
        },
        function getVersioningInfo(bucketMD, objectMD, next) {
            return preprocessingVersioningDelete(bucketName,
                bucketMD, objectMD, reqVersionId, log,
                (err, options) => {
                    if (err) {
                        log.error('err processing versioning info',
                        { error: err });
                        return next(err, bucketMD);
                    }
                    return next(null, bucketMD, objectMD, options);
                });
        },
        function deleteOperation(bucketMD, objectMD, delOptions, next) {
            const deleteInfo = {
                removeDeleteMarker: false,
                newDeleteMarker: false,
            };
            if (delOptions && delOptions.deleteData) {
                if (objectMD.isDeleteMarker) {
                    // record that we deleted a delete marker to set
                    // response headers accordingly
                    deleteInfo.removeDeleteMarker = true;
                }
                return services.deleteObject(bucketName, objectMD, objectKey,
                    delOptions, log, (err, delResult) => next(err, bucketMD,
                    objectMD, delResult, deleteInfo));
            }
            // putting a new delete marker
            deleteInfo.newDeleteMarker = true;
            return createAndStoreObject(bucketName, bucketMD,
                objectKey, objectMD, authInfo, canonicalID, null, request,
                deleteInfo.newDeleteMarker, null, log, (err, newDelMarkerRes) =>
                next(err, bucketMD, objectMD, newDelMarkerRes, deleteInfo));
        },
    ], (err, bucketMD, objectMD, result, deleteInfo) => {
        const resHeaders = collectCorsHeaders(request.headers.origin,
            request.method, bucketMD);
        if (err) {
            if (err === skipError) {
                return cb(null, resHeaders);
            }
            log.debug('error processing request', { error: err,
                method: 'objectDelete' });
            return cb(err, resHeaders);
        }
        if (deleteInfo.newDeleteMarker) {
            // if we created a new delete marker, return true for
            // x-amz-delete-marker and the version ID of the new delete marker
            if (result.versionId) {
                resHeaders['x-amz-delete-marker'] = true;
                resHeaders['x-amz-version-id'] = result.versionId === 'null' ?
                    result.versionId : versionIdUtils.encode(result.versionId);
            }
            // TODO metric should be 'deleteObject', not 'putObject',
            // but number of objects should be incremented since putting a new
            // version. Utapi will be updated to allow this
            pushMetric('putObject', log, { authInfo, bucket: bucketName,
                newByteLength: 0, oldByteLength: 0 });
        } else {
            // otherwise, if deleting a specific version or delete marker,
            // return the version id in the response headers
            if (reqVersionId) {
                resHeaders['x-amz-version-id'] = reqVersionId === 'null' ?
                    reqVersionId : versionIdUtils.encode(reqVersionId);
                if (deleteInfo.removeDeleteMarker) {
                    resHeaders['x-amz-delete-marker'] = true;
                }
            }
            pushMetric('deleteObject', log, { authInfo, bucket: bucketName,
                byteLength: objectMD['content-length'], numberOfObjects: 1 });
        }
        return cb(err, resHeaders);
    });
}
