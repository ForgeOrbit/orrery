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
import type { AccountsErrorKind } from "./service.ts";
import { AccountsError, SESSION_COOKIE, SESSION_TTL, type AccountsService } from "./service.ts";

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
    409: problem("Setup is already complete, or the email is taken"),
  },
});

const login = createRoute({
  method: "post",
  path: "/api/auth/login",
  summary: "Sign in with email and password",
  description: "On success, sets the HttpOnly orrery_session cookie.",
  request: {
    body: { required: true, content: { "application/json": { schema: LoginRequest } } },
  },
  responses: {
    200: {
      description: "Signed in; the session cookie is set",
      content: { "application/json": { schema: LoginResponse } },
    },
    400: problem("Invalid email or password"),
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

const statusFor: Record<AccountsErrorKind, 401 | 403 | 409> = {
  setup_unavailable: 403,
  invalid_secret: 401,
  setup_complete: 409,
  email_taken: 409,
  invalid_credentials: 401,
};

// Thin: call the service, map the result to HTTP. No rules here.
export function createAccountsRest(service: AccountsService, cookieOptions: { secure: boolean }) {
  const app = new OpenAPIHono({
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
        return c.json({ message: error.message }, statusFor[error.kind]);
      throw error;
    }
  });

  app.openapi(login, async (c) => {
    try {
      const { token, email } = await service.login(c.req.valid("json"));
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        secure: cookieOptions.secure,
        maxAge: SESSION_TTL,
      });
      return c.json({ email }, 200);
    } catch (error) {
      // Login can only be refused as invalid credentials (the service answers an
      // unknown email and a wrong password identically).
      if (error instanceof AccountsError) return c.json({ message: error.message }, 401);
      throw error;
    }
  });

  app.openapi(session, async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const account = token === undefined ? null : await service.session(token);
    if (account === null) return c.json({ message: "Not signed in." }, 401);
    return c.json(account, 200);
  });

  return app;
}
