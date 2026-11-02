import { DurableObject } from 'cloudflare:workers';

interface Env {
	ROOM: DurableObjectNamespace<Room>;
	GAME_AUTH_SECRET: string;
}

interface SocketAttachment {
	gameId: number;
	authenticated: boolean;
}

interface BroadcastPayload {
	token: string;
	message: string;
}

function fromBase64Url(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function validateToken(masterSecret: string, gameId: number, suppliedToken: string): Promise<boolean> {
	try {
		const tokenBytes = fromBase64Url(suppliedToken);
		// HMAC-SHA256 produces exactly 32 bytes
		if (tokenBytes.length !== 32) {
			return false;
		}
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(masterSecret),
			{
				name: 'HMAC',
				hash: 'SHA-256',
			},
			false,
			['verify'],
		);
		return await crypto.subtle.verify('HMAC', key, tokenBytes, encoder.encode(`game:${gameId}`));
	} catch {
		return false;
	}
}

export class Room extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/room\/(\d+)$/);

		if (!match) {
			return new Response('Invalid room ID', { status: 400 });
		}

		const gameId = Number(match[1]);

		if (!Number.isSafeInteger(gameId)) {
			return new Response('Invalid room ID', { status: 400 });
		}

		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected WebSocket', { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		// All connections start unauthenticated.
		this.ctx.acceptWebSocket(server);

		server.serializeAttachment({
			gameId,
			authenticated: false,
		} satisfies SocketAttachment);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async broadcast(data: string): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(data);
			} catch {}
		}
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== 'string' || message.length > 16384) {
			ws.close(1003, 'Invalid message');
			return;
		}

		let payload: any;
		try {
			payload = JSON.parse(message);
		} catch {
			ws.close(1003, 'Invalid JSON');
			return;
		}
		const attachment = ws.deserializeAttachment() as SocketAttachment | null;
		if (!attachment) {
			ws.close(1008, 'Missing connection state');
			return;
		}

		// send auth key as first message
		if (!attachment.authenticated) {
			if (payload.type !== 'authenticate' || typeof payload.token !== 'string') {
				ws.close(1008, 'Authentication required');
				return;
			}
			const valid = await validateToken(this.env.GAME_AUTH_SECRET, attachment.gameId, payload.token);
			if (!valid) {
				ws.close(1008, 'Invalid authentication');
				return;
			}

			ws.serializeAttachment({
				...attachment,
				authenticated: true,
			} satisfies SocketAttachment);

			ws.send(
				JSON.stringify({
					type: 'authenticated',
				}),
			);

			return;
		}

		if (payload.type !== 'event' || typeof payload.message !== 'string') {
			return;
		}
		await this.broadcast(payload.message);
	}

	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {}

	webSocketError(ws: WebSocket, error: unknown): void {}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// normal websocket connections
		const roomMatch = url.pathname.match(/^\/room\/(\d+)$/);
		if (roomMatch) {
			const gameId = Number(roomMatch[1]);
			if (!Number.isSafeInteger(gameId)) {
				return new Response('Invalid game ID', { status: 400 });
			}
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('Expected WebSocket', { status: 426 });
			}
			const room = env.ROOM.getByName(String(gameId));
			return room.fetch(request);
		}

		// broadcasts from server
		const broadcastMatch = url.pathname.match(/^\/broadcast\/room\/(\d+)$/);
		if (broadcastMatch && request.method === 'POST') {
			const gameId = Number(broadcastMatch[1]);
			if (!Number.isSafeInteger(gameId)) {
				return new Response('Invalid game ID', { status: 400 });
			}
			let payload: BroadcastPayload;
			try {
				payload = (await request.json()) as BroadcastPayload;
			} catch {
				return new Response('Invalid JSON', { status: 400 });
			}
			if (typeof payload.token !== 'string' || typeof payload.message !== 'string') {
				return new Response('Invalid payload', { status: 400 });
			}
			const valid = await validateToken(env.GAME_AUTH_SECRET, gameId, payload.token);
			if (!valid) {
				return new Response('Unauthorized', { status: 401 });
			}
			const room = env.ROOM.getByName(String(gameId));
			await room.broadcast(payload.message);
			return new Response(null, { status: 204 });
		}

		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
