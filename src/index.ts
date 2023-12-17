import { Ai } from '@cloudflare/ai';
import { Hono } from 'hono';
import { Conversation } from './type';

type Bindings = {
	AI: Ai;
	DB: D1Database;
	VECTOR_INDEX: any;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', async (c) => {
	const ai = new Ai(c.env.AI);

	const request = await c.req.text();

	const embeddings = await ai.run('@cf/baai/bge-base-en-v1.5', { text: request });
	const vectors = embeddings.data[0];

	const SIMILARITY_CUTOFF = 0.75;
	const vectorQuery = await c.env.VECTOR_INDEX.query(vectors, { topK: 1 });
	const vecIds = vectorQuery.matches.filter((vec: { score: number }) => vec.score > SIMILARITY_CUTOFF).map((vec: Conversation) => vec.id);

	let chats: Array<Conversation> = [];

	if (vecIds.length) {
		const query = `SELECT * FROM conversations WHERE id IN (${vecIds.join(', ')})`;
		const { results } = (await c.env.DB.prepare(query).bind().all()) as { results: Array<Conversation> };

		if (results) {
			chats = results.map((vec: Conversation) => {
				console.log(vec.request);
				return {
					id: vec.id,
					request: vec.request,
					response: vec.response,
				};
			});
		}
	}

	const contextMessage = chats.length ? `Context:\n${chats.map((chat) => `> ${chat.request}\n> ${chat.response}`).join('\n')}` : '';

	const systemPromptTR = `Sen bir sigorta çalışansın. Soruyu cevaplarken veya yanıt verirken, sağlanan bağlamı, sağlanırsa ve ilgiliyse kullanın.`;

	const { response: answer } = await ai.run('@cf/mistral/mistral-7b-instruct-v0.1', {
		messages: [

			...(chats.length ? [{ role: 'system', content: contextMessage }] : []),
			{ role: 'system', content: systemPromptTR },
			{ role: 'user', content: request },
		],
	});

	return c.text(answer);
});

app.onError((err: any, c) => {
	return c.text('Error occured' + err);
});

app.post('/insert', async (c) => {
	const ai = new Ai(c.env.AI);

	const { request, response } = await c.req.json();
	if (!request || !response) {
		return c.text('Missing request/response', 400);
	}

	const { results } = await c.env.DB.prepare('INSERT INTO conversations (request, response) VALUES (?, ?) RETURNING *')
		.bind(request, response)
		.run();

	const record = results.length ? results[0] : null;

	if (!record) return c.text('Failed to create chat history', 500);

	const { data } = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [request] });
	const values = data[0];

	if (!values) return c.text('Failed to generate vector embedding', 500);

	const { id } = record;
	const inserted = await c.env.VECTOR_INDEX.upsert([
		{
			id: id?.toString(),
			values,
		},
	]);

	return c.json({ id, request, inserted });
});

export default app;
