import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: config.r2.endpoint,
  credentials: {
    accessKeyId:     config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
  requestChecksumCalculation:  'WHEN_REQUIRED',
  responseChecksumValidation:  'WHEN_REQUIRED',
});

// Returns a signed URL the frontend can PUT a file to directly (expires in 1 hour)
export async function getSignedUploadUrl(key, contentType) {
  const command = new PutObjectCommand({
    Bucket:      config.r2.bucket,
    Key:         key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, command, { expiresIn: 3600 });
}

// Uploads a Buffer directly from the server (no signed URL round-trip)
export async function putObject(key, buffer, contentType) {
  const command = new PutObjectCommand({
    Bucket:       config.r2.bucket,
    Key:          key,
    Body:         buffer,
    ContentType:  contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  });
  await r2.send(command);
  return `${config.r2.publicUrl}/${key}`;
}

// Returns a signed URL to read a file (expires in 1 hour)
export async function getSignedReadUrl(key) {
  const command = new GetObjectCommand({
    Bucket: config.r2.bucket,
    Key:    key,
  });
  return getSignedUrl(r2, command, { expiresIn: 3600 });
}
