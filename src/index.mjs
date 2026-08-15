// Serverless Photo Auto-Tagger
//
// Trigger: S3 ObjectCreated event (fires when a file lands under uploads/)
// What it does:
//   1. Reads the bucket/key of the new photo out of the S3 event
//   2. Asks Amazon Rekognition "what's in this image?"
//   3. Writes the answer back to S3 as results/<same-name>.json
//
// AWS SDK v3 is preinstalled in the Node.js Lambda runtime, so this needs
// zero npm dependencies to deploy.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { RekognitionClient, DetectLabelsCommand } from "@aws-sdk/client-rekognition";

const s3 = new S3Client({});
const rekognition = new RekognitionClient({});

export const handler = async (event) => {
  const results = [];

  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    // S3 keys in events are URL-encoded (e.g. spaces become "+")
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    console.log(`Processing s3://${bucket}/${key}`);

    // Guard against re-triggering ourselves if the results/ prefix filter
    // ever changes - never process our own output.
    if (key.startsWith("results/")) {
      console.log("Skipping - this is our own output file.");
      continue;
    }

    try {
      const labels = await detectLabels(bucket, key);
      const outputKey = toResultsKey(key);

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: outputKey,
          Body: JSON.stringify(
            {
              sourceImage: key,
              processedAt: new Date().toISOString(),
              labels: labels.map((l) => ({
                name: l.Name,
                confidence: Math.round(l.Confidence * 10) / 10,
              })),
            },
            null,
            2
          ),
          ContentType: "application/json",
        })
      );

      console.log(`Wrote ${labels.length} labels to s3://${bucket}/${outputKey}`);
      results.push({ key, outputKey, labelCount: labels.length });
    } catch (err) {
      // Log and continue so one bad image doesn't fail the whole batch.
      console.error(`Failed to process ${key}:`, err);
      results.push({ key, error: err.message });
    }
  }

  return { processed: results };
};

async function detectLabels(bucket, key) {
  const response = await rekognition.send(
    new DetectLabelsCommand({
      Image: { S3Object: { Bucket: bucket, Name: key } },
      MaxLabels: 10,
      MinConfidence: 75,
    })
  );
  return response.Labels ?? [];
}

function toResultsKey(uploadKey) {
  // uploads/beach.jpg -> results/beach.jpg.json
  const filename = uploadKey.split("/").pop();
  return `results/${filename}.json`;
}
