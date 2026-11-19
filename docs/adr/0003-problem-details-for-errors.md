---
status: accepted
---

# Answer every REST error with RFC 9457 Problem Details

People, the web app and agents all need to tell one failure from another without parsing prose. Every REST error under `/api/` is therefore an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details object, served as `application/problem+json` with the real HTTP status. A success answers with the resource itself and no envelope; OpenAPI already describes each success shape.

A Problem carries `type`, `title`, `status` and a `code` extension: a stable snake_case reason such as `setup_complete` or `invalid_credentials`. Clients branch on `code`, or on `type`, which is the same reason as a URI. `type` is `urn:orrery:problem:<code>`. A URN fits because every installation is self-hosted, so there is no domain to point at. `title` is the human summary of that code, and `detail` is optional text about one occurrence. A validation failure is `validation_failed`, with an `errors` extension: one `{ pointer, detail }` per invalid field, where `pointer` is an RFC 6901 JSON Pointer into the request body.

A Problem never contains internals: no stack traces, no database messages, no input values beyond what the client sent. `/healthz` and `/readyz` keep their plain bodies, because probes and the portability contract depend on them. MCP keeps its own error model.

We considered JSend. It wraps every success in `{ status, data }`, which repeats the HTTP status and adds `.data` unwrapping for every client. It is an informal convention rather than a standard, and it defines no error codes. RFC 9457 is an IETF standard that API tooling and other server languages already support, which suits the portability rule in AGENTS.md.

`apps/server/src/platform/problem.ts` is the only place that builds Problem responses. `apps/server/src/features/routes.test.ts` fails when an API route declares an error response that is not a Problem.
