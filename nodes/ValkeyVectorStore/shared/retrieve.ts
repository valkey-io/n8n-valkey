import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { GlideClient } from '@valkey/valkey-glide';

import type { StoreConfig } from './config';
import { toCompatibilityConfig, toLibraryConfig } from './config';
import { ValkeyUserError } from './errors';
import { buildMetadataFilter, toCustomSchema } from './filters';
import type { FilterConditionRow } from './filters';
import { assertCompatible, metadataFields, readIndexInfo } from './indexSchema';
import type { IndexInfo } from './indexSchema';
import { N8nValkeyVectorStore } from './filteredStore';

export function missingIndexError(indexName: string): ValkeyUserError {
	return new ValkeyUserError(
		`Index "${indexName}" does not exist. Check the index name, or insert documents first.`,
		'index-not-found',
	);
}

/**
 * Builds the store for Get Many, Retrieve as Vector Store and Retrieve as
 * Tool. Fails if the index is missing or incompatible, or the filter is
 * invalid. Never creates an index.
 *
 * Takes ownership of the client: it is closed here on failure, or by
 * store.closeClient() otherwise.
 */
export async function buildRetrieveStore(
	client: GlideClient,
	config: StoreConfig & { ttl?: number; updateMode?: boolean },
	embeddings: EmbeddingsInterface,
	rows: FilterConditionRow[],
	readInfo: (client: GlideClient, indexName: string) => Promise<IndexInfo | null> = readIndexInfo,
): Promise<N8nValkeyVectorStore> {
	try {
		const info = await readInfo(client, config.indexName);
		if (!info) throw missingIndexError(config.indexName);

		assertCompatible(info, toCompatibilityConfig(config), 'retrieve');
		const vector = info.vectors.find((v) => v.name === config.vectorKey);
		const fields = metadataFields(info, config.metadataKey);
		const metadataFilter = buildMetadataFilter(rows, fields, config.indexName);

		return new N8nValkeyVectorStore(
			embeddings,
			{
				...toLibraryConfig(config),
				customSchema: fields.length ? toCustomSchema(fields) : undefined,
				// Only Update mode passes a TTL; the read modes never write.
				ttl: config.ttl,
			},
			{
				client,
				metadataFilter,
				indexDimension: vector ? vector.dim : NaN,
				metadataFields: fields,
				updateMode: config.updateMode,
				idField: config.idField,
			},
		);
	} catch (error) {
		client.close();
		throw error;
	}
}
