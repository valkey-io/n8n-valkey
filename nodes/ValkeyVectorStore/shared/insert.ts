import type { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { ValkeyVectorStore as LangchainValkeyVectorStore } from '@langchain/valkey';
import type { GlideClient } from '@valkey/valkey-glide';

import { clearIndex } from './clearIndex';
import type { InsertConfig } from './config';
import { toCompatibilityConfig, toLibraryConfig, validateMetadataKey } from './config';
import { ValkeyUserError, classifyFtError, messageOf } from './errors';
import { toCustomSchema } from './filters';
import { assertCompatible, metadataFields, readIndexInfo } from './indexSchema';
import type { IndexInfo, MetadataField } from './indexSchema';

/** Per-execution state shared by the factory's batch calls to populateVectorStore. */
export interface InsertState {
	cleared: boolean;
	/** Key prefixes Delete Index and Documents deleted under, for error messages. */
	clearedPrefixes: string[];
	written: number;
	/** IDs already used in this execution (ID Metadata Field), without the key prefix. */
	seenIds: Set<string>;
}

export function newInsertState(): InsertState {
	return { cleared: false, clearedPrefixes: [], written: 0, seenIds: new Set() };
}

export interface InsertDeps {
	openClient: () => Promise<GlideClient>;
	readInfo: (client: GlideClient, indexName: string) => Promise<IndexInfo | null>;
	clear: (client: GlideClient, indexName: string, keyPrefixes: string[]) => Promise<number>;
	/**
	 * `fields` are the metadata fields to write as separate hash fields: those
	 * of the existing index, or the declared fields when the index is created.
	 */
	addVectors: (
		client: GlideClient,
		config: InsertConfig,
		embeddings: EmbeddingsInterface,
		vectors: number[][],
		documents: Document[],
		ids: string[] | undefined,
		fields: MetadataField[],
	) => Promise<void>;
}

export const defaultInsertDeps = (openClient: () => Promise<GlideClient>): InsertDeps => ({
	openClient,
	readInfo: async (client, indexName) => await readIndexInfo(client, indexName),
	clear: async (client, indexName, keyPrefixes) => await clearIndex(client, indexName, keyPrefixes),
	addVectors: async (client, config, embeddings, vectors, documents, ids, fields) => {
		const store = new LangchainValkeyVectorStore(embeddings, {
			...toLibraryConfig(config),
			valkeyClient: client,
			indexOptions: { ALGORITHM: config.algorithm, DISTANCE_METRIC: config.metric },
			ttl: config.ttl,
			customSchema: fields.length ? toCustomSchema(fields) : undefined,
		});
		await store.addVectors(vectors, documents, ids ? { ids } : undefined);
	},
});

/** An ID without the key prefix, the form the library returns and the node compares. */
export function stripKeyPrefix(id: string, keyPrefix: string): string {
	return id.startsWith(keyPrefix) ? id.slice(keyPrefix.length) : id;
}

/**
 * Reads a document's ID from the ID Metadata Field: undefined when the field is
 * missing, otherwise a non-blank string or finite number as text. Values are not
 * trimmed, so "a" and "a " are different IDs; 1 and "1" are the same ID.
 */
export function readDocumentId(doc: Document, field: string, position: number): string | undefined {
	const value = (doc.metadata ?? {})[field] as unknown;
	if (value === undefined || value === null) return undefined;
	const valid =
		(typeof value === 'string' && value.trim() !== '') ||
		(typeof value === 'number' && Number.isFinite(value));
	if (!valid) {
		throw new ValkeyUserError(
			`Document ${position}: metadata field "${field}" (ID Metadata Field) has value ${describe(value)}. IDs must be non-empty strings or numbers.`,
			'invalid-id',
		);
	}
	return String(value);
}

/**
 * IDs for one batch, checked against the IDs earlier batches of the same
 * execution used. A missing ID is an error rather than a random fallback, so a
 * mistyped field name or a forgotten loader mapping is caught. A repeated ID
 * means a text splitter made several chunks of one document, or two items
 * share an ID; either way one would overwrite the other.
 */
function batchIds(documents: Document[], config: InsertConfig, state: InsertState): string[] {
	const field = config.idField as string;
	return documents.map((doc, index) => {
		const id = readDocumentId(doc, field, index + 1);
		if (id === undefined) {
			throw new ValkeyUserError(
				`Document ${index + 1}: metadata field "${field}" (ID Metadata Field) is missing. Map it in the Document Loader's metadata, or clear ID Metadata Field to use random IDs.`,
				'invalid-id',
			);
		}
		const bare = stripKeyPrefix(id, config.keyPrefix);
		if (state.seenIds.has(bare)) {
			throw new ValkeyUserError(
				`ID "${bare}" appears in more than one document. With ID Metadata Field set, each document needs a unique ID: remove the text splitter, or make the IDs unique.`,
				'invalid-id',
			);
		}
		state.seenIds.add(bare);
		return id;
	});
}

function describe(value: unknown): string {
	return typeof value === 'string' ? `"${value}"` : `${JSON.stringify(value)} (${typeof value})`;
}

/**
 * Checks declared fields before anything is embedded or written, with a
 * message naming the document, field and value.
 */
export function validateDocumentMetadata(documents: Document[], declared: MetadataField[]): void {
	if (declared.length === 0) return;
	documents.forEach((doc, index) => {
		const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
		for (const field of declared) {
			const value = metadata[field.name];
			if (value === undefined || value === null) continue;
			if (field.type === 'NUMERIC' && (typeof value !== 'number' || !Number.isFinite(value))) {
				throw new ValkeyUserError(
					`Document ${index + 1}: metadata field "${field.name}" is declared NUMERIC but has value ${describe(value)}.`,
					'invalid-metadata',
				);
			}
			if (field.type === 'TAG' && typeof value !== 'string' && !Array.isArray(value)) {
				throw new ValkeyUserError(
					`Document ${index + 1}: metadata field "${field.name}" is declared TAG but has value ${describe(value)}. TAG values must be strings or arrays of strings.`,
					'invalid-metadata',
				);
			}
		}
	});
}

/**
 * Prefixes whose keys Delete Index and Documents deletes. An existing index is
 * cleared by the prefixes it was built with, so a changed Key Prefix setting
 * cannot leave its documents behind. Without an index (for example one dropped
 * by hand), the configured prefix is used.
 */
function prefixesToClear(
	existingPrefixes: string[] | undefined,
	configuredPrefix: string,
): string[] {
	const prefixes = existingPrefixes?.length ? existingPrefixes : [configuredPrefix];
	return [...new Set(prefixes)];
}

function partialWriteContext(state: InsertState, writing: boolean): string {
	const parts: string[] = [];
	if (state.cleared) {
		const where = state.clearedPrefixes.length
			? ` (deleted documents under ${state.clearedPrefixes.map((p) => `"${p}"`).join(', ')})`
			: '';
		parts.push(
			`The index was cleared before this insert${where}, so its previous documents are gone.`,
		);
	}
	if (writing) {
		parts.push(
			`${state.written} document(s) were written in earlier batches; part of the failing batch may also have been written.`,
		);
	}
	return parts.join(' ');
}

/**
 * Inserts one batch from the factory: embed, clear once per execution if
 * requested, check the existing index, then write.
 */
export async function insertBatch(
	config: InsertConfig,
	embeddings: EmbeddingsInterface,
	documents: Document[],
	state: InsertState,
	deps: InsertDeps,
): Promise<void> {
	if (documents.length === 0) return;

	validateMetadataKey(config.metadataKey);
	validateDocumentMetadata(documents, config.declaredFields);

	let ids: string[] | undefined;
	try {
		ids = config.idField ? batchIds(documents, config, state) : undefined;
	} catch (error) {
		// Earlier batches of this execution may already be written.
		const context = partialWriteContext(state, false);
		const earlier = state.written
			? `${state.written} document(s) from earlier batches were already written.`
			: '';
		const note = [context, earlier].filter(Boolean).join(' ');
		if (!note) throw error;
		const wrapped = new ValkeyUserError(`${messageOf(error)} ${note}`, 'partial-write');
		wrapped.cause = error;
		throw wrapped;
	}

	// Embed first: the most likely failure (the embeddings API) then happens
	// before Delete Index and Documents has deleted anything.
	const vectors = await embeddings.embedDocuments(documents.map((d) => d.pageContent));
	if (vectors.length !== documents.length || !vectors[0]?.length) {
		throw new ValkeyUserError(
			`The embeddings model returned ${vectors.length} vector(s) for ${documents.length} document(s).`,
			'embeddings-response',
		);
	}
	const dimension = vectors[0].length;

	let writing = false;
	const client = await deps.openClient();
	try {
		if (config.clearIndex && !state.cleared) {
			// Read the index before dropping it: its own prefixes say which keys
			// are its documents, whatever Key Prefix is configured now.
			const existing = await deps.readInfo(client, config.indexName);
			const prefixes = prefixesToClear(existing?.prefixes, config.keyPrefix);
			await deps.clear(client, config.indexName, prefixes);
			state.cleared = true;
			state.clearedPrefixes = prefixes;
		}

		// Returns the metadata fields to write. An existing index decides them:
		// writing only the declared ones would leave its other indexed fields
		// out of the hash, so those documents would no longer match filters on
		// them. Declared fields are used only when the index is created.
		const check = async (): Promise<MetadataField[]> => {
			const info = await deps.readInfo(client, config.indexName);
			if (!info) return config.declaredFields;
			assertCompatible(
				info,
				{ ...toCompatibilityConfig(config), dimension, declaredFields: config.declaredFields },
				'insert',
			);
			const fields = metadataFields(info, config.metadataKey);
			validateDocumentMetadata(documents, fields);
			return fields;
		};
		let fields = await check();

		writing = true;
		try {
			await deps.addVectors(client, config, embeddings, vectors, documents, ids, fields);
		} catch (error) {
			// Another execution created the index between our FT.INFO and the
			// library's FT.CREATE. Check the index it created, then retry once.
			if (classifyFtError(error) !== 'index-exists') throw error;
			writing = false;
			fields = await check();
			writing = true;
			await deps.addVectors(client, config, embeddings, vectors, documents, ids, fields);
		}
		state.written += documents.length;
	} catch (error) {
		const context = partialWriteContext(state, writing);
		if (!context) throw error;
		const wrapped = new ValkeyUserError(`${messageOf(error)} ${context}`, 'partial-write');
		wrapped.cause = error;
		throw wrapped;
	} finally {
		client.close();
	}
}
