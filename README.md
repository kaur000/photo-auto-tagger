# Serverless Photo Auto-Tagger

Upload a photo to S3 → it silently triggers a Lambda function → the function
asks **Amazon Rekognition** what's in the photo → the answer gets written
back to S3 as JSON. No servers, no polling, fully event-driven.

```
                 ObjectCreated event
   uploads/cat.jpg ──────────────────▶  Lambda  ──────▶ Rekognition
        │                             (Node.js 20)       DetectLabels
        │                                  │
        │                                  ▼
        └────────────────────▶  results/cat.jpg.json
                (same S3 bucket)
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
├── template.yaml         # AWS SAM template — the entire infrastructure definition
├── src/
│   ├── index.mjs          # Lambda handler
│   └── package.json
└── tests/
    └── s3-test-event.json # Sample S3 event for local testing
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

## Ideas to extend (good for "what would you improve?")

- Generate an actual thumbnail with a Lambda layer (e.g. Sharp) alongside the labels
- Store results in DynamoDB instead of JSON files, add a query API via API Gateway
- Add a Dead Letter Queue (SQS) for images that fail Rekognition repeatedly
- Add S3 lifecycle rules to expire old uploads automatically
- Front it with a static S3-hosted gallery page that reads the JSON and renders tags
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
