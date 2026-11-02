import { createVectorStoreNode } from '@n8n/ai-utilities';
import type { Embeddings } from '@langchain/core/embeddings';
import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodePropertyOptions,
	ISupplyDataFunctions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { createValkeyClient } from './shared/client';
import {
	parseCredentials,
	readFilterRows,
	readInsertConfig,
	readStoreConfig,
	readUpdateConfig,
} from './shared/config';
import type { ParamReader } from './shared/config';
import {
	insertFields,
	loadFields,
	retrieveFields,
	sharedFields,
	updateFields,
} from './shared/descriptions';
import { NO_DOCUMENTS_ERROR, ValkeyUserError, messageOf, missingIndexError } from './shared/errors';
import { toHostVectorStore } from './shared/hostVectorStore';
import { metadataFields, readIndexInfo } from './shared/indexSchema';
import { defaultInsertDeps, insertBatch, newInsertState } from './shared/insert';
import type { InsertState } from './shared/insert';
import type { N8nValkeyVectorStore } from './shared/filteredStore';
import { buildRetrieveStore } from './shared/retrieve';

type NodeContext = IExecuteFunctions | ISupplyDataFunctions;

/** Insert state per execution; the factory passes the same context to every batch. */
const insertStates = new WeakMap<object, InsertState>();

function reader(context: NodeContext, itemIndex: number): ParamReader {
	return (name, fallback) => context.getNodeParameter(name, itemIndex, fallback as never);
}

/** Converts every error into a NodeOperationError, keeping the original message and cause. */
function toNodeError(context: NodeContext, error: unknown, itemIndex?: number): never {
	if (error instanceof NodeOperationError) throw error;
	if (error instanceof ValkeyUserError) {
		throw new NodeOperationError(context.getNode(), error.message, { itemIndex });
	}
	throw new NodeOperationError(
		context.getNode(),
		error instanceof Error ? error : new Error(messageOf(error)),
		{ itemIndex },
	);
}

async function openClient(context: NodeContext | ILoadOptionsFunctions) {
	const credentials = await context.getCredentials('valkeyApi');
	return await createValkeyClient(parseCredentials(credentials));
}

const VectorStoreValkeyBase = createVectorStoreNode<N8nValkeyVectorStore>({
	meta: {
		displayName: 'Valkey Vector Store',
		name: 'vectorStoreValkey',
		description: 'Work with your data in a Valkey vector store',
		icon: { light: 'file:../../icons/valkey.svg', dark: 'file:../../icons/valkey.dark.svg' },
		docsUrl: 'https://github.com/valkey-io/n8n-valkey#readme',
		credentials: [{ name: 'valkeyApi', required: true, testedBy: 'valkeyApiConnectionTest' }],
		operationModes: ['load', 'insert', 'retrieve', 'update', 'retrieve-as-tool'],
	},
	sharedFields,
	insertFields,
	loadFields,
	retrieveFields,
	updateFields,
	methods: {
		credentialTest: {
			async valkeyApiConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				let client: Awaited<ReturnType<typeof createValkeyClient>> | undefined;
				try {
					client = await createValkeyClient(
						parseCredentials((credential.data ?? {}) as ICredentialDataDecryptedObject),
					);
					await client.ping();
					return { status: 'OK', message: 'Connection successful' };
				} catch (error) {
					return { status: 'Error', message: messageOf(error) };
				} finally {
					client?.close();
				}
			},
		},
		loadOptions: {
			async getFilterFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const get: ParamReader = (name, fallback) =>
					this.getCurrentNodeParameter(name) ?? (fallback as never);
				let config;
				try {
					config = readStoreConfig(get);
				} catch (error) {
					throw new NodeOperationError(this.getNode(), messageOf(error));
				}
				const client = await openClient(this);
				try {
					const info = await readIndexInfo(client, config.indexName);
					if (!info) throw missingIndexError(config.indexName);
					return metadataFields(info, config.metadataKey).map((field) => ({
						name: `${field.name} (${field.type})`,
						value: field.name,
					}));
				} catch (error) {
					throw new NodeOperationError(this.getNode(), messageOf(error));
				} finally {
					client.close();
				}
			},
		},
	},

	async populateVectorStore(context, embeddings, documents, itemIndex) {
		let state = insertStates.get(context);
		if (!state) {
			state = newInsertState();
			insertStates.set(context, state);
		}
		try {
			const config = readInsertConfig(reader(context, itemIndex));
			await insertBatch(
				config,
				embeddings,
				documents,
				state,
				defaultInsertDeps(async () => await openClient(context)),
			);
		} catch (error) {
			toNodeError(context, error, itemIndex);
		}
	},

	async getVectorStoreClient(context, _filter, embeddings: Embeddings, itemIndex) {
		try {
			const get = reader(context, itemIndex);
			// n8n's Update mode writes through this store, so it needs the update TTL.
			const config = get('mode', '') === 'update' ? readUpdateConfig(get) : readStoreConfig(get);
			const client = await openClient(context);
			const store = await buildRetrieveStore(client, config, embeddings, readFilterRows(get));
			// n8n's retriever checks `instanceof VectorStore` against its own @langchain/core.
			return toHostVectorStore(store, embeddings);
		} catch (error) {
			return toNodeError(context, error, itemIndex);
		}
	},

	releaseVectorStoreClient(vectorStore) {
		vectorStore.closeClient();
	},
});

const baseExecute = VectorStoreValkeyBase.prototype.execute;

export class ValkeyVectorStore extends VectorStoreValkeyBase {
	/**
	 * With zero documents the factory never calls populateVectorStore, so an
	 * empty insert would otherwise succeed silently with 0 items. The insert
	 * output has one item per document, so an empty output means nothing was
	 * inserted.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const result = await baseExecute.call(this);
		if (this.getNodeParameter('mode', 0) === 'insert' && (result[0]?.length ?? 0) === 0) {
			throw new NodeOperationError(this.getNode(), NO_DOCUMENTS_ERROR);
		}
		return result;
	}
}
