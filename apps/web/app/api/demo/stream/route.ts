import { clients, ensureStarted } from '@/lib/engine/demoRuntime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  ensureStarted();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const client = { write: (chunk: string) => controller.enqueue(enc.encode(chunk)) };
      controller.enqueue(enc.encode('event: hello\ndata: {}\n\n'));
      clients.add(client);
      const keepAlive = setInterval(() => {
        try {
          client.write(': ping\n\n');
        } catch {
          cleanup();
        }
      }, 20_000);
      cleanup = () => {
        clearInterval(keepAlive);
        clients.delete(client);
      };
      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}
