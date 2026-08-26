// Alias for Hermes/OpenAI-compatible clients using top-level /v2 prefix.
// Keeps V2 default behavior: all token savers disabled unless opted in.
export { POST, GET } from "@/app/api/v2/chat/completions/route";
