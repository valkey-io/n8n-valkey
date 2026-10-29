import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{
		files: ['package.json'],
		rules: {
			// The node needs @langchain/valkey and @valkey/valkey-glide at run time.
			// Glide ships a native binary per platform, so it cannot be bundled into
			// dist. The package is self-hosted only (see the OpenSpec change
			// add-valkey-vector-store-node, proposal "Dependencies").
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
			// @langchain/core and @n8n/ai-utilities must resolve to the copies the
			// n8n host already loads: createVectorStoreNode and the Document,
			// Embeddings and VectorStore classes are shared with n8n's AI nodes, so
			// a second bundled copy would break instanceof checks between them.
			// The rule only knows about n8n-workflow and @n8n/ai-node-sdk.
			'@n8n/community-nodes/valid-peer-dependencies': 'off',
		},
	},
	{
		files: ['credentials/ValkeyApi.credentials.ts'],
		rules: {
			// Valkey is not HTTP, so the credential cannot have a declarative `test`.
			// The node tests it through `testedBy: 'valkeyApiConnectionTest'`, but the
			// node's description is built by createVectorStoreNode, which this rule
			// cannot see through.
			'@n8n/community-nodes/credential-test-required': 'off',
		},
	},
	{
		files: ['nodes/ValkeyVectorStore/shared/**/*.ts'],
		rules: {
			// Helpers have no node reference. They throw ValkeyUserError or pass
			// server errors through unchanged; the node file converts every error
			// into a NodeOperationError at the boundary (toNodeError).
			'@n8n/community-nodes/require-node-api-error': 'off',
		},
	},
];
