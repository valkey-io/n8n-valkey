// A stand-in for Ollama's /api/chat, so the end-to-end tests do not depend on
// what a chat model decides to do. It runs in its own process because the
// harness runs n8n with spawnSync, which blocks the Jest process.
//
// - With tools and no tool result yet, it calls the first tool with the user's
//   question as its input, the way the AI Agent's tool expects.
// - Otherwise it returns a fixed answer.
//
// Usage: node chatModelStub.cjs <port>
const { createServer } = require('node:http');

const port = Number(process.argv[2]);
const ANSWER = 'Answer from the chat model stub.';

function lastUserMessage(messages) {
	const user = messages.filter((message) => message.role === 'user');
	return user.length > 0 ? String(user[user.length - 1].content) : '';
}

function reply(request) {
	const messages = request.messages ?? [];
	const tools = request.tools ?? [];
	const hasToolResult = messages.some((message) => message.role === 'tool');
	if (tools.length > 0 && !hasToolResult) {
		return {
			role: 'assistant',
			content: '',
			tool_calls: [
				{
					function: {
						name: tools[0].function.name,
						arguments: { input: lastUserMessage(messages) },
					},
				},
			],
		};
	}
	return { role: 'assistant', content: ANSWER };
}

const server = createServer((req, res) => {
	if (req.method === 'GET' && (req.url === '/' || req.url === '/api/tags')) {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(req.url === '/' ? 'Ollama is running' : JSON.stringify({ models: [] }));
		return;
	}
	if (req.method !== 'POST' || req.url !== '/api/chat') {
		res.writeHead(404);
		res.end();
		return;
	}
	let body = '';
	req.on('data', (chunk) => (body += chunk));
	req.on('end', () => {
		const request = JSON.parse(body);
		const created_at = new Date().toISOString();
		const message = reply(request);
		const lines = [
			{ model: request.model, created_at, message, done: false },
			{
				model: request.model,
				created_at,
				message: { role: 'assistant', content: '' },
				done: true,
				done_reason: 'stop',
				prompt_eval_count: 0,
				eval_count: 0,
			},
		];
		if (request.stream === false) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ...lines[1], message }));
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
		res.end(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
	});
});

server.listen(port, '127.0.0.1');
