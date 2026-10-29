import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { ValkeyVectorStore } from '@langchain/valkey';
import type { ValkeyAddOptions, ValkeyVectorStoreConfig } from '@langchain/valkey';
import type { GlideClient } from '@valkey/valkey-glide';

import { ValkeyUserError } from './errors';
import type { MetadataFilter } from './filters';
import { assertDimension } from './indexSchema';
import type { MetadataField } from './indexSchema';
import { readDocumentId, stripKeyPrefix, validateDocumentMetadata } from './insert';

export interface N8nValkeyVectorStoreOptions {
	/** Filter built from the node's configuration. Never taken from call arguments. */
	metadataFilter?: MetadataFilter;
	/** Vector dimension of the existing index, from FT.INFO. */
	indexDimension: number;
	/** Metadata fields the existing index declares, from FT.INFO. Checked on write. */
	metadataFields?: MetadataField[];
	/** Update mode: addDocuments needs an ID per document and upserts under it. */
	updateMode?: boolean;
	/** ID Metadata Field: in Update mode, kept equal to the document's ID. */
	idField?: string;
	/** Client owned by this store; closed by closeClient(). */
	client: GlideClient;
}

/**
 * ValkeyVectorStore whose similarity search always applies the node's
 * configured metadata filter, and whose writes (n8n's Update mode) get the
 * same checks as Insert.
 *
 * n8n's retrievers and tool wrapper call similaritySearchVectorWithScore with
 * their own (or no) filter argument; that argument is ignored, so in tool mode
 * the agent cannot add, remove or change conditions.
 */
export class N8nValkeyVectorStore extends ValkeyVectorStore {
	private readonly options: N8nValkeyVectorStoreOptions;

	constructor(
		embeddings: EmbeddingsInterface,
		config: Omit<ValkeyVectorStoreConfig, 'valkeyClient'>,
		options: N8nValkeyVectorStoreOptions,
	) {
		super(embeddings, { ...config, valkeyClient: options.client });
		this.options = options;
	}

	/**
	 * n8n's Update calls this with one document and `{ ids: [id] }`. In Update
	 * mode the write is an upsert: an existing document with that ID is replaced
	 * whole, otherwise a new one is created under it. The ID must be given, and
	 * the ID Metadata Field (if set) must match it. All checks run before
	 * embedding, so a rejected update costs no embeddings call and writes nothing.
	 */
	async addDocuments(documents: Document[], options?: ValkeyAddOptions): Promise<string[]> {
		const docs = this.options.updateMode ? this.checkUpdate(documents, options?.ids) : documents;
		validateDocumentMetadata(docs, this.options.metadataFields ?? []);
		return await super.addDocuments(docs, options);
	}

	/** Update checks: every document needs an ID, and the ID Metadata Field follows it. */
	private checkUpdate(documents: Document[], ids: string[] | undefined): Document[] {
		if (!ids?.length || ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
			throw new ValkeyUserError('Update needs the ID of the document to write.', 'invalid-id');
		}
		return documents.map((doc, index) => this.withIdField(doc, ids[index], index + 1));
	}

	/** Fills a missing ID Metadata Field with the Update ID, and rejects a different one. */
	private withIdField(doc: Document, id: string | undefined, position: number): Document {
		const field = this.options.idField;
		if (!field || id === undefined) return doc;
		const bare = stripKeyPrefix(id, this.keyPrefix);
		const stored = readDocumentId(doc, field, position);
		if (stored === undefined) {
			return new Document({ ...doc, metadata: { ...(doc.metadata ?? {}), [field]: bare } });
		}
		if (stripKeyPrefix(stored, this.keyPrefix) !== bare) {
			throw new ValkeyUserError(
				`Update ID "${bare}" does not match metadata field "${field}" ("${stripKeyPrefix(stored, this.keyPrefix)}"). Use the same ID in both, or remove "${field}" from the metadata.`,
				'invalid-id',
			);
		}
		return doc;
	}

	/**
	 * Same checks as Insert before anything is written. Without the dimension
	 * check, a vector of the wrong size would be stored but never indexed, so
	 * the document would silently drop out of search.
	 */
	async addVectors(
		vectors: number[][],
		documents: Document[],
		options?: ValkeyAddOptions,
	): Promise<string[]> {
		validateDocumentMetadata(documents, this.options.metadataFields ?? []);
		for (const vector of vectors) {
			assertDimension(this.indexName, this.options.indexDimension, vector.length);
		}
		return await super.addVectors(vectors, documents, options);
	}

	async similaritySearchVectorWithScore(query: number[], k: number): Promise<[Document, number][]> {
		// Callers may pass a filter argument; it is deliberately not a parameter here.
		assertDimension(this.indexName, this.options.indexDimension, query.length);
		return await this.similaritySearchVectorWithScoreAndMetadata(
			query,
			k,
			this.options.metadataFilter,
		);
	}

	closeClient(): void {
		this.options.client.close();
	}
}
