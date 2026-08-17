// Gallery Builder
//
// Trigger: S3 ObjectCreated event, filtered to results/*.json (i.e. it fires
// right after PhotoTaggerFunction writes a new tagging result).
//
// What it does:
//   1. Reads the new result JSON (source image + labels)
//   2. Copies the photo itself into the public gallery bucket (the source
//      bucket is private, so the image has to be duplicated somewhere
//      public to be viewable in a browser)
//   3. Updates a running manifest.json of every photo + its tags
//   4. Re-renders index.html from that manifest and publishes it
//
// This is a second Lambda chained off the first one's output - a small
// example of event-driven fan-out from a single S3 bucket.

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const GALLERY_BUCKET = process.env.GALLERY_BUCKET;
const MANIFEST_KEY = "manifest.json";

export const handler = async (event) => {
  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    if (!key.startsWith("results/") || !key.endsWith(".json")) {
      continue;
    }

    console.log(`Rebuilding gallery from ${key}`);

    const result = await getJson(bucket, key);
    const photoFilename = result.sourceImage.split("/").pop();

    // Duplicate the photo into the public bucket so browsers can load it.
    await s3.send(
      new CopyObjectCommand({
        Bucket: GALLERY_BUCKET,
        Key: `photos/${photoFilename}`,
        CopySource: `${encodeURIComponent(bucket)}/${encodeURIComponent(result.sourceImage)}`,
      })
    );

    const manifest = await getManifest();
    const entry = {
      photo: photoFilename,
      labels: (result.labels ?? []).map((l) => l.name),
      processedAt: result.processedAt,
    };
    const existingIndex = manifest.findIndex((m) => m.photo === photoFilename);
    if (existingIndex >= 0) {
      manifest[existingIndex] = entry;
    } else {
      manifest.push(entry);
    }
    manifest.sort((a, b) => new Date(b.processedAt) - new Date(a.processedAt));

    await putManifest(manifest);
    await putIndexHtml(manifest);

    console.log(`Gallery now has ${manifest.length} photo(s)`);
  }
};

async function getJson(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await res.Body.transformToString();
  return JSON.parse(text);
}

async function getManifest() {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: GALLERY_BUCKET, Key: MANIFEST_KEY })
    );
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  } catch (err) {
    if (err.name === "NoSuchKey") return [];
    throw err;
  }
}

async function putManifest(manifest) {
  await s3.send(
    new PutObjectCommand({
      Bucket: GALLERY_BUCKET,
      Key: MANIFEST_KEY,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
    })
  );
}

async function putIndexHtml(manifest) {
  const cards = manifest
    .map(
      (item) => `
    <figure>
      <img src="photos/${encodeURIComponent(item.photo)}" alt="${escapeHtml(item.photo)}" loading="lazy" />
      <figcaption>${escapeHtml(item.labels.join(", ") || "No labels detected")}</figcaption>
    </figure>`
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Photo Auto-Tagger Gallery</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 2rem; background: #0b0b0f; color: #eee; }
  h1 { font-weight: 600; margin-bottom: 0.25rem; }
  p.sub { color: #999; margin-top: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.25rem; margin-top: 2rem; }
  figure { margin: 0; background: #16161d; border-radius: 12px; overflow: hidden; border: 1px solid #26262f; }
  figure img { width: 100%; height: 180px; object-fit: cover; display: block; background: #222; }
  figcaption { padding: 0.75rem 1rem; font-size: 0.85rem; color: #b8b8c2; }
  .empty { color: #777; margin-top: 3rem; }
  footer { margin-top: 3rem; color: #666; font-size: 0.8rem; }
</style>
</head>
<body>
  <h1>Photo Auto-Tagger Gallery</h1>
  <p class="sub">Every photo below was tagged automatically by AWS Lambda + Amazon Rekognition the moment it was uploaded to S3.</p>
  <div class="grid">${cards}</div>
  ${manifest.length === 0 ? '<p class="empty">No photos yet - upload one to uploads/ in the S3 bucket.</p>' : ""}
  <footer>S3 → Lambda → Rekognition → S3, fully event-driven.</footer>
</body>
</html>`;

  await s3.send(
    new PutObjectCommand({
      Bucket: GALLERY_BUCKET,
      Key: "index.html",
      Body: html,
      ContentType: "text/html",
    })
  );
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
