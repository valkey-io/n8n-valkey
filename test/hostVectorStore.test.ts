import { Document } from '@langchain/core/documents';
import { VectorStore } from '@langchain/core/vectorstores';

import {
	loadHostLangChain,
	toHostVectorStore,
} from '../nodes/ValkeyVectorStore/shared/hostVectorStore';
import type { HostLangChain } from '../nodes/ValkeyVectorStore/shared/hostVectorStore';
import { normalizeIndexInfo } from '../nodes/ValkeyVectorStore/shared/indexSchema';
import { buildRetrieveStore } from '../nodes/ValkeyVectorStore/shared/retrieve';
import type { StoreConfig } from '../nodes/ValkeyVectorStore/shared/config';
import { HASH_INDEX } from './fixtures/ftInfo';

const config: StoreConfig = {
	indexName: 'kb',
	keyPrefix: 'doc:kb:',
	contentKey: 'content',
	metadataKey: 'metadata',
	vectorKey: 'content_vector',
	metric: 'COSINE',
};

/** A second, separately loaded @langchain/core, as n8n's copy would be. */
function secondCopy(): HostLangChain {
	let host!: HostLangChain;
	jest.isolateModules(() => {
		host = {
			VectorStore: jest.requireActual('@langchain/core/vectorstores').VectorStore,
			Document: jest.requireActual('@langchain/core/documents').Document,
		};
	});
	return host;
}

async function makeStore() {
	const client = { close: jest.fn() };
	const embeddings = { embedDocuments: jest.fn(), embedQuery: jest.fn(async () => [0.1, 0.2]) };
	const store = await buildRetrieveStore(client as never, config, embeddings, [], async () =>
		normalizeIndexInfo(HASH_INDEX),
	);
	return { store, client, embeddings };
}

afterEach(() => jest.restoreAllMocks());

describe('toHostVectorStore', () => {
	it('returns the store itself when n8n uses the same @langchain/core', async () => {
		const { store, embeddings } = await makeStore();
		expect(toHostVectorStore(store, embeddings, { VectorStore, Document })).toBe(store);
	});

	it('finds the host copy through @n8n/ai-utilities', () => {
		// In this repo both resolve to the same copy.
		expect(loadHostLangChain()?.VectorStore).toBe(VectorStore);
	});

	describe('with a second @langchain/core', () => {
		it('is an instance of the host VectorStore, so n8n takes the asRetriever path', async () => {
			const host = secondCopy();
			const { store, embeddings } = await makeStore();
			expect(store instanceof host.VectorStore).toBe(false);

			const bridged = toHostVectorStore(store, embeddings, host);
			expect(bridged instanceof host.VectorStore).toBe(true);
			expect(bridged._vectorstoreType()).toBe(store._vectorstoreType());
		});

		it('searches through the store and returns host Documents', async () => {
			const host = secondCopy();
			const { store, embeddings } = await makeStore();
			const search = jest
				.spyOn(store, 'similaritySearchVectorWithScore')
				.mockResolvedValue([
					[new Document({ pageContent: 'hi', metadata: { a: 1 }, id: 'x' }), 0.1],
				]);

			const bridged = toHostVectorStore(store, embeddings, host);
			const docs = await bridged
				.asRetriever(3, '@metadata.tenant:{other}' as never)
				.invoke('question');

			expect(embeddings.embedQuery).toHaveBeenCalledWith('question');
			// The caller's filter is never passed on; the store applies its own.
			expect(search).toHaveBeenCalledWith([0.1, 0.2], 3);
			expect(search.mock.calls[0]).toHaveLength(2);
			expect(docs).toHaveLength(1);
			expect(docs[0]).toBeInstanceOf(host.Document);
			expect(docs[0]).toMatchObject({ pageContent: 'hi', metadata: { a: 1 }, id: 'x' });
		});

		it('forwards addDocuments, addVectors and delete to the store', async () => {
			const host = secondCopy();
			const { store, embeddings } = await makeStore();
			const addDocuments = jest.spyOn(store, 'addDocuments').mockResolvedValue(['faq-1']);
			const addVectors = jest.spyOn(store, 'addVectors').mockResolvedValue(['faq-1']);
			const remove = jest.spyOn(store, 'delete').mockResolvedValue(undefined);
			const bridged = toHostVectorStore(store, embeddings, host);

			const doc = new Document({ pageContent: 'x', metadata: {} });
			await expect(bridged.addDocuments([doc], { ids: ['faq-1'] })).resolves.toEqual(['faq-1']);
			expect(addDocuments).toHaveBeenCalledWith([doc], { ids: ['faq-1'] });

			await expect(bridged.addVectors([[0.1, 0.2]], [doc], { ids: ['faq-1'] })).resolves.toEqual([
				'faq-1',
			]);
			expect(addVectors).toHaveBeenCalledWith([[0.1, 0.2]], [doc], { ids: ['faq-1'] });

			await bridged.delete({ ids: ['faq-1'] });
			expect(remove).toHaveBeenCalledWith({ ids: ['faq-1'] });
		});

		it('closes the store client', async () => {
			const host = secondCopy();
			const { store, client, embeddings } = await makeStore();
			toHostVectorStore(store, embeddings, host).closeClient();
			expect(client.close).toHaveBeenCalled();
		});

		// The bridge implements only the VectorStore methods and closeClient.
		// Each expect-error directive below fails type-checking if the return type is widened
		// to the store's own class again.
		it('exposes only the members its type declares', async () => {
			const host = secondCopy();
			const { store, embeddings } = await makeStore();
			const bridged = toHostVectorStore(store, embeddings, host);

			// @ts-expect-error indexName is not part of ValkeyStoreHandle
			const indexName: unknown = bridged.indexName;
			// @ts-expect-error checkIndexExists is not part of ValkeyStoreHandle
			const checkIndexExists: unknown = bridged.checkIndexExists;

			expect(indexName).toBeUndefined();
			expect(checkIndexExists).toBeUndefined();
		});
	});
});
