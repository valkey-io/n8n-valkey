import {
	CHAT_MODEL_STUB_CREDENTIAL,
	OLLAMA_CREDENTIAL,
	VALKEY_CREDENTIAL,
	chatModel,
	embeddingModel,
	type WorkflowDefinition,
	type WorkflowNode,
} from './harness';

const VECTOR_STORE_NODE_TYPE = 'n8n-nodes-valkey-vector-store.vectorStoreValkey';
const VALKEY_NODE_VERSION = 1.3;

export interface StoreLocation {
	indexName: string;
	keyPrefix: string;
}

export interface SupportDocument {
	id: string;
	tenant: string;
	year: number;
	text: string;
}

export interface FilterCondition {
	field: string;
	operator: 'is' | 'isAnyOf' | 'equals' | 'gte' | 'lte' | 'between';
	value: string;
	valueTo?: string;
}

/** Support articles for two tenants, each with a distinct fact that identifies the article retrieved. */
export const SUPPORT_DOCUMENTS: SupportDocument[] = [
	{
		id: 'a-password-reset',
		tenant: 'tenant-a',
		year: 2024,
		text: 'Password reset (tenant-a): open Settings > Security and click "Reset password". The reset link expires after 47 minutes.',
	},
	{
		id: 'a-refund',
		tenant: 'tenant-a',
		year: 2025,
		text: 'Refunds (tenant-a): refunds are paid back to the original card within 9 business days.',
	},
	{
		id: 'b-password-reset',
		tenant: 'tenant-b',
		year: 2025,
		text: 'Password reset (tenant-b): ask your workspace administrator, who can send a reset code that is valid for 3 hours.',
	},
	{
		id: 'b-shared-sso',
		tenant: 'tenant-b',
		year: 2023,
		text: 'Single sign-on (tenant-b): SAML single sign-on is configured under Admin > Identity and supports Okta only.',
	},
];

let nodeCounter = 0;

function node(
	name: string,
	type: string,
	typeVersion: number,
	parameters: Record<string, unknown>,
	credentials?: WorkflowNode['credentials'],
): WorkflowNode {
	nodeCounter += 1;
	return {
		id: `e2e-node-${nodeCounter}`,
		name,
		type,
		typeVersion,
		position: [nodeCounter * 200, 0],
		parameters,
		...(credentials ? { credentials } : {}),
	};
}

type Connections = WorkflowDefinition['connections'];

function connect(connections: Connections, from: string, to: string, type = 'main'): void {
	const outputs = (connections[from] ??= {});
	const targets = (outputs[type] ??= [[]]);
	targets[0].push({ node: to, type, index: 0 });
}

function manualTrigger(): WorkflowNode {
	return node('Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, {});
}

/** A Code node that returns the given items. */
function itemsNode(name: string, items: Array<Record<string, unknown>>): WorkflowNode {
	return node(name, 'n8n-nodes-base.code', 2, {
		jsCode: `return ${JSON.stringify(items.map((json) => ({ json })))};`,
	});
}

function embeddingsNode(name: string): WorkflowNode {
	return node(
		name,
		'@n8n/n8n-nodes-langchain.embeddingsOllama',
		1,
		{ model: embeddingModel },
		OLLAMA_CREDENTIAL,
	);
}

function chatModelNode(): WorkflowNode {
	return node(
		'Ollama Chat Model',
		'@n8n/n8n-nodes-langchain.lmChatOllama',
		1,
		{ model: chatModel, options: { temperature: 0 } },
		CHAT_MODEL_STUB_CREDENTIAL,
	);
}

function indexOptions(store: StoreLocation): Record<string, unknown> {
	return { keyPrefix: store.keyPrefix, idMetadataField: 'docId' };
}

function metadataFilter(conditions: FilterCondition[]): Record<string, unknown> {
	return { conditions };
}

function workflow(
	id: string,
	name: string,
	nodes: WorkflowNode[],
	connections: Connections,
): WorkflowDefinition {
	// n8n workflow IDs are 16 characters.
	return { id: id.padEnd(16, '0').slice(0, 16), name, nodes, connections };
}

/** Ingest: Manual Trigger, a Code node with the documents, and Insert with a Default Data Loader. */
export function ingestWorkflow(
	store: StoreLocation,
	documents: SupportDocument[],
	options: { clearIndex?: boolean } = {},
): WorkflowDefinition {
	const nodes = [
		manualTrigger(),
		itemsNode(
			'Prepare Documents',
			documents.map((doc) => ({ ...doc, docId: doc.id })),
		),
		node('Default Data Loader', '@n8n/n8n-nodes-langchain.documentDefaultDataLoader', 1.1, {
			jsonMode: 'expressionData',
			jsonData: '={{ $json.text }}',
			options: {
				metadata: {
					metadataValues: [
						{ name: 'docId', value: '={{ $json.docId }}' },
						{ name: 'tenant', value: '={{ $json.tenant }}' },
						{ name: 'year', value: '={{ $json.year }}' },
					],
				},
			},
		}),
		embeddingsNode('Embeddings'),
		node(
			'Insert',
			VECTOR_STORE_NODE_TYPE,
			VALKEY_NODE_VERSION,
			{
				mode: 'insert',
				valkeyIndex: store.indexName,
				indexOptions: indexOptions(store),
				metadataFields: { fields: [{ name: 'tenant' }, { name: 'year', type: 'NUMERIC' }] },
				insertOptions: { clearIndex: options.clearIndex ?? false },
			},
			VALKEY_CREDENTIAL,
		),
	];
	const connections: Connections = {};
	connect(connections, 'Manual Trigger', 'Prepare Documents');
	connect(connections, 'Prepare Documents', 'Insert');
	connect(connections, 'Default Data Loader', 'Insert', 'ai_document');
	connect(connections, 'Embeddings', 'Insert', 'ai_embedding');
	return workflow('e2eIngest', 'E2E Ingest', nodes, connections);
}

/** Get Many with an optional Metadata Filter. */
export function getManyWorkflow(
	store: StoreLocation,
	prompt: string,
	conditions: FilterCondition[] = [],
	topK = 10,
): WorkflowDefinition {
	const nodes = [
		manualTrigger(),
		embeddingsNode('Embeddings'),
		node(
			'Get Many',
			VECTOR_STORE_NODE_TYPE,
			VALKEY_NODE_VERSION,
			{
				mode: 'load',
				valkeyIndex: store.indexName,
				prompt,
				topK,
				indexOptions: indexOptions(store),
				metadataFilter: metadataFilter(conditions),
			},
			VALKEY_CREDENTIAL,
		),
	];
	const connections: Connections = {};
	connect(connections, 'Manual Trigger', 'Get Many');
	connect(connections, 'Embeddings', 'Get Many', 'ai_embedding');
	return workflow('e2eGetMany', 'E2E Get Many', nodes, connections);
}

/** Update Documents: replaces the document with the given ID. */
export function updateWorkflow(
	store: StoreLocation,
	document: SupportDocument,
): WorkflowDefinition {
	const nodes = [
		manualTrigger(),
		itemsNode('Prepare Update', [{ ...document, docId: document.id }]),
		embeddingsNode('Embeddings'),
		node(
			'Update',
			VECTOR_STORE_NODE_TYPE,
			VALKEY_NODE_VERSION,
			{
				mode: 'update',
				valkeyIndex: store.indexName,
				id: document.id,
				indexOptions: indexOptions(store),
				jsonData: '={{ $json.text }}',
				options: {
					metadata: {
						metadataValues: [
							{ name: 'docId', value: '={{ $json.docId }}' },
							{ name: 'tenant', value: '={{ $json.tenant }}' },
							{ name: 'year', value: '={{ $json.year }}' },
						],
					},
				},
			},
			VALKEY_CREDENTIAL,
		),
	];
	const connections: Connections = {};
	connect(connections, 'Manual Trigger', 'Prepare Update');
	connect(connections, 'Prepare Update', 'Update');
	connect(connections, 'Embeddings', 'Update', 'ai_embedding');
	return workflow('e2eUpdate', 'E2E Update', nodes, connections);
}

/** Question and Answer Chain with a Vector Store Retriever, as in "Valkey - Q&A Chain with Vector Store Retriever". */
export function qaChainWorkflow(
	store: StoreLocation,
	question: string,
	conditions: FilterCondition[] = [],
): WorkflowDefinition {
	const nodes = [
		manualTrigger(),
		itemsNode('Question', [{ chatInput: question }]),
		node('Question and Answer Chain', '@n8n/n8n-nodes-langchain.chainRetrievalQa', 1.7, {
			options: {},
		}),
		chatModelNode(),
		node('Vector Store Retriever', '@n8n/n8n-nodes-langchain.retrieverVectorStore', 1, { topK: 2 }),
		node(
			'Valkey Vector Store',
			VECTOR_STORE_NODE_TYPE,
			VALKEY_NODE_VERSION,
			{
				mode: 'retrieve',
				valkeyIndex: store.indexName,
				indexOptions: indexOptions(store),
				metadataFilter: metadataFilter(conditions),
			},
			VALKEY_CREDENTIAL,
		),
		embeddingsNode('Embeddings'),
	];
	const connections: Connections = {};
	connect(connections, 'Manual Trigger', 'Question');
	connect(connections, 'Question', 'Question and Answer Chain');
	connect(connections, 'Ollama Chat Model', 'Question and Answer Chain', 'ai_languageModel');
	connect(connections, 'Vector Store Retriever', 'Question and Answer Chain', 'ai_retriever');
	connect(connections, 'Valkey Vector Store', 'Vector Store Retriever', 'ai_vectorStore');
	connect(connections, 'Embeddings', 'Valkey Vector Store', 'ai_embedding');
	return workflow('e2eQaChain', 'E2E Q&A Chain', nodes, connections);
}

/** AI Agent with the store as a tool, as in "Valkey - AI Agent with Vector Store Tool". */
export function agentWorkflow(
	store: StoreLocation,
	question: string,
	conditions: FilterCondition[] = [],
): WorkflowDefinition {
	const nodes = [
		manualTrigger(),
		itemsNode('Question', [{ chatInput: question }]),
		node('AI Agent', '@n8n/n8n-nodes-langchain.agent', 3.1, {
			options: {
				systemMessage:
					'You are a support assistant. Always call the valkey_knowledge_base tool before answering, and answer only from what it returns.',
			},
		}),
		chatModelNode(),
		node(
			'valkey_knowledge_base',
			VECTOR_STORE_NODE_TYPE,
			VALKEY_NODE_VERSION,
			{
				mode: 'retrieve-as-tool',
				toolDescription: 'Searches the support articles. Use it for every question.',
				valkeyIndex: store.indexName,
				topK: 4,
				indexOptions: indexOptions(store),
				metadataFilter: metadataFilter(conditions),
			},
			VALKEY_CREDENTIAL,
		),
		embeddingsNode('Embeddings'),
	];
	const connections: Connections = {};
	connect(connections, 'Manual Trigger', 'Question');
	connect(connections, 'Question', 'AI Agent');
	connect(connections, 'Ollama Chat Model', 'AI Agent', 'ai_languageModel');
	connect(connections, 'valkey_knowledge_base', 'AI Agent', 'ai_tool');
	connect(connections, 'Embeddings', 'valkey_knowledge_base', 'ai_embedding');
	return workflow('e2eAgentTool', 'E2E AI Agent with Tool', nodes, connections);
}
