import { cleanupRun, trackIndex, uniqueIndex } from '../integration/setup';
import {
	N8nTestInstance,
	describeE2e,
	failureMessage,
	nodeOutput,
	type ExecutionResult,
	type WorkflowDefinition,
} from './harness';
import {
	SUPPORT_DOCUMENTS,
	agentWorkflow,
	getManyWorkflow,
	ingestWorkflow,
	qaChainWorkflow,
	updateWorkflow,
	type StoreLocation,
} from './workflows';

// Each test runs n8n and calls Ollama for embeddings, which can be slow on a CPU.
jest.setTimeout(300_000);

interface StoredDocument {
	pageContent: string;
	metadata: Record<string, unknown>;
}

function newStore(label: string): StoreLocation {
	const store = uniqueIndex(label);
	trackIndex(store.indexName);
	return store;
}

function getManyDocuments(result: ExecutionResult): StoredDocument[] {
	return nodeOutput(result, 'Get Many').map((item) => item.document as StoredDocument);
}

/** The documents the Valkey node handed to a retriever or tool, from the node's own output. */
function retrievedDocuments(
	result: ExecutionResult,
	nodeName: string,
	connectionType: string,
): StoredDocument[] {
	const [output] = nodeOutput(result, nodeName, connectionType);
	const response = (output?.response ?? []) as Array<
		StoredDocument | { type: string; text: string }
	>;
	return response.map((entry) =>
		'text' in entry ? (JSON.parse(entry.text) as StoredDocument) : entry,
	);
}

function tenantsOf(documents: StoredDocument[]): string[] {
	return [...new Set(documents.map((doc) => String(doc.metadata.tenant)))].sort();
}

describeE2e('n8n workflows with the Valkey Vector Store node', () => {
	let n8n: N8nTestInstance;

	function run(workflow: WorkflowDefinition): ExecutionResult {
		n8n.importWorkflows([workflow]);
		return n8n.execute(workflow);
	}

	function runSuccessfully(workflow: WorkflowDefinition): ExecutionResult {
		const result = run(workflow);
		if (!result.succeeded)
			throw new Error(`Workflow "${workflow.name}" failed: ${failureMessage(result)}`);
		return result;
	}

	beforeAll(async () => {
		n8n = await N8nTestInstance.start();
	});

	afterAll(async () => {
		n8n?.stop();
		await cleanupRun();
	});

	describe('a shared knowledge base for two tenants', () => {
		const store = newStore('kb');

		beforeAll(() => {
			runSuccessfully(ingestWorkflow(store, SUPPORT_DOCUMENTS, { clearIndex: true }));
		});

		it('Get Many returns every ingested document', () => {
			const documents = getManyDocuments(runSuccessfully(getManyWorkflow(store, 'password')));

			expect(documents.map((doc) => doc.metadata.docId).sort()).toEqual(
				SUPPORT_DOCUMENTS.map((doc) => doc.id).sort(),
			);
		});

		it('ingesting the same documents again replaces them by ID instead of adding copies', () => {
			runSuccessfully(ingestWorkflow(store, SUPPORT_DOCUMENTS));

			const documents = getManyDocuments(runSuccessfully(getManyWorkflow(store, 'password')));

			expect(documents).toHaveLength(SUPPORT_DOCUMENTS.length);
		});

		it('Get Many with a TAG filter returns only the documents of that tenant', () => {
			const result = runSuccessfully(
				getManyWorkflow(store, 'password', [
					{ field: 'tenant', operator: 'is', value: 'tenant-b' },
				]),
			);

			const documents = getManyDocuments(result);
			expect(documents.length).toBeGreaterThan(0);
			expect(tenantsOf(documents)).toEqual(['tenant-b']);
		});

		it('Get Many with a NUMERIC filter returns only the documents in range', () => {
			const result = runSuccessfully(
				getManyWorkflow(store, 'password', [{ field: 'year', operator: 'gte', value: '2025' }]),
			);

			expect(
				getManyDocuments(result)
					.map((doc) => doc.metadata.docId)
					.sort(),
			).toEqual(['a-refund', 'b-password-reset']);
		});

		it('an "Is" filter whose expression returns an array of several values stops the workflow', () => {
			const result = run(
				getManyWorkflow(store, 'password', [
					{ field: 'tenant', operator: 'is', value: '={{ ["tenant-a", "tenant-b"] }}' },
				]),
			);

			expect(result.succeeded).toBe(false);
			expect(failureMessage(result)).toContain('"Is" takes one value');
		});

		it('the Q&A chain retrieves the matching article', () => {
			const result = runSuccessfully(
				qaChainWorkflow(store, 'How many minutes is the tenant-a password reset link valid for?'),
			);

			const retrieved = retrievedDocuments(result, 'Valkey Vector Store', 'ai_vectorStore');
			expect(retrieved.map((doc) => doc.metadata.docId)).toContain('a-password-reset');
		});

		it('the Q&A chain retrieves only the filtered tenant even when another tenant matches better', () => {
			const result = runSuccessfully(
				qaChainWorkflow(store, 'How long is the tenant-a password reset link valid for?', [
					{ field: 'tenant', operator: 'is', value: 'tenant-b' },
				]),
			);

			const retrieved = retrievedDocuments(result, 'Valkey Vector Store', 'ai_vectorStore');
			expect(retrieved.length).toBeGreaterThan(0);
			expect(tenantsOf(retrieved)).toEqual(['tenant-b']);
		});

		it('the AI Agent calls the store as a tool and gets the matching article', () => {
			const result = runSuccessfully(
				agentWorkflow(store, 'How many business days does a tenant-a refund take?'),
			);

			// The answer text comes from the chat model stub, so only the tool's output is checked.
			const retrieved = retrievedDocuments(result, 'valkey_knowledge_base', 'ai_tool');
			expect(retrieved.map((doc) => doc.metadata.docId)).toContain('a-refund');
		});

		it('the AI Agent tool returns only the filtered tenant even when another tenant matches better', () => {
			const result = runSuccessfully(
				agentWorkflow(store, 'How long is the tenant-a password reset link valid for?', [
					{ field: 'tenant', operator: 'is', value: 'tenant-b' },
				]),
			);

			const retrieved = retrievedDocuments(result, 'valkey_knowledge_base', 'ai_tool');
			expect(retrieved.length).toBeGreaterThan(0);
			expect(tenantsOf(retrieved)).toEqual(['tenant-b']);
		});
	});

	describe('Update Documents', () => {
		const store = newStore('update');

		it('replaces the document with the given ID and keeps the others', () => {
			runSuccessfully(ingestWorkflow(store, SUPPORT_DOCUMENTS, { clearIndex: true }));
			const updated = {
				...SUPPORT_DOCUMENTS[1],
				text: 'Refunds (tenant-a): refunds are paid back to the original card within 2 business days.',
			};

			runSuccessfully(updateWorkflow(store, updated));

			const documents = getManyDocuments(runSuccessfully(getManyWorkflow(store, 'refund')));
			expect(documents).toHaveLength(SUPPORT_DOCUMENTS.length);
			const refund = documents.find((doc) => doc.metadata.docId === updated.id);
			expect(refund?.pageContent).toBe(updated.text);
		});
	});

	describe('an index that does not exist', () => {
		const store = newStore('missing');

		it('Get Many stops the workflow with a "does not exist" error', () => {
			const result = run(getManyWorkflow(store, 'password'));

			expect(result.succeeded).toBe(false);
			expect(failureMessage(result)).toContain(`Index "${store.indexName}" does not exist`);
		});

		it('Update stops the workflow and does not create the index', () => {
			const result = run(updateWorkflow(store, SUPPORT_DOCUMENTS[0]));

			expect(result.succeeded).toBe(false);
			expect(failureMessage(result)).toContain('does not exist');
			expect(failureMessage(run(getManyWorkflow(store, 'password')))).toContain('does not exist');
		});
	});
});
