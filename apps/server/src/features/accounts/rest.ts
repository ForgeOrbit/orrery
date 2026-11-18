import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  LoginRequest,
  LoginResponse,
  Problem,
  SessionResponse,
  SetupAdminRequest,
  SetupAdminResponse,
  SetupStatus,
} from "@orrery/contract";
import { getCookie, setCookie } from "hono/cookie";
import {
  AccountsError,
  statusFor,
  type AccountsErrorKind,
  type AccountsService,
} from "./service.ts";

const problem = (description: string) => ({
  description,
  content: { "application/json": { schema: Problem } },
});

const setupStatus = createRoute({
  method: "get",
  path: "/api/setup/status",
  summary: "Whether initial setup (creating the first administrator) is complete",
  responses: {
    200: { description: "Setup status", content: { "application/json": { schema: SetupStatus } } },
  },
});

const setupAdmin = createRoute({
  method: "post",
  path: "/api/setup/admin",
  summary: "Create the first system administrator and close setup",
  description:
    "Requires the deployment-supplied bootstrap secret. Creates the administrator, its personal workspace, and the record that closes bootstrap, in one transaction. Exactly one attempt can ever succeed.",
  request: {
    body: { required: true, content: { "application/json": { schema: SetupAdminRequest } } },
  },
  responses: {
    201: {
      description: "Administrator created; setup is closed",
      content: { "application/json": { schema: SetupAdminResponse } },
    },
    400: problem("Invalid secret, email, or password"),
    401: problem("The setup secret is wrong"),
    403: problem("No setup secret is configured on this installation"),
    409: problem("Setup is already complete"),
  },
});

const login = createRoute({
  method: "post",
  path: "/api/auth/login",
  summary: "Sign in with email and password",
  description: "On success, sets the HttpOnly session cookie named by the session policy.",
  request: {
    body: { required: true, content: { "application/json": { schema: LoginRequest } } },
  },
  responses: {
    200: {
      description: "Signed in; the session cookie is set",
      content: { "application/json": { schema: LoginResponse } },
    },
    400: problem("Invalid email or password shape"),
    401: problem("Wrong email or password"),
  },
});

const session = createRoute({
  method: "get",
  path: "/api/auth/session",
  summary: "The account behind the browser's session cookie",
  responses: {
    200: { description: "Signed in", content: { "application/json": { schema: SessionResponse } } },
    401: problem("No valid session"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [setupStatus, setupAdmin, login, session];

// The status for an error kind comes from the service's map, never from here.
const statusForKind = <K extends AccountsErrorKind>(kind: K) => statusFor[kind];

// Thin: call the service, map the result to HTTP. No rules here.
export function createAccountsRest(service: AccountsService) {
  const cookie = service.sessionPolicy();

  const app = new OpenAPIHono({
    // Turn validation failures into the same Problem shape as every other error.
    defaultHook: (result, c) => {
      if (result.success) return undefined;
      return c.json({ message: result.error.issues[0]?.message ?? "Invalid request." }, 400);
    },
  });

  app.openapi(setupStatus, async (c) => c.json(await service.setupStatus(), 200));

  app.openapi(setupAdmin, async (c) => {
    try {
      return c.json(await service.setupAdmin(c.req.valid("json")), 201);
    } catch (error) {
      if (error instanceof AccountsError)
        return c.json({ message: error.message }, statusForKind(error.kind));
      throw error;
    }
  });

  app.openapi(login, async (c) => {
    try {
      const { token, email } = await service.login(c.req.valid("json"));
      setCookie(c, cookie.name, token, {
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        path: cookie.path,
        secure: cookie.secure,
        maxAge: cookie.maxAgeSeconds,
      });
      return c.json({ email }, 200);
    } catch (error) {
      // The service decides that login failures are uniform: whatever went wrong, the
      // only error kind login can produce is invalid_credentials.
      if (error instanceof AccountsError && error.kind === "invalid_credentials") {
        return c.json({ message: error.message }, statusForKind(error.kind));
      }
      throw error;
    }
  });

  app.openapi(session, async (c) => {
    const token = getCookie(c, cookie.name);
    const account = token === undefined ? null : await service.session(token);
    if (account === null) return c.json({ message: "Not signed in." }, 401);
    return c.json(account, 200);
  });

  return app;
}
