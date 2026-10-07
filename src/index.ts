import { DurableObject } from 'cloudflare:workers';

export class Room extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	public handleConnect(playerId: null | number): Response {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.ctx.acceptWebSocket(server);

		if (playerId != null) {
			server.serializeAttachment({
				playerId,
			});
		}

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async broadcast(data: string): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(data);
			} catch {
				// Connection may have disappeared.
			}
		}
	}

	// clients never send messages over sockets
	webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer) {
		return;
	}

	// don't need any special handling yet. Maybe ask them to reconnect?
	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		return;
	}
}

type Payload = {
	message: string;
};

export default {
	async fetch(request: Request, env: Env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/room/')) {
			const roomId = url.pathname.split('/')[2];
			if (roomId == null || roomId === '') {
				return new Response('Missing game ID', { status: 400 });
			}
			if (request.headers.get('Upgrade') !== 'websocket') {
				return new Response('Expected WebSocket', { status: 426 });
			}
			const room = env.ROOM.getByName(roomId);
			return room.handleConnect(null);
		} else if (url.pathname.startsWith('/broadcast/room/') && request.method === 'POST') {
			// TODO: Validate token
			const roomId = url.pathname.split('/')[3];
			if (roomId == null || roomId === '') {
				return new Response('Missing game ID', { status: 400 });
			}
			const payload: Payload = await request.json();
			const room = env.ROOM.getByName(roomId);
			await room.broadcast(payload.message);
			return new Response(null, { status: 204 });
		} else {
			return new Response('Not found', { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;
