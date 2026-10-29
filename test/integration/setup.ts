import { randomUUID } from 'node:crypto';

import { GlideClient } from '@valkey/valkey-glide';

import { createValkeyClient } from '../../nodes/ValkeyVectorStore/shared/client';
import type { ValkeyCredentials } from '../../nodes/ValkeyVectorStore/shared/config';
import { clearIndex } from '../../nodes/ValkeyVectorStore/shared/clearIndex';

/**
 * Integration tests run only when VALKEY_HOST is set. The server may be shared,
 * so every run uses its own index names and key prefix and only cleans up
 * under that prefix.
 */
export const integrationEnabled = Boolean(process.env.VALKEY_HOST);

export const describeIntegration = integrationEnabled ? describe : describe.skip;

export function testCredentials(): ValkeyCredentials {
	return {
		host: process.env.VALKEY_HOST ?? 'localhost',
		port: Number(process.env.VALKEY_PORT ?? 6379),
		username: process.env.VALKEY_USERNAME || undefined,
		password: process.env.VALKEY_PASSWORD || undefined,
		tls: process.env.VALKEY_TLS === 'true' || process.env.VALKEY_TLS === '1',
		database: Number(process.env.VALKEY_DATABASE ?? 0),
	};
}

export const RUN_ID = randomUUID().slice(0, 8);

/** Root of every key this run writes. */
export const RUN_PREFIX = `n8n-test:${RUN_ID}:`;

let counter = 0;

/** A fresh index name and key prefix under this run's prefix. */
export function uniqueIndex(label: string): { indexName: string; keyPrefix: string } {
	counter += 1;
	const indexName = `n8n-test-${RUN_ID}-${label}-${counter}`;
	return { indexName, keyPrefix: `${RUN_PREFIX}${label}-${counter}:` };
}

const createdIndexes = new Set<string>();

export function trackIndex(indexName: string): void {
	createdIndexes.add(indexName);
}

export async function connect(): Promise<GlideClient> {
	return await createValkeyClient(testCredentials());
}

/** Drops this run's indexes and deletes keys under this run's prefix only. */
export async function cleanupRun(): Promise<void> {
	if (!integrationEnabled) return;
	const client = await connect();
	try {
		// clearIndex drops the index and deletes keys under the given prefix;
		// every key this run wrote is under RUN_PREFIX.
		for (const indexName of createdIndexes) {
			await clearIndex(client, indexName, [RUN_PREFIX]);
		}
		await clearIndex(client, `n8n-test-${RUN_ID}-__cleanup__`, [RUN_PREFIX]);
	} finally {
		client.close();
	}
}

/** Deterministic embeddings: each text maps to a fixed vector of `dimension` floats. */
export class FakeEmbeddings {
	constructor(
		readonly dimension = 8,
		private readonly vectors: Record<string, number[]> = {},
	) {}

	private vectorFor(text: string): number[] {
		if (this.vectors[text]) return this.vectors[text];
		const vector = new Array<number>(this.dimension).fill(0);
		for (let i = 0; i < text.length; i++) vector[i % this.dimension] += text.charCodeAt(i) / 1000;
		vector[0] += 1;
		return vector;
	}

	async embedDocuments(texts: string[]): Promise<number[][]> {
		return texts.map((t) => this.vectorFor(t));
	}

	async embedQuery(text: string): Promise<number[]> {
		return this.vectorFor(text);
	}
}
