# Serverless Photo Auto-Tagger

Click "Add a photo" on the gallery page (or take one with your phone camera)
→ it uploads straight to S3 via a short-lived pre-signed URL → that upload
silently triggers a Lambda function → the function asks **Amazon
Rekognition** what's in the photo → the answer gets written back to S3 as
JSON → a second Lambda re-renders the public gallery page with the new
photo and its tags. No servers, no polling, fully event-driven end to end,
and no standing public write access to anything at any point.

**Live demo:** http://photo-auto-tagger-gallery-081155411312-us-east-1.s3-website-us-east-1.amazonaws.com

```
  Browser                                                     PhotoBucket (private)
  "Add a photo"                                                       │
      │  1. POST {filename, contentType}                              │
      ▼                                                               │
  PresignUploadFunction ──────────────────────────────────────────────┤
      │  2. returns a 5-minute pre-signed PUT URL                     │
      ▼                                                               │
  Browser  ── 3. PUT file bytes directly to S3 ─────────────────────▶ uploads/cat.jpg
                                                                       │
                                                    ObjectCreated event│
                                                                       ▼
                                                       PhotoTaggerFunction ──▶ Rekognition
                                                                       │        DetectLabels
                                                                       ▼
                                                        results/cat.jpg.json
                                                                       │
                                                    ObjectCreated event│ (results/*.json)
                                                                       ▼
                                                        GalleryBuilderFunction
                                                                       │
                                                                       ▼
                                                        public GalleryBucket
                                                        (index.html + manifest.json + photos/)
                                                                       │
                                                                       ▼
                                                        Browser sees it, refresh
```

## Why this project

It's small enough to build and explain in a weekend, but it touches the
three AWS services that come up constantly in interviews, plus the
concepts that actually matter more than the services themselves:

| Concept | Where it shows up here |
|---|---|
| Event-driven architecture | S3 bucket notification triggers Lambda directly — no polling, no queue needed for this scale |
| IAM least privilege | The Lambda's execution role can only `GetObject`/`PutObject` on *this one bucket* and call `rekognition:DetectLabels` — nothing else |
| Infrastructure as Code | The entire stack (bucket, function, role, event trigger) is defined in `template.yaml` and deployed with one command — no manual console clicks, no drift |
| Managed AI service integration | Offloads computer vision to Rekognition instead of shipping a model — a realistic "build vs. buy" call |
| Idempotency / blast radius | The function explicitly skips its own `results/` output so it can never trigger itself in a loop |
| Observability | Every run logs to CloudWatch Logs automatically |

## Project structure

```
photo-auto-tagger/
├── template.yaml           # AWS SAM template — the entire infrastructure definition
├── src/
│   ├── index.mjs           # PhotoTaggerFunction — calls Rekognition, writes results/*.json
│   └── package.json
├── gallery-builder/
│   ├── index.mjs           # GalleryBuilderFunction — rebuilds the public gallery page
│   └── package.json
├── presign-upload/
│   ├── index.mjs           # PresignUploadFunction — hands the browser a pre-signed upload URL
│   └── package.json
└── tests/
    └── s3-test-event.json  # Sample S3 event for local testing
```

## Prerequisites

1. An AWS account ([free tier](https://aws.amazon.com/free/) is enough)
2. [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) installed and configured: `aws configure`
3. [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) installed
4. Node.js 20+ (only needed for local testing, not for deploy)

## Deploy

```bash
cd photo-auto-tagger
sam build
sam deploy --guided
```

`--guided` walks you through naming the CloudFormation stack, picking a
region, and saves your answers to `samconfig.toml` so future deploys are
just `sam deploy`. Note the `BucketName` in the outputs when it finishes.

## Try it

```bash
# Upload a photo — this alone triggers the whole pipeline
aws s3 cp ~/Pictures/some-photo.jpg s3://<BucketName>/uploads/some-photo.jpg

# Wait a few seconds, then check the result
aws s3 cp s3://<BucketName>/results/some-photo.jpg.json -
```

You should see something like:

```json
{
  "sourceImage": "uploads/some-photo.jpg",
  "processedAt": "2026-08-15T18:02:11.000Z",
  "labels": [
    { "name": "Dog", "confidence": 98.7 },
    { "name": "Golden Retriever", "confidence": 94.2 },
    { "name": "Outdoors", "confidence": 91.5 }
  ]
}
```

Then open the `GalleryUrl` from the stack outputs in a browser — your photo
should already be there with its tags underneath it.

Watch it happen live:

```bash
sam logs -n photo-auto-tagger --tail
```

## Test locally without deploying

```bash
cd src && npm install   # only needed if you add real deps later
cd ..
sam local invoke PhotoTaggerFunction --event tests/s3-test-event.json
```

(Local invoke still calls the real Rekognition/S3 APIs using your AWS
credentials — replace the bucket name in the test event with a real bucket
that already has `uploads/sample.jpg` in it.)

## Tear down

Delete everything so you don't get billed:

```bash
aws s3 rm s3://<BucketName> --recursive   # empty the bucket first, CFN won't delete a non-empty bucket
sam delete
```

## Uploading from the browser

The gallery page has an "Add a photo" button (uses `capture="environment"`
so it opens the camera directly on mobile). This does **not** give the
browser standing write access to the bucket — instead:

1. Browser `POST`s `{ filename, contentType }` to `PresignUploadFunction`'s
   public Function URL
2. That Lambda validates the content type, builds a safe key under
   `uploads/`, and returns a **pre-signed S3 PUT URL** valid for 5 minutes
   and scoped to that one key only
3. Browser `PUT`s the file bytes directly to S3 using that URL — the
   Lambda never sees or touches the file itself
4. The rest of the pipeline (tagging, gallery rebuild) fires exactly as it
   would for any other upload

The anti-pattern this avoids: making the bucket itself accept
unauthenticated `PutObject` from anyone, which would let strangers write
to it indefinitely. Pre-signed URLs expire in minutes and are scoped to
one key — no standing public write access ever exists.

## Ideas to extend (good for "what would you improve?")

- Generate an actual thumbnail with a Lambda layer (e.g. Sharp) alongside the labels
- Store results in DynamoDB instead of JSON files, add a query API via API Gateway
- Add a Dead Letter Queue (SQS) for images that fail Rekognition repeatedly
- Add S3 lifecycle rules to expire old uploads automatically
- Put CloudFront in front of GalleryBucket for HTTPS and caching instead of the raw S3 website endpoint
- Add unit tests with a mocked AWS SDK and wire up GitHub Actions for CI/CD

## Resume bullet (steal/edit this)

> Built a serverless image-tagging pipeline on AWS (S3, Lambda, IAM,
> Rekognition) using event-driven architecture and Infrastructure as Code
> (AWS SAM); designed least-privilege IAM roles scoped to specific
> resources and actions.

## Interview talking points

- **"Walk me through the architecture."** S3 event notification → Lambda →
  Rekognition → S3. No compute runs until a file actually lands — you pay
  per invocation, not for idle servers.
- **"How did you handle security?"** The Lambda's IAM role is scoped with
  SAM's `S3ReadPolicy`/`S3WritePolicy` helpers to exactly one bucket, plus
  one explicit Rekognition action — not `s3:*` on `*`. I can show the
  generated policy in the IAM console to prove it.
- **"What happens if it fails?"** Each S3 record is processed in its own
  try/catch so one bad image doesn't fail the whole batch; failures are
  logged to CloudWatch. A real production version would add a DLQ.
- **"How would you scale this?"** Lambda scales concurrently per S3 event
  automatically — no code changes needed up to account concurrency limits.
- **"Why SAM over clicking in the console?"** Reproducibility — the whole
  stack can be destroyed and recreated identically, reviewed in a PR, and
  versioned in git.
- **"Why a second bucket for the gallery instead of just making the first
  one public?"** Blast-radius separation. `PhotoBucket` (the working data)
  stays fully private with `PublicAccessBlockConfiguration` locked down;
  only `GalleryBucket`, which holds copies intended to be public, has its
  block-public-access settings relaxed and a scoped `s3:GetObject` bucket
  policy. A bug in one doesn't expose the other.
- **"How does the gallery stay in sync?"** It's chained off the first
  Lambda's own output — `GalleryBuilderFunction` is triggered by
  `ObjectCreated` events on the `results/*.json` prefix, so it fires
  automatically every time a new photo finishes tagging. No polling, no
  manual rebuild step.
