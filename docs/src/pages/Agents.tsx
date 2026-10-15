import { Code, Callout, Endpoint, Params } from "../components";

export default function Agents() {
  return (
    <>
      <div className="eyebrow">Core resources</div>
      <h1>Agents</h1>
      <p className="lead">
        An agent is a reusable persona — instructions, a voice, and the
        connections it runs on. Create it once, then use it for many calls.
      </p>

      <h2 id="create">Create an agent</h2>
      <Endpoint method="POST" path="/v1/agents" />
      <Params rows={[
        { name: "name", type: "string", required: true, desc: "The name the agent gives on the call." },
        { name: "instructions", type: "string", required: true, desc: "System prompt — the agent's goal and behaviour." },
        { name: "company", type: "string", desc: "Org the agent represents." },
        { name: "first_message", type: "string", desc: "The first line spoken when the call connects." },
        { name: "voice_id", type: "string", desc: "TTS voice override for this agent." },
        { name: "llm_model", type: "string", desc: "Model override (e.g. llama-3.1-8b-instant)." },
        { name: "stt_connection_id", type: "string", required: true, desc: "Speech-to-text connection." },
        { name: "tts_connection_id", type: "string", required: true, desc: "Text-to-speech connection." },
        { name: "llm_connection_id", type: "string", required: true, desc: "Language-model connection." },
        { name: "telephony_connection_id", type: "string", desc: "Required to place or receive phone calls." },
        { name: "provider_settings", type: "object", desc: "Per-leg tunables: { tts: { model, emotion, speed }, llm: { model }, language }." },
      ]} />
      <Code tabs={[{ label: "cURL", lang: "bash", code: `curl -X POST http://localhost:8000/v1/agents \\
  -H "Authorization: Bearer $OFFHOOK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Alex",
    "company": "Acme Clinic",
    "instructions": "Confirm the dental appointment; offer to reschedule if needed.",
    "first_message": "Hi, this is Alex from Acme Clinic.",
    "stt_connection_id": "conn_stt",
    "tts_connection_id": "conn_tts",
    "llm_connection_id": "conn_llm",
    "telephony_connection_id": "conn_tel",
    "provider_settings": {
      "tts": { "model": "sonic-3", "emotion": "warm", "speed": 1.0 },
      "language": "en"
    }
  }'` }, { label: "Response", lang: "json", code: `{
  "id": "agt_…",
  "name": "Alex",
  "instructions": "Confirm the dental appointment…",
  "created_at": "2026-06-20T10:00:00Z"
}` }]} />
      <Callout kind="note">
        Each connection must belong to your tenant and match the expected kind, or
        the request returns <code>422</code>.
      </Callout>

      <h2 id="list">List, retrieve &amp; delete</h2>
      <Endpoint method="GET" path="/v1/agents" />
      <Endpoint method="GET" path="/v1/agents/{id}" />
      <Endpoint method="DELETE" path="/v1/agents/{id}" />
    </>
  );
}
