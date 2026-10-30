import { N8nJsonLoader } from '@n8n/ai-utilities';
import { GlideClient, GlideFt } from '@valkey/valkey-glide';
import { NodeOperationError } from 'n8n-workflow';
import type { INodePropertyCollection } from 'n8n-workflow';

import { ValkeyVectorStore } from '../nodes/ValkeyVectorStore/ValkeyVectorStore.node';
import { NO_DOCUMENTS_ERROR } from '../nodes/ValkeyVectorStore/shared/errors';
import { HASH_INDEX } from './fixtures/ftInfo';

/** Minimal IExecuteFunctions for the factory's insert path with no input items. */
function insertContext(items: unknown[] = []) {
	const node = {
		name: 'Valkey Vector Store',
		typeVersion: 1.3,
		type: 'vectorStoreValkey',
		parameters: {},
	};
	return {
		getNode: () => node,
		getNodeParameter: (name: string, _i: number, fallback?: unknown) => {
			if (name === 'mode') return 'insert';
			if (name === 'embeddingBatchSize') return 200;
			return fallback;
		},
		getInputConnectionData: async () => ({}),
		getInputData: () => items,
		getExecutionCancelSignal: () => undefined,
		logAiEvent: () => undefined,
	};
}

describe('ValkeyVectorStore node', () => {
	const node = new ValkeyVectorStore();

	it('describes a vector store with five modes, including Update', () => {
		const mode = node.description.properties.find((p) => p.name === 'mode');
		const values = (mode?.options as Array<{ value: string }>).map((o) => o.value).sort();
		expect(values).toEqual(['insert', 'load', 'retrieve', 'retrieve-as-tool', 'update']);
	});

	it('shows the update Options with a TTL only in Update mode', () => {
		const options = node.description.properties.find((p) => p.name === 'options');
		expect(options?.displayOptions).toEqual({ show: { mode: ['update'] } });
		const ttl = (options?.options as Array<{ name: string }> | undefined)?.find(
			(o) => o.name === 'ttl',
		);
		expect(ttl).toBeDefined();
	});

	describe('Update Content and Metadata', () => {
		const property = (name: string) => node.description.properties.find((p) => p.name === name);

		/** Context for n8n's N8nJsonLoader: the hidden jsonMode keeps its declared default. */
		function loaderContext(values: Record<string, unknown>) {
			const declared = { jsonMode: property('jsonMode')?.default };
			const all: Record<string, unknown> = { ...declared, ...values };
			return {
				getNode: () => ({ name: 'Valkey Vector Store' }),
				getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
					name in all ? all[name] : fallback,
			};
		}

		it('are shown only in Update mode, with Content fixed to expression data', () => {
			expect(property('jsonMode')).toMatchObject({
				type: 'hidden',
				default: 'expressionData',
				displayOptions: { show: { mode: ['update'] } },
			});
			expect(property('jsonData')).toMatchObject({
				displayName: 'Content',
				required: true,
				displayOptions: { show: { mode: ['update'] } },
			});
			const options = property('options')?.options as Array<{ name: string }>;
			expect(options.map((o) => o.name)).toContain('metadata');
		});

		it("give n8n's loader one document with the Content and the Metadata fields", async () => {
			const context = loaderContext({
				jsonData: 'what is updated ?',
				options: {
					metadata: {
						metadataValues: [
							{ name: 'status', value: 'updated_node' },
							{ name: 'tenant', value: 'tenant-a' },
						],
					},
				},
			});
			const loader = new N8nJsonLoader(context as never);
			// The other string fields of the item no longer become documents.
			const item = { json: { text: 'what is updated ?', status: 'updated_node', 'a😀c': 'a😀c' } };
			const docs = await loader.processItem(item, 0);
			expect(docs).toHaveLength(1);
			expect(docs[0].pageContent).toBe('what is updated ?');
			expect(docs[0].metadata).toMatchObject({ status: 'updated_node', tenant: 'tenant-a' });
			expect(docs[0].metadata).not.toHaveProperty('a😀c');
		});
	});

	it("shows Index Options once in every mode, below n8n's Prompt, Limit and ID", () => {
		const props = node.description.properties;
		const shownIn = (p: (typeof props)[number], mode: string) => {
			const modes = p.displayOptions?.show?.mode as string[] | undefined;
			return modes === undefined || modes.includes(mode);
		};
		const order = (mode: string) => props.filter((p) => shownIn(p, mode)).map((p) => p.name);
		/** Fails if either property is missing, so a removed property cannot pass as "before". */
		const expectBefore = (mode: string, first: string, second: string) => {
			const names = order(mode);
			expect(names).toContain(first);
			expect(names).toContain(second);
			expect(names.indexOf(first)).toBeLessThan(names.indexOf(second));
		};
		for (const mode of ['insert', 'load', 'retrieve', 'retrieve-as-tool', 'update']) {
			expect(order(mode).filter((n) => n === 'indexOptions')).toHaveLength(1);
			expectBefore(mode, 'valkeyIndex', 'indexOptions');
		}
		expectBefore('load', 'prompt', 'indexOptions');
		expectBefore('load', 'topK', 'indexOptions');
		expectBefore('load', 'indexOptions', 'metadataFilter');
		expectBefore('retrieve-as-tool', 'topK', 'indexOptions');
		expectBefore('update', 'id', 'indexOptions');
		expectBefore('update', 'indexOptions', 'jsonData');
	});

	it('declares the Valkey credential with a connection test', () => {
		expect(node.description.credentials).toEqual([
			{ name: 'valkeyApi', required: true, testedBy: 'valkeyApiConnectionTest' },
		]);
		expect(node.methods?.credentialTest?.valkeyApiConnectionTest).toBeInstanceOf(Function);
	});

	it('loads the Metadata Filter field list with getFilterFields', () => {
		const filter = node.description.properties.find((p) => p.name === 'metadataFilter');
		const conditions = (filter?.options as INodePropertyCollection[] | undefined)?.find(
			(o) => o.name === 'conditions',
		);
		const field = conditions?.values.find((v) => v.name === 'field');
		const method = field?.typeOptions?.loadOptionsMethod;
		expect(method).toBe('getFilterFields');
		expect(node.methods?.loadOptions?.[method as string]).toBeInstanceOf(Function);
	});

	describe('getFilterFields', () => {
		const getFilterFields = node.methods!.loadOptions!.getFilterFields;
		/** A connected standalone server; FT.INFO is stubbed separately. */
		const fakeClient = {
			info: jest.fn(async () => 'cluster_enabled:0\r\n'),
			close: jest.fn(),
		};
		let createClient: jest.SpyInstance;
		let ftInfo: jest.SpyInstance;

		/** Minimal ILoadOptionsFunctions: the node parameters the dropdown is opened with. */
		function loadOptionsContext(parameters: Record<string, unknown>) {
			return {
				getNode: () => ({ name: 'Valkey Vector Store' }),
				getCurrentNodeParameter: (name: string) => parameters[name],
				getCredentials: async () => ({ host: 'localhost', tls: false }),
			};
		}

		beforeEach(() => {
			fakeClient.close.mockClear();
			createClient = jest.spyOn(GlideClient, 'createClient').mockResolvedValue(fakeClient as never);
			ftInfo = jest.spyOn(GlideFt, 'info').mockResolvedValue(HASH_INDEX as never);
		});

		afterEach(() => jest.restoreAllMocks());

		it('lists the index metadata fields, labelled with their type and valued by bare name', async () => {
			const context = loadOptionsContext({ valkeyIndex: 'kb' });
			await expect(getFilterFields.call(context as never)).resolves.toEqual([
				{ name: 'source (TAG)', value: 'source' },
				{ name: 'year (NUMERIC)', value: 'year' },
			]);
			expect(ftInfo).toHaveBeenCalledWith(fakeClient, 'kb');
			expect(fakeClient.close).toHaveBeenCalledTimes(1);
		});

		it('fails with a clear error and closes the client when the index does not exist', async () => {
			ftInfo.mockRejectedValue(new Error("Index with name 'kb' not found"));
			const context = loadOptionsContext({ valkeyIndex: 'kb' });
			const error = await getFilterFields.call(context as never).catch((e: Error) => e);
			expect(error).toBeInstanceOf(NodeOperationError);
			expect((error as Error).message).toContain('Index "kb" does not exist');
			expect(fakeClient.close).toHaveBeenCalledTimes(1);
		});

		it('fails before connecting when the index name is missing', async () => {
			const context = loadOptionsContext({ valkeyIndex: '' });
			await expect(getFilterFields.call(context as never)).rejects.toThrow(
				'Valkey Index is required',
			);
			expect(createClient).not.toHaveBeenCalled();
		});
	});

	it('never offers TEXT for metadata fields', () => {
		const json = JSON.stringify(node.description.properties);
		expect(json).not.toContain('"TEXT"');
	});

	it('fails an insert that received no documents', async () => {
		const context = insertContext([]);
		await expect(node.execute.call(context as never)).rejects.toThrow(NodeOperationError);
		await expect(node.execute.call(context as never)).rejects.toThrow(NO_DOCUMENTS_ERROR);
	});
});
