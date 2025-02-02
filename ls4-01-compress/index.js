'use strict';
//
const child_process = require('child_process');
const aws = require('aws-sdk');
const s3 = new aws.S3();
const lambda = new aws.Lambda({
  region: 'us-east-1' //change to your region
});
const exec = require('child_process').execSync;
const fs = require('fs');

function systemSync(cmd) {
    return exec(cmd).toString();
};

exports.handler = (event, context, callback) => {
      // If not invoked directly then treat as coming from S3
      if (!event.sourceBucket) {
        if (event.Records[0].s3.bucket.name) {
          console.log(event.Records[0].s3);
          var sourceBucket = event.Records[0].s3.bucket.name;
          var sourceKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
        }
        else {
          console.error ('no source bucket defined');
        }
      }
      else {
        var sourceBucket = event.sourceBucket;
        var sourceKey =  event.sourceKey;
      }

      // update ACL for uploaded /scanned tif
      // /scanned tif only exists for frames and indexes - NOT mosaics
      // this section needs to be commented if using ls4-00-reproject in the workflow
      // if (sourceKey.includes('/frames/scanned/') || sourceKey.includes('/index/scanned/')) {
      //   console.log(sourceKey);
      //   var scannedParams = {
      //     Bucket: sourceBucket,
      //     Key: sourceKey,
      //     ACL: 'public-read'
      //   };
      //   s3.putObjectAcl(scannedParams, function(err, data) {
      //     if (err) console.log(err, err.stack); // an error occurred
      //     else     console.log('scanned tif ACL update success!'); // successful response
      //   });
      // }

      // escape if s3 event triggered by scanned upload or cog output
      if (!sourceKey.includes('/georef/')) {
        console.log("error: key doesn't include '/georef/'. exiting...");
        console.log(sourceKey);
        return
      }
      // this section needs to be uncommented if using ls4-00-reproject in the workflow
      else if (!sourceKey.includes(process.env.epsgSubDir)) {
        console.log("error: key doesn't include the 'epsgSubDir' env variable. exiting...");
        console.log(sourceKey);
        return
      }
      // this section needs to be commented if using ls4-00-reproject in the workflow
      // else if (sourceKey.includes(process.env.georefSubDir)) {
      //   console.log("error: key includes the 'georefSubDir' env variable. exiting...");
      //   console.log(sourceKey);
      //   return
      // }
      else {
        console.log('Source Bucket: ' + sourceBucket);
        console.log('Source Key: ' + sourceKey);

        console.log('GDAL Args: ' + process.env.gdalArgs);
        console.log('ncBands: ' + process.env.ncBands);
        console.log('bwBands: ' + process.env.bwBands);

        console.log('Upload Bucket: ' + process.env.uploadBucket);
        console.log('Upload Key ACL: ' + process.env.uploadKeyAcl);
        console.log('Upload Georef Sub Directory: ' + process.env.georefSubDir);

        console.log('EPSG Georef Sub Directory: ' + process.env.epsgSubDir);

        // adjust gdal command for number of bands in raster. if not bw or nc, just escape
        var bandCmd;
        if (sourceKey.includes('bw/')) {
          bandCmd = process.env.bwBands + " ";
        }
        else if (sourceKey.includes('nc/')) {
          bandCmd = process.env.ncBands + " ";
        }
        else {
          console.log("error: key doesn't include 'bw/' or 'nc/'. exiting...");
          return
        }

        const cmd = 'AWS_REQUEST_PAYER=requester'
            + ' GDAL_DISABLE_READDIR_ON_OPEN=YES CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif ./bin/gdal_translate '
            + bandCmd + process.env.gdalArgs
            + ' /vsis3/' + sourceBucket + '/' + sourceKey + ' /tmp/output.tif';
        console.log('Command to run: ' + cmd);

        // clear contents of tmp dir in case of reuse
        console.log(systemSync('rm -fv /tmp/*'));
        // run command here should have some error checking
        console.log(systemSync(cmd));
        console.log(systemSync('ls -alh /tmp'));

        // default upload key is same as the source key with added georef sub Directory
        var srcKeyParts = sourceKey.split("/");
        var filename = srcKeyParts[srcKeyParts.length-1];
        var fileWithSubDir = process.env.georefSubDir + filename;
        // this line needs to be commented if using ls4-00-reproject in the workflow
        // var uploadKey = sourceKey.replace(filename, fileWithSubDir).replace('TIF', 'tif');
        // this section needs to be uncommented if using ls4-00-reproject in the workflow
        var fileWithEpsg = process.env.epsgSubDir + filename;
        var uploadKey = sourceKey.replace(fileWithEpsg, fileWithSubDir);
        console.log('uploadKey: ' + uploadKey);

        var body = fs.createReadStream('/tmp/output.tif');

        // when writing to your own bucket 'authenticated-read'
        var s3obj = new aws.S3({params: {Bucket: process.env.uploadBucket,
            Key: uploadKey,
            ACL: process.env.uploadKeyAcl,
            ContentType: 'image/tiff'
        }});

        // upload output of the gdal util to S3
        s3obj.upload({Body: body})
            .on('httpUploadProgress', function(evt) {
                //console.log(evt);
                })
            .send(function(err, data) {
              console.log(data);
              const payload = {sourceBucket: process.env.uploadBucket,sourceKey: uploadKey}
              lambda.invoke({
                ClientContext: "ls4-01",
                FunctionName: "ls4-02-overviews",
                InvocationType: "Event",
                Payload: JSON.stringify(payload) // pass params
              }, function(error, data) {
                if (error) {
                  context.done('error', error);
                }
                if(data.Payload){
                  console.log("ls4-02-overviews invoked!")
                  context.succeed(data.Payload)
                }
              });
              callback(err, 'Process complete!');
            }
        )
      }
};
