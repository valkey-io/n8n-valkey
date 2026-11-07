import { Document } from '@langchain/core/documents';
import { N8nJsonLoader } from '@n8n/ai-utilities';
import { VectorAlgorithms } from '@langchain/valkey';
import { ClusterScanCursor, GlideClusterClient, GlideFt } from '@valkey/valkey-glide';
import type { GlideClient } from '@valkey/valkey-glide';

import { ValkeyVectorStore } from '../../nodes/ValkeyVectorStore/ValkeyVectorStore.node';
import type { ValkeyClient } from '../../nodes/ValkeyVectorStore/shared/client';
import { clearIndex } from '../../nodes/ValkeyVectorStore/shared/clearIndex';
import type { InsertConfig, ValkeyCredentials } from '../../nodes/ValkeyVectorStore/shared/config';
import { metadataFields, readIndexInfo } from '../../nodes/ValkeyVectorStore/shared/indexSchema';
import {
	defaultInsertDeps,
	insertBatch,
	newInsertState,
} from '../../nodes/ValkeyVectorStore/shared/insert';
import { buildRetrieveStore } from '../../nodes/ValkeyVectorStore/shared/retrieve';
import type { FilterConditionRow } from '../../nodes/ValkeyVectorStore/shared/filters';
import {
	FakeEmbeddings,
	cleanupRun,
	connect,
	describeIntegration,
	testCredentials,
	trackIndex,
	uniqueIndex,
} from './setup';

jest.setTimeout(30000);

function insertConfig(label: string, overrides: Partial<InsertConfig> = {}): InsertConfig {
	const { indexName, keyPrefix } = uniqueIndex(label);
	trackIndex(indexName);
	return {
		indexName,
		keyPrefix,
		contentKey: 'content',
		metadataKey: 'metadata',
		vectorKey: 'content_vector',
		metric: 'COSINE',
		algorithm: VectorAlgorithms.HNSW,
		clearIndex: false,
		declaredFields: [],
		...overrides,
	};
}

const embeddings = new FakeEmbeddings(8);

async function insert(config: InsertConfig, documents: Document[], batchSize = 200) {
	const state = newInsertState();
	for (let i = 0; i < documents.length; i += batchSize) {
		await insertBatch(
			config,
			embeddings,
			documents.slice(i, i + batchSize),
			state,
			defaultInsertDeps(connect),
		);
	}
	return state;
}

async function search(
	config: InsertConfig,
	query: string,
	k: number,
	rows: FilterConditionRow[] = [],
) {
	const store = await buildRetrieveStore(await connect(), config, embeddings, rows);
	try {
		return await store.similaritySearchVectorWithScore(await embeddings.embedQuery(query), k);
	} finally {
		store.closeClient();
	}
}

/** Returns every key matching `${prefix}*`, scanning across all primaries in cluster mode. */
async function scanKeys(client: ValkeyClient, prefix: string): Promise<string[]> {
	const match = `${prefix}*`;
	const found: string[] = [];
	// Cluster and standalone scans use different cursors: the cluster client
	// takes a ClusterScanCursor object, the standalone client a string cursor.
	const isCluster = client instanceof GlideClusterClient;
	let cursor: ClusterScanCursor | string = isCluster ? new ClusterScanCursor() : '0';
	const done = () => (isCluster ? (cursor as ClusterScanCursor).isFinished() : cursor === '0');

	do {
		const [next, keys] = isCluster
			? await (client as GlideClusterClient).scan(cursor as ClusterScanCursor, {
					match,
					count: 1000,
				})
			: await (client as GlideClient).scan(cursor as string, { match, count: 1000 });
		cursor = isCluster ? (next as ClusterScanCursor) : String(next);
		found.push(...(keys as string[]).map(String));
	} while (!done());
	return found;
}

async function countKeys(client: ValkeyClient, prefix: string): Promise<number> {
	return (await scanKeys(client, prefix)).length;
}

const corpus = [
	new Document({
		pageContent: 'Refunds are processed within 5 days',
		metadata: { source: 'billing.pdf', year: 2025, tenant: 'acme' },
	}),
	new Document({
		pageContent: 'Reset your password from settings',
		metadata: { source: 'account.pdf', year: 2024, tenant: 'acme' },
	}),
	new Document({
		pageContent: 'Annual plans are prorated',
		metadata: { source: 'billing.pdf', year: 2023, tenant: 'globex' },
	}),
	new Document({
		pageContent: 'Contact support by email',
		metadata: { source: 'faq.pdf', year: 2022, tenant: 'globex' },
	}),
	new Document({
		pageContent: 'Special chars',
		metadata: { source: 'a-b.c@d e', year: 2021, tenant: 'acme' },
	}),
];

const declared: InsertConfig['declaredFields'] = [
	{ name: 'source', type: 'TAG' },
	{ name: 'tenant', type: 'TAG' },
	{ name: 'year', type: 'NUMERIC' },
];

describeIntegration('Valkey integration', () => {
	// The client is standalone or cluster depending on VALKEY_CLUSTER; countKeys
	// handles both cursor protocols.
	let client: ValkeyClient;

	beforeAll(async () => {
		client = await connect();
	});

	afterAll(async () => {
		client?.close();
		await cleanupRun();
	});

	it('connects to a standalone server with search', async () => {
		expect(await client.ping()).toBe('PONG');
		await expect(readIndexInfo(client, 'n8n-test-does-not-exist')).resolves.toBeNull();
	});

	describe('credential test', () => {
		const connectionTest = new ValkeyVectorStore().methods!.credentialTest!.valkeyApiConnectionTest;
		const credential = (overrides: Partial<ValkeyCredentials> = {}) =>
			({
				id: '1',
				name: 'Valkey',
				type: 'valkeyApi',
				data: { ...testCredentials(), ...overrides },
			}) as never;

		it('reports success for the test server', async () => {
			await expect(connectionTest.call({} as never, credential())).resolves.toEqual({
				status: 'OK',
				message: 'Connection successful',
			});
		});

		const itWithPassword = process.env.VALKEY_PASSWORD ? it : it.skip;

		itWithPassword('reports a wrong password with the server error', async () => {
			const result = await connectionTest.call(
				{} as never,
				credential({ password: 'wrong-password' }),
			);
			expect(result.status).toBe('Error');
			expect(result.message).toMatch(/WRONGPASS/);
		});
	});

	it('inserts without TEXT fields and round-trips content and metadata', async () => {
		const config = insertConfig('basic');
		await insert(config, [
			new Document({ pageContent: 'Valkey is fast', metadata: { source: 'faq.pdf', page: 4 } }),
		]);
		const info = await readIndexInfo(client, config.indexName);
		expect(info?.fields.map((f) => f.type)).toEqual(['VECTOR']);
		const [[doc]] = await search(config, 'Valkey is fast', 1);
		expect(doc.pageContent).toBe('Valkey is fast');
		expect(doc.metadata).toEqual({ source: 'faq.pdf', page: 4 });
	});

	it('search returns documents ordered by similarity with scores', async () => {
		const config = insertConfig('order');
		await insert(config, corpus);
		const results = await search(config, corpus[0].pageContent, 4);
		expect(results).toHaveLength(4);
		expect(results[0][0].pageContent).toBe(corpus[0].pageContent);
		const scores = results.map(([, s]) => s);
		expect([...scores].sort((a, b) => a - b)).toEqual(scores);
	});

	it('fails retrieve on a missing index without creating it', async () => {
		const config = insertConfig('missing');
		await expect(search(config, 'x', 1)).rejects.toThrow('does not exist');
		await expect(readIndexInfo(client, config.indexName)).resolves.toBeNull();
	});

	it('indexes declared fields and filters on NUMERIC ranges and TAG values', async () => {
		const config = insertConfig('filters', { declaredFields: declared });
		await insert(config, corpus);
		const info = await readIndexInfo(client, config.indexName);
		expect(metadataFields(info!, 'metadata')).toEqual(expect.arrayContaining(declared));

		const contents = async (rows: FilterConditionRow[]) =>
			(await search(config, 'refund', 10, rows)).map(([d]) => d.pageContent).sort();

		expect(await contents([{ field: 'year', operator: 'gte', value: '2024' }])).toEqual([
			'Refunds are processed within 5 days',
			'Reset your password from settings',
		]);
		expect(await contents([{ field: 'year', operator: 'lte', value: '2022' }])).toEqual([
			'Contact support by email',
			'Special chars',
		]);
		expect(
			await contents([{ field: 'year', operator: 'between', value: '2022', valueTo: '2023' }]),
		).toEqual(['Annual plans are prorated', 'Contact support by email']);
		expect(await contents([{ field: 'year', operator: 'equals', value: '2024' }])).toEqual([
			'Reset your password from settings',
		]);
		expect(
			await contents([
				{ field: 'source', operator: 'is', value: 'billing.pdf' },
				{ field: 'year', operator: 'between', value: '2023', valueTo: '2025' },
			]),
		).toEqual(['Annual plans are prorated', 'Refunds are processed within 5 days']);
		expect(await contents([{ field: 'source', operator: 'is', value: 'a-b.c@d e' }])).toEqual([
			'Special chars',
		]);
		expect(await contents([])).toHaveLength(corpus.length);
	});

	it('filters on "Is Any Of" TAG values', async () => {
		const config = insertConfig('filters-any-of', { declaredFields: declared });
		await insert(config, corpus);
		const anyOf = await search(config, 'refund', 10, [
			{ field: 'source', operator: 'isAnyOf', value: 'billing.pdf, faq.pdf' },
		]);
		expect(anyOf.length).toBe(3);
		anyOf.forEach(([d]) => expect(['billing.pdf', 'faq.pdf']).toContain(d.metadata.source));
	});

	it('rejects an "Is" value that contains the TAG separator, for a value another tool stored', async () => {
		const config = insertConfig('separator-value', {
			declaredFields: [{ name: 'source', type: 'TAG' }],
			idField: 'doc_id',
		});
		await insert(config, [
			new Document({ pageContent: 'doc', metadata: { doc_id: '1', source: 'a' } }),
		]);
		// The node refuses "a,b" on insert, so write it the way another tool would.
		// Valkey indexes it as the two tags "a" and "b".
		await client.hset(`${config.keyPrefix}1`, { metadata_source: 'a,b' });

		expect(
			await search(config, 'doc', 5, [{ field: 'source', operator: 'is', value: 'b' }]),
		).toHaveLength(1);
		expect(
			await search(config, 'doc', 5, [{ field: 'source', operator: 'isAnyOf', value: 'a, b' }]),
		).toHaveLength(1);
		await expect(
			search(config, 'doc', 5, [{ field: 'source', operator: 'is', value: 'a,b' }]),
		).rejects.toThrow('contains ",", which separates tags in this field');
	});

	it('isolates tenants: the configured filter limits results to one tenant', async () => {
		const config = insertConfig('tenant', { declaredFields: declared });
		await insert(config, corpus);
		const results = await search(config, 'show all customer invoices', 10, [
			{ field: 'tenant', operator: 'is', value: 'acme' },
		]);
		expect(results.length).toBe(3);
		results.forEach(([d]) => expect(d.metadata.tenant).toBe('acme'));
	});

	it('inserts without declarations still write the existing index fields', async () => {
		const created = insertConfig('undeclared', { declaredFields: declared, idField: 'doc_key' });
		const doc = (id: string, text: string, tenant: string) =>
			new Document({
				pageContent: text,
				metadata: { doc_key: id, tenant, source: 'x.pdf', year: 2024 },
			});
		await insert(created, [doc('1', 'first', 'acme')]);

		// Another Insert node on the same index, with Metadata Fields to Index left empty.
		const appending = { ...created, declaredFields: [] };
		await insert(appending, [doc('2', 'second', 'acme'), doc('1', 'first, replaced', 'acme')]);

		// Both documents written by the second Insert carry every indexed field of the index.
		for (const id of ['1', '2']) {
			const key = `${created.keyPrefix}${id}`;
			expect(String(await client.hget(key, 'metadata_source'))).toBe('x.pdf');
			expect(String(await client.hget(key, 'metadata_tenant'))).toBe('acme');
			expect(String(await client.hget(key, 'metadata_year'))).toBe('2024');
		}

		const acme = await search(created, 'first', 10, [
			{ field: 'tenant', operator: 'is', value: 'acme' },
		]);
		expect(acme.map(([d]) => d.pageContent).sort()).toEqual(['first, replaced', 'second']);
	});

	it('writes TAG arrays with the separator of an index created elsewhere, and keeps CASESENSITIVE fields', async () => {
		const config = insertConfig('separator');
		// Created as another tool would, with a non-default separator and a case-sensitive tag.
		await client.customCommand([
			'FT.CREATE',
			config.indexName,
			'ON',
			'HASH',
			'PREFIX',
			'1',
			config.keyPrefix,
			'SCHEMA',
			'content_vector',
			'VECTOR',
			'FLAT',
			'6',
			'TYPE',
			'FLOAT32',
			'DIM',
			String(embeddings.dimension),
			'DISTANCE_METRIC',
			'COSINE',
			'metadata_tenant',
			'TAG',
			'SEPARATOR',
			'|',
			'CASESENSITIVE',
		]);
		const info = await readIndexInfo(client, config.indexName);
		expect(metadataFields(info!, 'metadata')).toEqual([
			{ name: 'tenant', type: 'TAG', separator: '|', caseSensitive: true },
		]);

		await insert(config, [
			new Document({ pageContent: 'shared', metadata: { tenant: ['acme', 'globex'] } }),
			new Document({ pageContent: 'acme only', metadata: { tenant: 'acme' } }),
		]);

		const names = async (value: string) =>
			(await search(config, 'x', 10, [{ field: 'tenant', operator: 'is', value }]))
				.map(([d]) => d.pageContent)
				.sort();
		expect(await names('acme')).toEqual(['acme only', 'shared']);
		expect(await names('globex')).toEqual(['shared']);
		expect(await names('ACME')).toEqual([]);
	});

	describe('an index created elsewhere whose fields have their own attribute names', () => {
		/** FT.CREATE for a HASH index under the config's prefix, with the given schema. */
		async function createIndex(config: InsertConfig, schema: string[]): Promise<void> {
			await client.customCommand([
				'FT.CREATE',
				config.indexName,
				'ON',
				'HASH',
				'PREFIX',
				'1',
				config.keyPrefix,
				'SCHEMA',
				...schema,
			]);
			// On a valkey-search 1.0.3 coordinator cluster, FT.CREATE returns before
			// every primary has the index, so a document written in that window stays
			// unsearchable. The node's own index creation waits for this via the
			// library's addVectors; a raw FT.CREATE here must do the same, or an
			// insert-then-search in this test races the propagation. 1.2+ has the
			// index on the first FT.INFO, and standalone has a single primary.
			await waitForIndexOnAllPrimaries(config.indexName);
		}

		/**
		 * Waits until every non-failed primary of the cluster answers FT.INFO for
		 * the index. No-op on a standalone client. Mirrors @langchain/valkey's
		 * waitForIndexOnAllPrimaries (not exported), with the same 10s timeout and
		 * 10ms retry.
		 */
		async function waitForIndexOnAllPrimaries(
			indexName: string,
			timeoutMs = 10_000,
		): Promise<void> {
			if (!(client instanceof GlideClusterClient)) return;
			const cluster = client;
			const nodes = String(
				await cluster.customCommand(['CLUSTER', 'NODES'], { route: 'randomNode' }),
			);
			const primaries: Array<{ host: string; port: number }> = [];
			for (const line of nodes.split('\n')) {
				const parts = line.trim().split(' ');
				if (parts.length < 3) continue;
				const flags = parts[2].split(',');
				if (!flags.includes('master') || flags.includes('fail')) continue;
				// address is `host:port@cport[,hostname]`; split at the last `:` before `@`.
				const address = parts[1].split('@')[0];
				const sep = address.lastIndexOf(':');
				primaries.push({ host: address.slice(0, sep), port: Number(address.slice(sep + 1)) });
			}
			const deadline = Date.now() + timeoutMs;
			for (const { host, port } of primaries) {
				for (;;) {
					try {
						await cluster.customCommand(['FT.INFO', indexName], {
							route: { type: 'routeByAddress', host, port },
						});
						break;
					} catch (err) {
						if (Date.now() >= deadline) {
							// Test helper, not node code: a plain Error is correct here.
							// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
							throw new Error(
								`index "${indexName}" not on primary ${host}:${port} after ${timeoutMs} ms (${String(err)})`,
							);
						}
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
				}
			}
		}

		const vectorSchema = (attribute: string) => [
			'content_vector',
			'AS',
			attribute,
			'VECTOR',
			'FLAT',
			'6',
			'TYPE',
			'FLOAT32',
			'DIM',
			String(embeddings.dimension),
			'DISTANCE_METRIC',
			'COSINE',
		];

		it('rejects a vector field queried under another name on insert and retrieve, and writes nothing', async () => {
			const config = insertConfig('alias-vector');
			await createIndex(config, vectorSchema('emb'));
			const message =
				'names its VECTOR field "content_vector" "emb" in queries, but the node queries it as "content_vector"';

			await expect(search(config, 'x', 1)).rejects.toThrow(message);
			await expect(
				insert(config, [new Document({ pageContent: 'doc', metadata: {} })]),
			).rejects.toThrow(message);
			expect(await countKeys(client, config.keyPrefix)).toBe(0);
		});

		it('rejects a metadata field queried under another name on insert and retrieve, even when it is not declared', async () => {
			const config = insertConfig('alias-metadata');
			await createIndex(config, [
				...vectorSchema('content_vector'),
				'metadata_year',
				'NUMERIC',
				'metadata_tenant',
				'AS',
				't',
				'TAG',
			]);
			const message =
				'names metadata field "metadata_tenant" "t" in queries, but the node queries it as "metadata_tenant"';

			await expect(search(config, 'x', 1)).rejects.toThrow(message);
			await expect(
				insert(config, [new Document({ pageContent: 'doc', metadata: { year: 2024 } })]),
			).rejects.toThrow(message);
			expect(await countKeys(client, config.keyPrefix)).toBe(0);
		});

		it('rejects an index created by an earlier version of the node on insert and retrieve', async () => {
			const config = insertConfig('earlier-layout');
			// The earlier layout: values in `metadata.<name>`, aliased to `metadata_<name>`.
			await createIndex(config, [
				...vectorSchema('content_vector'),
				'metadata.tenant',
				'AS',
				'metadata_tenant',
				'TAG',
			]);
			const message =
				'reads metadata field "tenant" from the hash field "metadata.tenant", which an earlier version of this node wrote';

			await expect(search(config, 'x', 1)).rejects.toThrow(message);
			await expect(
				insert(config, [new Document({ pageContent: 'doc', metadata: { tenant: 'acme' } })]),
			).rejects.toThrow(message);
			expect(await countKeys(client, config.keyPrefix)).toBe(0);
		});

		it('accepts fields whose attribute names match the ones the node queries', async () => {
			const config = insertConfig('alias-matching');
			await createIndex(config, [...vectorSchema('content_vector'), 'metadata_tenant', 'TAG']);

			await insert(config, [
				new Document({ pageContent: 'acme doc', metadata: { tenant: 'acme' } }),
			]);

			const results = await search(config, 'x', 10, [
				{ field: 'tenant', operator: 'is', value: 'acme' },
			]);
			expect(results.map(([doc]) => doc.pageContent)).toEqual(['acme doc']);
		});

		it('inserts into and filters on fields named like Object.prototype members', async () => {
			const config = insertConfig('prototype-names');
			await createIndex(config, [
				...vectorSchema('content_vector'),
				'metadata_constructor',
				'TAG',
				'metadata_toString',
				'NUMERIC',
				'metadata___proto__',
				'TAG',
				'metadata_tenant',
				'TAG',
			]);

			// A document without those fields used to fail validation on every insert.
			await insert(config, [
				new Document({ pageContent: 'plain doc', metadata: { tenant: 'acme' } }),
			]);
			const tagged = new Document({ pageContent: 'tagged doc', metadata: { tenant: 'acme' } });
			Object.assign(tagged.metadata, { constructor: 'red', toString: 7 });
			Object.defineProperty(tagged.metadata, '__proto__', {
				value: 'blue',
				enumerable: true,
				writable: true,
				configurable: true,
			});
			await insert(config, [tagged]);

			const contents = async (rows: FilterConditionRow[]) =>
				(await search(config, 'x', 10, rows)).map(([doc]) => doc.pageContent).sort();
			expect(await contents([{ field: 'constructor', operator: 'is', value: 'red' }])).toEqual([
				'tagged doc',
			]);
			expect(await contents([{ field: 'toString', operator: 'equals', value: '7' }])).toEqual([
				'tagged doc',
			]);
			expect(await contents([{ field: '__proto__', operator: 'is', value: 'blue' }])).toEqual([
				'tagged doc',
			]);
			expect(await contents([{ field: 'tenant', operator: 'is', value: 'acme' }])).toEqual([
				'plain doc',
				'tagged doc',
			]);
		});
	});

	it('excludes documents missing a filtered field', async () => {
		const config = insertConfig('missing-field', { declaredFields: declared });
		await insert(config, [
			...corpus,
			new Document({ pageContent: 'no year', metadata: { source: 'x' } }),
		]);
		const results = await search(config, 'no year', 10, [
			{ field: 'year', operator: 'gte', value: '0' },
		]);
		// Every corpus document has a year, so all of them match; only "no year" is left out.
		expect(results.map(([d]) => d.pageContent).sort()).toEqual(
			corpus.map((d) => d.pageContent).sort(),
		);
	});

	it('fails on a dimension mismatch on insert and on retrieve', async () => {
		const config = insertConfig('dims');
		await insert(config, corpus.slice(0, 1));
		const wide = new FakeEmbeddings(16);
		await expect(
			insertBatch(config, wide, corpus.slice(1, 2), newInsertState(), defaultInsertDeps(connect)),
		).rejects.toThrow('dimension 8, but the connected embeddings produce 16');
		const store = await buildRetrieveStore(await connect(), config, wide, []);
		try {
			await expect(
				store.similaritySearchVectorWithScore(await wide.embedQuery('x'), 1),
			).rejects.toThrow('dimension 8, but the connected embeddings produce 16');
		} finally {
			store.closeClient();
		}
	});

	it('Delete Index and Documents removes old documents and keeps keys outside the prefix', async () => {
		const config = insertConfig('clear');
		const outside = `${config.keyPrefix.slice(0, -1)}-outside:keep`;
		await client.set(outside, 'keep');
		await insert(
			config,
			Array.from({ length: 10 }, (_, i) => new Document({ pageContent: `old ${i}` })),
		);
		await insert({ ...config, clearIndex: true }, corpus.slice(0, 3));
		expect(await countKeys(client, config.keyPrefix)).toBe(3);
		expect(await client.get(outside)).toBe('keep');
		await client.del([outside]);
	});

	it("Delete Index and Documents deletes the index's own documents when the Key Prefix has changed", async () => {
		const config = insertConfig('clear-prefix');
		const newPrefix = `${config.keyPrefix.slice(0, -1)}-v2:`;
		await insert(
			config,
			Array.from({ length: 5 }, (_, i) => new Document({ pageContent: `old ${i}` })),
		);
		expect(await countKeys(client, config.keyPrefix)).toBe(5);

		await insert({ ...config, keyPrefix: newPrefix, clearIndex: true }, corpus.slice(0, 2));

		expect(await countKeys(client, config.keyPrefix)).toBe(0);
		expect(await countKeys(client, newPrefix)).toBe(2);
		const info = await readIndexInfo(client, config.indexName);
		expect(info?.prefixes).toEqual([newPrefix]);
	});

	it('Delete Index and Documents clears once across batches', async () => {
		const config = insertConfig('clear-batches', { clearIndex: true });
		const docs = Array.from({ length: 450 }, (_, i) => new Document({ pageContent: `doc ${i}` }));
		await insert(config, docs, 200);
		expect(await countKeys(client, config.keyPrefix)).toBe(450);
	});

	it('Delete Index and Documents leaves the index intact when embedding fails', async () => {
		const config = insertConfig('clear-embed-fail');
		await insert(config, corpus.slice(0, 2));
		const failing = {
			embedDocuments: async () => Promise.reject(new Error('401 invalid API key')),
			embedQuery: async () => [],
		};
		await expect(
			insertBatch(
				{ ...config, clearIndex: true },
				failing,
				corpus.slice(0, 1),
				newInsertState(),
				defaultInsertDeps(connect),
			),
		).rejects.toThrow('401');
		expect(await countKeys(client, config.keyPrefix)).toBe(2);
		await expect(readIndexInfo(client, config.indexName)).resolves.not.toBeNull();
	});

	it('Delete Index and Documents keeps the index when deleting fails, and a rerun finishes', async () => {
		const config = insertConfig('clear-fail');
		await insert(
			config,
			Array.from({ length: 5 }, (_, i) => new Document({ pageContent: `old ${i}` })),
		);

		let failed = false;
		const flaky = {
			scan: client.scan.bind(client),
			unlink: async (keys: string[]) => {
				if (!failed) {
					failed = true;
					throw new Error('connection reset');
				}
				return await client.unlink(keys);
			},
		};
		await expect(clearIndex(flaky as never, config.indexName, [config.keyPrefix])).rejects.toThrow(
			'The index was not dropped',
		);
		// Nothing was lost track of: the documents and the index are both still there.
		expect(await countKeys(client, config.keyPrefix)).toBe(5);
		const info = await readIndexInfo(client, config.indexName);
		expect(info?.prefixes).toEqual([config.keyPrefix]);

		// A rerun reads the index's own prefixes and finishes the job.
		await insert({ ...config, clearIndex: true }, corpus.slice(0, 1));
		expect(await countKeys(client, config.keyPrefix)).toBe(1);
	});

	it('two concurrent first inserts both succeed, one after retrying on "index already exists"', async () => {
		const config = insertConfig('concurrent');
		// Hold each FT.CREATE until both inserts have reached it. Both have then
		// seen no index, so exactly one FT.CREATE fails with "already exists".
		const realCreate = GlideFt.create.bind(GlideFt);
		let arrived = 0;
		let releaseCreates!: () => void;
		const bothArrived = new Promise<void>((resolve) => (releaseCreates = resolve));
		const createOutcomes: string[] = [];
		const create = jest
			.spyOn(GlideFt, 'create')
			.mockImplementation(async (...args: Parameters<typeof GlideFt.create>) => {
				arrived += 1;
				if (arrived === 2) releaseCreates();
				await bothArrived;
				const reply = realCreate(...args);
				reply.then(
					() => createOutcomes.push('created'),
					(error: Error) => createOutcomes.push(error.message),
				);
				return await reply;
			});
		try {
			await Promise.all([insert(config, corpus.slice(0, 2)), insert(config, corpus.slice(2, 4))]);
		} finally {
			create.mockRestore();
		}
		expect(createOutcomes).toHaveLength(2);
		expect(createOutcomes).toContain('created');
		expect(createOutcomes.some((outcome) => /already exists/i.test(outcome))).toBe(true);
		expect(await countKeys(client, config.keyPrefix)).toBe(4);
	});

	it('sets the TTL on inserted keys', async () => {
		const config = insertConfig('ttl', { ttl: 3600 });
		await insert(config, corpus.slice(0, 1));
		const keys = await scanKeys(client, config.keyPrefix);
		const ttl = await client.ttl(keys[0]);
		expect(ttl).toBeGreaterThan(3500);
		expect(ttl).toBeLessThanOrEqual(3600);
	});

	describe('document IDs and Update', () => {
		const faq = (id: string, text: string, extra: Record<string, unknown> = {}) =>
			new Document({ pageContent: text, metadata: { doc_key: id, ...extra } });

		/** The store n8n's Update writes through, as getVectorStoreClient builds it. */
		async function update(config: InsertConfig, doc: Document, id: string, ttl?: number) {
			const store = await buildRetrieveStore(
				await connect(),
				{ ...config, ttl, updateMode: true },
				embeddings,
				[],
			);
			try {
				return await store.addDocuments([doc], { ids: [id] });
			} finally {
				store.closeClient();
			}
		}

		async function storedMetadata(key: string) {
			return JSON.parse(String(await client.hget(key, 'metadata')));
		}

		it('stores documents under their ID Metadata Field, and re-inserting replaces them', async () => {
			const config = insertConfig('ids', { idField: 'doc_key' });
			await insert(config, [
				faq('faq-1', 'Refunds take 5 days', { draft: true }),
				faq('faq-2', 'Reset password'),
			]);
			expect(await client.exists([`${config.keyPrefix}faq-1`, `${config.keyPrefix}faq-2`])).toBe(2);

			await insert(config, [faq('faq-1', 'Refunds take 3 days')]);
			expect(await countKeys(client, config.keyPrefix)).toBe(2);
			expect(String(await client.hget(`${config.keyPrefix}faq-1`, 'content'))).toBe(
				'Refunds take 3 days',
			);
			// Replaced whole: the dropped field is gone.
			expect(await storedMetadata(`${config.keyPrefix}faq-1`)).toEqual({ doc_key: 'faq-1' });
		});

		it('search results keep the stored ID Metadata Field', async () => {
			const config = insertConfig('ids-search', { idField: 'doc_key' });
			await insert(config, [faq('faq-1', 'Refunds take 5 days')]);
			const [[found]] = await search(config, 'Refunds take 5 days', 1);
			expect(found.metadata).toEqual({ doc_key: 'faq-1' });
		});

		it('Update replaces an existing document, fills the ID field and applies the update TTL', async () => {
			const config = insertConfig('update', { idField: 'doc_key' });
			await insert(config, [faq('faq-1', 'Old answer', { topic: 'billing' })]);
			const key = `${config.keyPrefix}faq-1`;
			expect(await client.ttl(key)).toBe(-1);

			await update(config, new Document({ pageContent: 'New answer', metadata: {} }), 'faq-1', 60);

			expect(String(await client.hget(key, 'content'))).toBe('New answer');
			expect(await storedMetadata(key)).toEqual({ doc_key: 'faq-1' });
			const ttl = await client.ttl(key);
			expect(ttl).toBeGreaterThan(50);
			expect(ttl).toBeLessThanOrEqual(60);
			const [[found]] = await search(config, 'New answer', 1);
			expect(found.pageContent).toBe('New answer');
		});

		it('Update without the option works with a random ID', async () => {
			const config = insertConfig('update-uuid');
			await insert(config, [new Document({ pageContent: 'Old', metadata: {} })]);
			const [key] = await scanKeys(client, config.keyPrefix);
			const id = String(key).slice(config.keyPrefix.length);

			await update(config, new Document({ pageContent: 'New', metadata: {} }), id);
			expect(String(await client.hget(String(key), 'content'))).toBe('New');
			expect(await client.ttl(String(key))).toBe(-1);
		});

		it('Update creates the document when the ID does not exist (upsert)', async () => {
			const config = insertConfig('update-missing', { idField: 'doc_key' });
			await insert(config, [faq('faq-1', 'Exists')]);
			await update(config, new Document({ pageContent: 'New', metadata: {} }), 'faq-9', 60);

			const key = `${config.keyPrefix}faq-9`;
			expect(String(await client.hget(key, 'content'))).toBe('New');
			expect(await storedMetadata(key)).toEqual({ doc_key: 'faq-9' });
			expect(await client.ttl(key)).toBeGreaterThan(50);
			expect(await countKeys(client, config.keyPrefix)).toBe(2);
			const [[found]] = await search(config, 'New', 1);
			expect(found.metadata.doc_key).toBe('faq-9');
		});

		it('Update stores the Content and Metadata settings, and rewrites the indexed fields', async () => {
			const config = insertConfig('update-meta', { idField: 'doc_key', declaredFields: declared });
			await insert(config, [faq('faq-1', 'Old answer', { tenant: 'acme', year: 2020 })]);
			const key = `${config.keyPrefix}faq-1`;
			const byYear = async () =>
				(
					await search(config, 'New answer', 10, [{ field: 'year', operator: 'gte', value: '0' }])
				).map(([d]) => d.metadata.doc_key);
			// The year filter matches the document before the update, so an empty result later
			// shows that the update removed the field.
			expect(await byYear()).toEqual(['faq-1']);

			// The document exactly as n8n's Update builds it from the node's settings.
			const settings: Record<string, unknown> = {
				jsonMode: 'expressionData',
				jsonData: 'New answer',
				options: { metadata: { metadataValues: [{ name: 'tenant', value: 'globex' }] } },
			};
			const loader = new N8nJsonLoader({
				getNode: () => ({ name: 'Valkey Vector Store' }),
				getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
					name in settings ? settings[name] : fallback,
			} as never);
			const docs = await loader.processItem({ json: { text: 'New answer', status: 'x' } }, 0);
			expect(docs).toHaveLength(1);

			await update(config, docs[0], 'faq-1');

			expect(String(await client.hget(key, 'content'))).toBe('New answer');
			expect(await storedMetadata(key)).toMatchObject({ tenant: 'globex', doc_key: 'faq-1' });
			// Indexed copies follow the new metadata; the dropped "year" is gone.
			expect(String(await client.hget(key, 'metadata_tenant'))).toBe('globex');
			expect(await client.hexists(key, 'metadata_year')).toBe(false);
			const byNew = await search(config, 'New answer', 10, [
				{ field: 'tenant', operator: 'is', value: 'globex' },
			]);
			expect(byNew.map(([d]) => d.metadata.doc_key)).toEqual(['faq-1']);
			expect(await byYear()).toEqual([]);
		});

		it('Update rejects a document whose ID Metadata Field names a different document, and leaves the stored document unchanged', async () => {
			const config = insertConfig('update-mismatch', { idField: 'doc_key' });
			await insert(config, [faq('faq-1', 'Original')]);
			// Update targets faq-1, but the incoming document carries doc_key "faq-2".
			await expect(update(config, faq('faq-2', 'Changed'), 'faq-1')).rejects.toThrow(
				'does not match metadata field "doc_key"',
			);
			expect(String(await client.hget(`${config.keyPrefix}faq-1`, 'content'))).toBe('Original');
		});

		it('updates a document in an index with a field named constructor', async () => {
			const config = insertConfig('update-prototype-name', {
				idField: 'doc_key',
				declaredFields: [
					{ name: 'constructor', type: 'TAG' },
					{ name: 'tenant', type: 'TAG' },
				],
			});
			await insert(config, [faq('faq-1', 'Original', { tenant: 'acme' })]);

			// The incoming document has no constructor field.
			await update(config, faq('faq-1', 'Changed', { tenant: 'acme' }), 'faq-1');
			expect(String(await client.hget(`${config.keyPrefix}faq-1`, 'content'))).toBe('Changed');
		});
	});

	it('uses custom content and vector keys', async () => {
		const config = insertConfig('keys', { contentKey: 'text', vectorKey: 'embedding' });
		await insert(config, corpus.slice(0, 1));
		const keys = await scanKeys(client, config.keyPrefix);
		const fields = (await client.hkeys(keys[0])).map(String).sort();
		expect(fields).toEqual(expect.arrayContaining(['embedding', 'metadata', 'text']));
	});

	it('clearIndex helper ignores a missing index', async () => {
		const { indexName, keyPrefix } = uniqueIndex('noop');
		await expect(clearIndex(client, indexName, [keyPrefix])).resolves.toBe(0);
	});
});
