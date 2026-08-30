import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { ServerEnv } from "../../config/env";

/**
 * Object storage.
 *
 * PLAN.md §4.1 requires the S3 *API*, not a particular provider, so this speaks plain S3 at
 * whatever endpoint it is given — Garage in development, whatever the host offers in
 * deployment. `@aws-sdk/client-s3` is the generic client for that protocol; nothing here
 * may reach for a provider-specific SDK.
 *
 * The bucket is private (§4.6 #3). Unpublished blobs are in storage from the moment of
 * upload, so files reach browsers only through short-lived presigned URLs the backend
 * issues after a permission check — never through a public policy or a guessable key.
 */

export type StorageHandle = {
	client: S3Client;
	bucket: string;
	/**
	 * Confirms the endpoint answers and the bucket exists and is reachable with these
	 * credentials. Resolves on success, rejects otherwise.
	 */
	probe: () => Promise<void>;
	close: () => void;
};

export function createStorage(env: ServerEnv): StorageHandle {
	const { storage } = env;

	const client = new S3Client({
		endpoint: storage.endpoint,
		region: storage.region,
		forcePathStyle: storage.forcePathStyle,
		credentials: {
			accessKeyId: storage.accessKeyId,
			secretAccessKey: storage.secretAccessKey,
		},
	});

	return {
		client,
		bucket: storage.bucket,

		probe: async () => {
			await client.send(new HeadBucketCommand({ Bucket: storage.bucket }));
		},

		close: () => client.destroy(),
	};
}
