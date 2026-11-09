import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { testCredentials } from '../integration/setup';

/**
 * End-to-end tests run real n8n workflows through the n8n CLI. They run only
 * when N8N_E2E_BIN (the n8n `bin/n8n` script) and VALKEY_HOST are set, and
 * they need an Ollama server with the embedding model below. The chat model
 * is a stub (chatModelStub.cjs), so the tests do not depend on what a model
 * decides to do.
 */
export const n8nBin = process.env.N8N_E2E_BIN ?? '';

export const e2eEnabled = Boolean(n8nBin && process.env.VALKEY_HOST);

export const describeE2e = e2eEnabled ? describe : describe.skip;

/** Node.js binary that runs n8n. n8n's Ollama chat model fails on Node.js 26, so this can differ from the one running Jest. */
const nodeBin = process.env.N8N_E2E_NODE ?? process.execPath;

export const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
export const embeddingModel = process.env.E2E_EMBEDDING_MODEL ?? 'mxbai-embed-large:latest';
/** Any name: the chat model stub answers for every model. */
export const chatModel = 'chat-model-stub';

export const VALKEY_CREDENTIAL = { valkeyApi: { id: 'e2eValkeyCredent', name: 'E2E Valkey' } };
export const OLLAMA_CREDENTIAL = { ollamaApi: { id: 'e2eOllamaCredent', name: 'E2E Ollama' } };
export const CHAT_MODEL_STUB_CREDENTIAL = {
	ollamaApi: { id: 'e2eChatModelStub', name: 'E2E Chat Model Stub' },
};

const repoRoot = resolve(__dirname, '../..');
const PACKAGE_NAME = 'n8n-nodes-valkey-vector-store';
const COMMAND_TIMEOUT_MS = 300_000;

/** The repo's @langchain/valkey dependency, with a relative file path made absolute. */
function langchainValkeyDependency(): string {
	const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
		dependencies: Record<string, string>;
	};
	const spec = manifest.dependencies['@langchain/valkey'];
	return spec.startsWith('file:') ? `file:${resolve(repoRoot, spec.slice('file:'.length))}` : spec;
}

export interface WorkflowNode {
	id: string;
	name: string;
	type: string;
	typeVersion: number;
	position: [number, number];
	parameters: Record<string, unknown>;
	credentials?: Record<string, { id: string; name: string }>;
}

export interface WorkflowDefinition {
	id: string;
	name: string;
	nodes: WorkflowNode[];
	connections: Record<
		string,
		Record<string, Array<Array<{ node: string; type: string; index: number }>>>
	>;
}

export interface NodeRun {
	executionStatus?: string;
	data?: Record<string, Array<Array<{ json: Record<string, unknown> }> | null>>;
	error?: { message: string; description?: string };
}

export interface ExecutionResult {
	succeeded: boolean;
	errorMessage?: string;
	runData: Record<string, NodeRun[]>;
}

async function freePort(): Promise<number> {
	return await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolvePort(port));
		});
	});
}

/** Waits until a server answers at the URL, for up to ten seconds. */
async function waitForServer(url: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			await fetch(url);
			return;
		} catch {
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
	}
	throw new Error(`No server answered at ${url}`);
}

/**
 * A throwaway n8n instance: its own user folder, database and ports, with
 * this package packed and installed as a community node.
 */
export class N8nTestInstance {
	private constructor(
		private readonly rootFolder: string,
		private readonly env: NodeJS.ProcessEnv,
		private readonly chatModelStub: ChildProcess,
		private readonly chatModelStubUrl: string,
	) {}

	static async start(): Promise<N8nTestInstance> {
		const rootFolder = mkdtempSync(join(tmpdir(), 'n8n-valkey-e2e-'));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			// Jest sets NODE_ENV=test, which makes n8n silence its logger, and
			// `n8n execute` prints the run data through that logger.
			NODE_ENV: 'production',
			N8N_USER_FOLDER: rootFolder,
			N8N_PORT: String(await freePort()),
			N8N_RUNNERS_BROKER_PORT: String(await freePort()),
			N8N_DIAGNOSTICS_ENABLED: 'false',
			N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
			// `n8n execute` prints the run data through the logger at level info.
			N8N_LOG_LEVEL: 'info',
			N8N_LOG_OUTPUT: 'console',
		};
		const stubPort = await freePort();
		const chatModelStub = spawn(
			process.execPath,
			[join(__dirname, 'chatModelStub.cjs'), String(stubPort)],
			{
				stdio: 'inherit',
			},
		);
		const chatModelStubUrl = `http://127.0.0.1:${stubPort}`;
		await waitForServer(chatModelStubUrl);
		const instance = new N8nTestInstance(rootFolder, env, chatModelStub, chatModelStubUrl);
		instance.installPackage();
		instance.importCredentials();
		return instance;
	}

	/**
	 * Installs the packed package the way n8n installs community nodes, without
	 * peer dependencies, so the node uses n8n's own @n8n/ai-utilities and
	 * @langchain/core. A second copy would break n8n's instanceof checks.
	 */
	private installPackage(): void {
		const packFolder = join(this.rootFolder, 'pack');
		mkdirSync(packFolder);
		const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', packFolder], {
			cwd: repoRoot,
			encoding: 'utf8',
		})
			.trim()
			.split('\n')
			.pop();
		const nodesFolder = join(this.rootFolder, '.n8n', 'nodes');
		mkdirSync(nodesFolder, { recursive: true });
		writeFileSync(
			join(nodesFolder, 'package.json'),
			JSON.stringify({
				name: 'installed-nodes',
				private: true,
				dependencies: { [PACKAGE_NAME]: `file:${join(packFolder, tarball ?? '')}` },
				// The packed package depends on @langchain/valkey through a relative
				// file path that is not in the tarball, so it is resolved from the repo.
				overrides: { '@langchain/valkey': langchainValkeyDependency() },
			}),
		);
		execFileSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], {
			cwd: nodesFolder,
			encoding: 'utf8',
			stdio: 'pipe',
		});
	}

	private importCredentials(): void {
		const valkey = testCredentials();
		const credentials = [
			{
				...VALKEY_CREDENTIAL.valkeyApi,
				type: 'valkeyApi',
				data: {
					host: valkey.host,
					port: valkey.port,
					username: valkey.username ?? '',
					password: valkey.password ?? '',
					tls: valkey.tls,
					database: valkey.database,
				},
			},
			{ ...OLLAMA_CREDENTIAL.ollamaApi, type: 'ollamaApi', data: { baseUrl: ollamaBaseUrl } },
			{
				...CHAT_MODEL_STUB_CREDENTIAL.ollamaApi,
				type: 'ollamaApi',
				data: { baseUrl: this.chatModelStubUrl },
			},
		];
		const file = join(this.rootFolder, 'credentials.json');
		writeFileSync(file, JSON.stringify(credentials));
		this.runCli(['import:credentials', `--input=${file}`]);
	}

	importWorkflows(workflows: WorkflowDefinition[]): void {
		const folder = join(this.rootFolder, 'workflows');
		mkdirSync(folder, { recursive: true });
		for (const workflow of workflows) {
			writeFileSync(
				join(folder, `${workflow.id}.json`),
				JSON.stringify({ ...workflow, active: false, settings: {} }),
			);
		}
		this.runCli(['import:workflow', '--separate', `--input=${folder}`]);
	}

	/** Runs a workflow from its Manual Trigger and returns the data of every node. */
	execute(workflow: WorkflowDefinition): ExecutionResult {
		const { stdout, stderr } = this.runCli(
			['execute', `--id=${workflow.id}`, '--rawOutput'],
			false,
		);
		// The run data is printed as indented JSON, so it starts and ends with a brace on its own line.
		const lines = stdout.split('\n');
		const start = lines.indexOf('{');
		const end = lines.indexOf('}', start);
		if (start < 0 || end < 0) {
			throw new Error(
				`No run data from workflow "${workflow.name}".\nstdout:\n${stdout.slice(-3000)}\nstderr:\n${stderr.slice(-3000)}`,
			);
		}
		const run = JSON.parse(lines.slice(start, end + 1).join('\n')) as {
			data: { resultData: { runData: Record<string, NodeRun[]>; error?: { message: string } } };
		};
		const { runData, error } = run.data.resultData;
		return { succeeded: !error, errorMessage: error?.message, runData };
	}

	stop(): void {
		this.chatModelStub.kill();
		rmSync(this.rootFolder, { recursive: true, force: true });
	}

	private runCli(args: string[], requireSuccess = true): { stdout: string; stderr: string } {
		const result = spawnSync(nodeBin, [n8nBin, ...args], {
			env: this.env,
			encoding: 'utf8',
			maxBuffer: 256 * 1024 * 1024,
			timeout: COMMAND_TIMEOUT_MS,
		});
		if (result.error) throw result.error;
		if (requireSuccess && result.status !== 0) {
			throw new Error(
				`n8n ${args[0]} failed with exit code ${result.status}.\n${result.stdout.slice(-3000)}\n${result.stderr.slice(-3000)}`,
			);
		}
		return { stdout: result.stdout, stderr: result.stderr };
	}
}

/** The items a node produced on its last run, for one connection type. */
export function nodeOutput(
	result: ExecutionResult,
	nodeName: string,
	connectionType = 'main',
): Array<Record<string, unknown>> {
	const runs = result.runData[nodeName] ?? [];
	const items = runs[runs.length - 1]?.data?.[connectionType]?.[0] ?? [];
	return items.map((item) => item.json);
}

/** The error message of a node that failed, or of the run if no node reports one. */
export function failureMessage(result: ExecutionResult): string {
	for (const runs of Object.values(result.runData)) {
		for (const run of runs) {
			if (run.error) return [run.error.message, run.error.description].filter(Boolean).join(' ');
		}
	}
	return result.errorMessage ?? '';
}

export { PACKAGE_NAME };
