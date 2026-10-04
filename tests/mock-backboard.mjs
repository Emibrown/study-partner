import { randomUUID } from "node:crypto";
const assistants = new Map();
const documents = new Map();
const threads = new Map();
export const fixtureNotes =
  "The fictional solar cart stores energy in a battery. A panel collects sunlight. A motor turns the wheels. A switch controls the motor. A fuse protects the circuit.";
export function practiceFixture() {
  return [
    [
      "Where does the solar cart store energy?",
      ["Battery", "Panel", "Wheels", "Fuse"],
      "The fictional solar cart stores energy in a battery.",
    ],
    [
      "What does the panel collect?",
      ["Sunlight", "Water", "Sound", "Soil"],
      "A panel collects sunlight.",
    ],
    [
      "What turns the wheels?",
      ["Motor", "Fuse", "Switch", "Panel"],
      "A motor turns the wheels.",
    ],
    [
      "What controls the motor?",
      ["Switch", "Wheel", "Sunlight", "Fuse"],
      "A switch controls the motor.",
    ],
    [
      "What protects the circuit?",
      ["Fuse", "Panel", "Wheel", "Motor"],
      "A fuse protects the circuit.",
    ],
  ].map(([question, choices, evidence]) => ({
    question,
    choices,
    correct: 0,
    explanation: evidence,
    topic: choices[0],
    evidence,
  }));
}
export async function mockBackboard(input, init = {}) {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.slice(4).split("/").filter(Boolean);
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
  if (path[0] === "assistants" && path.length === 1) {
    if (method === "GET") return Response.json([...assistants.values()]);
    const assistant_id = randomUUID();
    assistants.set(assistant_id, { assistant_id, ...body });
    return Response.json({ assistant_id });
  }
  if (path[0] === "assistants" && path.length === 2) {
    if (method === "DELETE") {
      assistants.delete(path[1]);
      return Response.json({});
    }
    return assistants.has(path[1])
      ? Response.json(assistants.get(path[1]))
      : Response.json({}, { status: 404 });
  }
  if (path[0] === "assistants" && path[2] === "memories")
    return Response.json({ success: true });
  if (path[0] === "assistants" && path[2] === "documents") {
    if (method === "GET")
      return Response.json(
        [...documents.values()].filter((d) => d.assistant === path[1]),
      );
    const document_id = randomUUID();
    documents.set(document_id, {
      document_id,
      assistant: path[1],
      status: "indexed",
    });
    return Response.json({ document_id, status: "pending" });
  }
  if (path[0] === "documents") {
    if (method === "DELETE") {
      documents.delete(path[1]);
      return Response.json({});
    }
    return Response.json(documents.get(path[1]) ?? { status: "error" });
  }
  if (path[0] === "assistants" && path[2] === "threads") {
    if (method === "GET")
      return Response.json(
        [...threads.values()].filter((t) => t.assistant === path[1]),
      );
    const thread_id = randomUUID();
    threads.set(thread_id, { thread_id, assistant: path[1], messages: [] });
    return Response.json({ thread_id });
  }
  if (path[0] === "threads" && path[1] === "messages") {
    if (
      body.model_name !== "qwen/qwen3-30b-a3b-instruct-2507" ||
      body.llm_provider !== "openrouter" ||
      body.web_search !== "off" ||
      body.tools.length
    )
      return Response.json({}, { status: 400 });
    const run_id = randomUUID(),
      message_id = randomUUID();
    const content = body.json_output
      ? JSON.stringify({ questions: practiceFixture() })
      : "The fictional solar cart stores energy in a battery. The panel collects sunlight, and the motor turns the wheels.";
    threads.get(body.thread_id).messages.push({
      message_id,
      role: "assistant",
      content,
      status: "completed",
      run_id,
    });
    const events = [
      {
        type: "run_started",
        run_id,
        message_id,
        provider: "openrouter",
        model_name: body.model_name,
      },
      { type: "content_streaming", content: content.slice(0, 35) },
      { type: "content_streaming", content: content.slice(35) },
      { type: "run_ended", status: "completed" },
    ];
    if (body.content === "Slow fixture response") {
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(events[0])}\n\n`),
            );
            await new Promise((resolve) => setTimeout(resolve, 1500));
            for (const event of events.slice(1))
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return new Response(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }
  if (path[0] === "threads") {
    if (path[2] === "runs") return Response.json({ cancelled: true });
    if (method === "DELETE") {
      threads.delete(path[1]);
      return Response.json({});
    }
    return Response.json(threads.get(path[1]) ?? { messages: [] });
  }
  throw new Error("Unexpected mock provider route");
}
