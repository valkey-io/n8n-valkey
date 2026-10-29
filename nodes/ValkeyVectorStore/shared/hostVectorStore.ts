import { createRequire } from 'node:module';

import type { DocumentInterface } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { VectorStore } from '@langchain/core/vectorstores';

import type { N8nValkeyVectorStore } from './filteredStore';

/** The parts of @langchain/core this module needs from n8n's copy. */
export interface HostLangChain {
	VectorStore: typeof VectorStore;
	Document: new (fields: {
		pageContent: string;
		metadata: Record<string, unknown>;
		id?: string;
	}) => DocumentInterface;
}

/**
 * Loads @langchain/core the way n8n's own nodes see it: resolved from
 * @n8n/ai-utilities, which n8n provides. Returns undefined if it can't be found.
 *
 * Our package can end up with its own copy of @langchain/core: n8n's installer
 * runs `npm install` in the package folder, and npm installs @langchain/valkey's
 * peer dependency there, or Node finds one in a parent folder's node_modules.
 * Classes from two copies fail `instanceof`, and n8n's Vector Store Retriever
 * relies on `vectorStore instanceof VectorStore`.
 */
export function loadHostLangChain(): HostLangChain | undefined {
	try {
		const hostRequire = createRequire(require.resolve('@n8n/ai-utilities'));
		const { VectorStore: HostVectorStore } = hostRequire('@langchain/core/vectorstores');
		const { Document: HostDocument } = hostRequire('@langchain/core/documents');
		return { VectorStore: HostVectorStore, Document: HostDocument };
	} catch {
		return undefined;
	}
}

/**
 * Returns a store n8n recognises as a VectorStore. If our @langchain/core is
 * n8n's, that is the store itself. Otherwise it is a subclass of n8n's
 * VectorStore that forwards every write, search and close to the store, so
 * the store's checks (fixed metadata filter, Update rules) still apply, and
 * whose results are n8n's Document class.
 */
export function toHostVectorStore(
	store: N8nValkeyVectorStore,
	embeddings: EmbeddingsInterface,
	host: HostLangChain | undefined = loadHostLangChain(),
): N8nValkeyVectorStore {
	if (!host || host.VectorStore === VectorStore || store instanceof host.VectorStore) return store;
	const HostDocument = host.Document;

	class HostValkeyVectorStore extends host.VectorStore {
		_vectorstoreType(): string {
			return store._vectorstoreType();
		}

		async addVectors(...args: Parameters<N8nValkeyVectorStore['addVectors']>) {
			return await store.addVectors(...args);
		}

		async addDocuments(...args: Parameters<N8nValkeyVectorStore['addDocuments']>) {
			return await store.addDocuments(...args);
		}

		async delete(...args: Parameters<N8nValkeyVectorStore['delete']>) {
			return await store.delete(...args);
		}

		/** Any caller filter is dropped: the store always applies the node's own filter. */
		async similaritySearchVectorWithScore(
			query: number[],
			k: number,
		): Promise<[DocumentInterface, number][]> {
			const results = await store.similaritySearchVectorWithScore(query, k);
			return results.map(([doc, score]) => [
				new HostDocument({ pageContent: doc.pageContent, metadata: doc.metadata, id: doc.id }),
				score,
			]);
		}

		closeClient(): void {
			store.closeClient();
		}
	}

	return new HostValkeyVectorStore(embeddings, {}) as unknown as N8nValkeyVectorStore;
}
