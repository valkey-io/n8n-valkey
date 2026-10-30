import { Document } from '@langchain/core/documents';

import { normalizeIndexInfo } from '../nodes/ValkeyVectorStore/shared/indexSchema';
import { N8nValkeyVectorStore } from '../nodes/ValkeyVectorStore/shared/filteredStore';
import { buildRetrieveStore } from '../nodes/ValkeyVectorStore/shared/retrieve';
import type { StoreConfig } from '../nodes/ValkeyVectorStore/shared/config';
import { HASH_INDEX, JSON_INDEX } from './fixtures/ftInfo';

const config: StoreConfig = {
	indexName: 'kb',
	keyPrefix: 'doc:kb:',
	contentKey: 'content',
	metadataKey: 'metadata',
	vectorKey: 'content_vector',
	metric: 'COSINE',
};

const embeddings = { embedDocuments: jest.fn(), embedQuery: jest.fn() };

function client() {
	return { close: jest.fn() } as unknown as { close: jest.Mock };
}

describe('buildRetrieveStore', () => {
	it('fails for a missing index and closes the client', async () => {
		const c = client();
		await expect(
			buildRetrieveStore(c as never, config, embeddings, [], async () => null),
		).rejects.toThrow('Index "kb" does not exist');
		expect(c.close).toHaveBeenCalled();
	});

	it('fails for an incompatible index', async () => {
		await expect(
			buildRetrieveStore(client() as never, config, embeddings, [], async () =>
				normalizeIndexInfo(JSON_INDEX),
			),
		).rejects.toThrow('JSON storage');
	});

	it('fails for an invalid filter', async () => {
		await expect(
			buildRetrieveStore(
				client() as never,
				config,
				embeddings,
				[{ field: 'category', operator: 'is', value: 'x' }],
				async () => normalizeIndexInfo(HASH_INDEX),
			),
		).rejects.toThrow('"category" is not an indexed field');
	});

	it('takes customSchema from FT.INFO', async () => {
		const store = await buildRetrieveStore(client() as never, config, embeddings, [], async () =>
			normalizeIndexInfo(HASH_INDEX),
		);
		expect(store.customSchema).toEqual({ source: { type: 'TAG' }, year: { type: 'NUMERIC' } });
	});

	it('passes a TTL to the store only when one is given', async () => {
		const read = async () => normalizeIndexInfo(HASH_INDEX);
		const withTtl = await buildRetrieveStore(
			client() as never,
			{ ...config, ttl: 60 },
			embeddings,
			[],
			read,
		);
		const without = await buildRetrieveStore(client() as never, config, embeddings, [], read);
		expect(withTtl.ttl).toBe(60);
		expect(without.ttl).toBeUndefined();
	});
});

describe('N8nValkeyVectorStore', () => {
	async function storeWithFilter(rows: object[]) {
		const c = client();
		const store = await buildRetrieveStore(c as never, config, embeddings, rows, async () =>
			normalizeIndexInfo(HASH_INDEX),
		);
		const search = jest
			.spyOn(N8nValkeyVectorStore.prototype, 'similaritySearchVectorWithScoreAndMetadata')
			.mockResolvedValue([]);
		return { store, search, c };
	}

	afterEach(() => jest.restoreAllMocks());

	it('always applies the configured filter and ignores the caller filter', async () => {
		const { store, search } = await storeWithFilter([
			{ field: 'source', operator: 'is', value: 'acme.pdf' },
		]);
		const query = new Array(1536).fill(0);
		// Retrievers and the tool wrapper pass their own filter argument.
		const callWithFilter = store.similaritySearchVectorWithScore.bind(store) as (
			q: number[],
			k: number,
			f?: unknown,
		) => Promise<unknown>;
		await callWithFilter(query, 4, '@metadata.source:{other}');
		expect(search).toHaveBeenCalledWith(query, 4, { source: 'acme.pdf' });
	});

	it('fails before searching when the query dimension differs', async () => {
		const { store, search } = await storeWithFilter([]);
		await expect(store.similaritySearchVectorWithScore(new Array(768).fill(0), 4)).rejects.toThrow(
			'dimension 1536, but the connected embeddings produce 768',
		);
		expect(search).not.toHaveBeenCalled();
	});

	it('closes its client on release', async () => {
		const { store, c } = await storeWithFilter([]);
		store.closeClient();
		expect(c.close).toHaveBeenCalled();
	});

	describe('IDs in search results', () => {
		const query = new Array(1536).fill(0);
		const hit = (metadata: Record<string, unknown>, id = 'abc-123') =>
			[new Document({ pageContent: 'x', metadata, id }), 0.9] as [Document, number];

		async function storeReturning(results: Array<[Document, number]>, idField?: string) {
			const store = await buildRetrieveStore(
				client() as never,
				{ ...config, idField },
				embeddings,
				[],
				async () => normalizeIndexInfo(HASH_INDEX),
			);
			jest
				.spyOn(N8nValkeyVectorStore.prototype, 'similaritySearchVectorWithScoreAndMetadata')
				.mockResolvedValue(results);
			return store;
		}

		it('returns the stored metadata unchanged, without adding the ID', async () => {
			const store = await storeReturning([hit({ topic: 'billing' })]);
			const [[doc, score]] = await store.similaritySearchVectorWithScore(query, 1);
			expect(doc.metadata).toEqual({ topic: 'billing' });
			expect(score).toBe(0.9);
		});

		it('does not fill an empty ID Metadata Field from the key', async () => {
			const store = await storeReturning([hit({}, 'faq-1')], 'doc_key');
			const [[doc]] = await store.similaritySearchVectorWithScore(query, 1);
			expect(doc.metadata).toEqual({});
		});
	});

	describe('writes (Update mode)', () => {
		/** The library's addVectors, which does the actual write. */
		function libraryWrite() {
			return jest
				.spyOn(Object.getPrototypeOf(N8nValkeyVectorStore.prototype), 'addVectors')
				.mockResolvedValue(['doc1']);
		}
		const doc = (metadata: Record<string, unknown>) => ({ pageContent: 'x', metadata });

		it('rejects a vector whose dimension differs from the index, before writing', async () => {
			const { store } = await storeWithFilter([]);
			const write = libraryWrite();
			await expect(
				store.addVectors([new Array(768).fill(0)], [doc({})], { ids: ['doc1'] }),
			).rejects.toThrow('dimension 1536, but the connected embeddings produce 768');
			expect(write).not.toHaveBeenCalled();
		});

		it('rejects metadata that does not match the indexed field types, before embedding', async () => {
			const { store } = await storeWithFilter([]);
			const write = libraryWrite();
			embeddings.embedDocuments.mockClear();
			await expect(
				store.addDocuments([doc({ year: 'last year' })], { ids: ['doc1'] }),
			).rejects.toThrow('metadata field "year" is declared NUMERIC but has value "last year"');
			expect(embeddings.embedDocuments).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
		});

		it('writes a valid document through the library', async () => {
			const { store } = await storeWithFilter([]);
			const write = libraryWrite();
			const vectors = [new Array(1536).fill(0)];
			const docs = [doc({ source: 'a.pdf', year: 2024 })];
			await expect(store.addVectors(vectors, docs, { ids: ['doc1'] })).resolves.toEqual(['doc1']);
			expect(write).toHaveBeenCalledWith(vectors, docs, { ids: ['doc1'] });
		});
	});

	describe('Update mode checks', () => {
		/** An update store; `exists` is a spy so tests can show it is never asked. */
		async function updateStore(idField?: string) {
			const c = { close: jest.fn(), exists: jest.fn() };
			const store = await buildRetrieveStore(
				c as never,
				{ ...config, updateMode: true, idField },
				embeddings,
				[],
				async () => normalizeIndexInfo(HASH_INDEX),
			);
			const write = jest
				.spyOn(Object.getPrototypeOf(N8nValkeyVectorStore.prototype), 'addDocuments')
				.mockResolvedValue(['faq-1']);
			embeddings.embedDocuments.mockClear();
			return { store, write, c };
		}
		const doc = (metadata: Record<string, unknown>) => ({ pageContent: 'x', metadata });

		it('passes the Update ID to the library without checking that the document exists', async () => {
			const { store, write, c } = await updateStore();
			await expect(store.addDocuments([doc({})], { ids: ['faq-9'] })).resolves.toEqual(['faq-1']);
			expect(c.exists).not.toHaveBeenCalled();
			expect(write).toHaveBeenCalledWith([expect.anything()], { ids: ['faq-9'] });
		});

		it.each([[undefined], [[]], [['']], [['  ']]])(
			'fails without an Update ID (%p)',
			async (ids) => {
				const { store, write } = await updateStore();
				await expect(store.addDocuments([doc({})], { ids })).rejects.toThrow(
					'Update needs the ID of the document to write',
				);
				expect(write).not.toHaveBeenCalled();
			},
		);

		it('fills a missing ID Metadata Field with the Update ID', async () => {
			const { store, write } = await updateStore('doc_key');
			await store.addDocuments([doc({ topic: 'billing' })], { ids: ['doc:kb:faq-1'] });
			const [[written]] = write.mock.calls[0] as [Array<{ metadata: unknown }>];
			expect(written.metadata).toEqual({ topic: 'billing', doc_key: 'faq-1' });
		});

		it('accepts a matching ID Metadata Field, including 1 for "1"', async () => {
			const { store, write } = await updateStore('doc_key');
			await store.addDocuments([doc({ doc_key: 1 })], { ids: ['1'] });
			expect(write).toHaveBeenCalled();
		});

		it('fails when the ID Metadata Field differs from the Update ID, before embedding', async () => {
			const store = await buildRetrieveStore(
				client() as never,
				{ ...config, updateMode: true, idField: 'doc_key' },
				embeddings,
				[],
				async () => normalizeIndexInfo(HASH_INDEX),
			);
			// The library's addDocuments runs for real and would embed; only its write is mocked.
			const write = jest
				.spyOn(Object.getPrototypeOf(N8nValkeyVectorStore.prototype), 'addVectors')
				.mockResolvedValue(['faq-1']);
			embeddings.embedDocuments.mockClear();
			await expect(
				store.addDocuments([doc({ doc_key: 'faq-2' })], { ids: ['faq-1'] }),
			).rejects.toThrow('Update ID "faq-1" does not match metadata field "doc_key" ("faq-2")');
			expect(embeddings.embedDocuments).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
		});
	});
});
