/**
 * GlideFt.info replies used by the unit tests.
 *
 * HASH_INDEX and JSON_INDEX are hand-written in the object shape Glide
 * documents for GlideFt.info; a real ValkeySearch server returns flat
 * key/value arrays instead (see RECORDED_HASH_INDEX). They exist to test
 * the checks that run on a normalized index.
 */
export const HASH_INDEX = {
	index_name: 'kb',
	index_status: 'AVAILABLE',
	key_type: 'HASH',
	key_prefixes: ['doc:kb:'],
	num_docs: 3,
	fields: [
		{
			identifier: 'content_vector',
			type: 'VECTOR',
			field_name: 'content_vector',
			option: '',
			vector_params: {
				data_type: 'FLOAT32',
				distance_metric: 'COSINE',
				dimension: 1536,
				algorithm: 'HNSW',
			},
		},
		{ identifier: 'metadata_source', type: 'TAG', field_name: 'metadata_source', option: '' },
		{ identifier: 'metadata_year', type: 'NUMERIC', field_name: 'metadata_year', option: '' },
	],
};

export const JSON_INDEX = {
	...HASH_INDEX,
	key_type: 'JSON',
	fields: [
		{
			identifier: '$.vec',
			type: 'VECTOR',
			field_name: 'VEC',
			vector_params: { distance_metric: 'L2', dimension: 6, algorithm: 'FLAT' },
		},
	],
};

/**
 * Recorded from valkey/valkey-bundle:latest (Valkey 9.1.2, search 1.2.1) via
 * GlideFt.info, 2026-10-08. Glide passes the server's flat key/value arrays
 * through for index_definition, each attribute and the vector index block.
 * The metadata identifier was changed from `metadata.year` to
 * `metadata_year`, the hash field the library now writes.
 */
export const RECORDED_HASH_INDEX = {
	index_name: 'probe5',
	index_definition: ['key_type', 'HASH', 'prefixes', ['probe5:'], 'default_score', '1'],
	attributes: [
		[
			'identifier',
			'metadata_year',
			'attribute',
			'metadata_year',
			'user_indexed_memory',
			0,
			'type',
			'NUMERIC',
			'size',
			'0',
		],
		[
			'identifier',
			'v',
			'attribute',
			'v',
			'user_indexed_memory',
			0,
			'type',
			'VECTOR',
			'index',
			[
				'capacity',
				10240,
				'dimensions',
				4,
				'distance_metric',
				'COSINE',
				'size',
				'0',
				'data_type',
				'FLOAT32',
				'algorithm',
				['name', 'HNSW', 'm', 16, 'ef_construction', 200, 'ef_runtime', 10],
			],
		],
	],
	num_docs: 0,
	state: 'ready',
};
