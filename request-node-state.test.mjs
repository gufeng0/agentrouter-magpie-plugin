import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareRequest } from "./request.mjs";

const url = "https://agentrouter.org/v1/responses";

function request(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("resource-bound Azure state is dropped while the conversation stays", async () => {
  const body = {
    model: "gpt-6-astra",
    store: true,
    previous_response_id: "resp_from_another_resource",
    input: [
      {
        type: "reasoning",
        id: "rs_old",
        summary: [],
        encrypted_content: "opaque",
      },
      {
        type: "message",
        id: "msg_old",
        role: "assistant",
        content: [{ type: "output_text", id: "part_old", text: "Checking", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc_old",
        call_id: "call_old",
        name: "lookup",
        arguments: "{\"id\":\"nested\"}",
      },
      {
        type: "function_call_output",
        id: "fco_old",
        call_id: "call_old",
        output: "{\"id\":\"result\"}",
      },
      { type: "message", id: "msg_user", role: "user", content: "hello" },
    ],
  };
  const out = await prepareRequest(url, request(body), { portableResponses: false, textFilter: null, stripNodeState: true });
  const sent = JSON.parse(out.body);
  assert.equal("previous_response_id" in sent, false);
  assert.equal(sent.store, false);
  assert.deepEqual(sent.input.map((item) => item.type), ["message", "function_call", "function_call_output", "message"]);
  assert.equal(sent.input[0].id, undefined);
  assert.equal(sent.input[0].content[0].id, undefined);
  assert.equal(sent.input[0].content[0].text, "Checking");
  assert.equal(sent.input[1].id, undefined);
  assert.equal(sent.input[1].call_id, "call_old");
  assert.equal(sent.input[1].arguments, "{\"id\":\"nested\"}");
  assert.equal(sent.input[2].id, undefined);
  assert.equal(sent.input[2].call_id, "call_old");
});

test("without the switch the body is forwarded untouched", async () => {
  const body = { store: true, previous_response_id: "resp_remote", input: [{ type: "message", id: "msg_1", role: "assistant", content: "hi" }] };
  const init = request(body);
  const out = await prepareRequest(url, init, { portableResponses: false, textFilter: null, stripNodeState: false });
  assert.equal(out, init);
});