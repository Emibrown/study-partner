import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

export interface ObjectStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export function createStorage(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorage | null {
  const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } =
    env;
  if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY)
    return null;
  const endpoint = new URL(R2_ENDPOINT);
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname.endsWith(".r2.cloudflarestorage.com") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Invalid R2 endpoint configuration.");
  const client = new S3Client({
    region: "auto",
    endpoint: endpoint.origin,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return {
    async put(key, bytes) {
      await client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: bytes,
          ContentType: "application/pdf",
          ContentLength: bytes.byteLength,
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
    },
    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      if (!result.Body) throw new Error("Object unavailable.");
      return result.Body.transformToByteArray();
    },
    async delete(key) {
      await client.send(
        new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
    },
  };
}
