// gsd-pi Web — Session events SSE route: registers streams with shutdown gate
import {
  collectCurrentProjectOnboardingState,
  getProjectBridgeServiceForCwd,
  requireProjectCwd,
} from "../../../../../src/web/bridge-service.ts";
import { cancelShutdown, registerActiveStream } from "../../../../lib/shutdown-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function encodeSseData(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(request: Request): Promise<Response> {
  // SSE reconnection proves the client is alive — cancel any pending shutdown.
  cancelShutdown();

  const projectCwd = requireProjectCwd(request);
  const bridge = getProjectBridgeServiceForCwd(projectCwd);
  const onboarding = await collectCurrentProjectOnboardingState(projectCwd);

  if (onboarding.locked) {
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    if (new URL(request.url).searchParams.get("require_existing") === "1") {
      // Non-starting subscription mode for embedded RPC callers: never
      // start services; refuse with 409 when the workspace is not running.
      if (!bridge.isStarted()) {
        return Response.json({ error: "workspace not started" }, { status: 409 });
      }
    } else {
      await bridge.ensureStarted();
    }
  } catch {
    // Keep the stream open and let the initial bridge_status event surface the failure state.
  }

  let unsubscribe: (() => void) | null = null;
  let closed = false;
  let deregisterFromGate: (() => void) | null = null;

  const closeWith = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    deregisterFromGate?.();
    deregisterFromGate = null;
    controller.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = bridge.subscribe((event) => {
        if (closed) return;
        controller.enqueue(encodeSseData(event));
      });

      // Register with the shutdown gate so the gate can drain this stream
      // before process.exit(). The gate calls our unsubscriber and sends
      // a sentinel shutdown event so the client knows to stop expecting data.
      deregisterFromGate = registerActiveStream(() => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "shutdown" })}\n\n`),
          );
        } catch {
          // stream may already be closing; ignore enqueue errors
        }
        closeWith(controller);
      });

      request.signal.addEventListener("abort", () => closeWith(controller), { once: true });
    },
    cancel() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      deregisterFromGate?.();
      deregisterFromGate = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
