// Presign Upload
//
// Trigger: a Lambda Function URL, called directly by the browser (public,
// unauthenticated - anyone can ask for an upload URL, same as any public
// "upload a photo" form on the web).
//
// What it does: hands back a short-lived, single-use, pre-signed S3 PUT
// URL scoped to exactly one key under uploads/. The browser then uploads
// the actual file bytes straight to S3 using that URL - this Lambda never
// sees or touches the file itself.
//
// This is the safe pattern for browser uploads: no standing public write
// access ever exists on the bucket. The anti-pattern to avoid is making
// the bucket itself accept unauthenticated PutObject from anyone.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});
const BUCKET = process.env.PHOTO_BUCKET;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const URL_EXPIRY_SECONDS = 300; // 5 minutes - long enough to use, short enough to not matter if logged

// NOTE: no manual CORS headers here. The Function URL's own Cors config
// (see FunctionUrlConfig in template.yaml) already handles CORS for both
// the preflight OPTIONS request and the real response - AWS injects the
// Access-Control-Allow-* headers itself. Adding them again here produced
// duplicate headers (two Access-Control-Allow-Origin values on one
// response), which browsers reject outright as "Failed to fetch." Lambda
// Function URLs with Cors configured don't even invoke this handler for
// OPTIONS requests, so no explicit OPTIONS branch is needed either.

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const contentType = body.contentType;

    if (!ALLOWED_TYPES.has(contentType)) {
      return respond(400, {
        error: "Unsupported file type. Use JPEG, PNG, WEBP, or GIF.",
      });
    }

    // Never trust the client's filename as a path - strip it down to a
    // safe basename and prefix with a timestamp so uploads can't collide
    // or overwrite each other.
    const originalName = (body.filename || "photo")
      .split("/").pop()
      .split("\\").pop();
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    const key = `uploads/${Date.now()}-${safeName}`;

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: URL_EXPIRY_SECONDS }
    );

    return respond(200, { uploadUrl, key });
  } catch (err) {
    console.error("Failed to create pre-signed URL:", err);
    return respond(500, { error: "Could not create an upload URL. Try again." });
  }
};

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
