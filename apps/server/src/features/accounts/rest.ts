import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  LoginRequest,
  LoginResponse,
  SessionResponse,
  SetupAdminRequest,
  SetupAdminResponse,
  SetupStatus,
} from "@orrery/contract";
import { getCookie, setCookie } from "hono/cookie";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import {
  AccountsError,
  type AccountsErrorKind,
  type AccountsService,
  type SessionAccount,
  rejectLogin,
} from "./service.ts";

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
  description:
    "Accepts any non-empty email string and password by shape, and checks them against what is stored; wrong, unknown, or malformed credentials all answer the same 401. On success, sets the session cookie.",
  request: {
    body: { required: true, content: { "application/json": { schema: LoginRequest } } },
  },
  responses: {
    200: {
      description: "Signed in; the session cookie is set",
      content: { "application/json": { schema: LoginResponse } },
    },
    400: problem("The request body is not JSON"),
    401: problem("Wrong, unknown, or malformed email or password"),
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

// Transport details rest.ts owns: the session cookie's name and its fixed attributes
// (the service decides lifetime and Secure), and every error kind's HTTP status.
const SESSION_COOKIE = "orrery_session";
const fixedCookieAttributes = { httpOnly: true, sameSite: "Lax", path: "/" } as const;

const statusFor = {
  setup_unavailable: 403,
  invalid_secret: 401,
  setup_complete: 409,
  invalid_credentials: 401,
} as const satisfies Record<AccountsErrorKind, number>;

// An accounts error as its Problem: the error kind is the code, its message the title.
const failure = (c: Context, error: AccountsError) =>
  problemResponse(c, { status: statusFor[error.kind], code: error.kind, title: error.message });

// Thin: call the service, map the result to HTTP. No rules here.
export function createAccountsRest(service: AccountsService) {
  const policy = service.sessionPolicy();
  // The session route and every borrowing feature resolve sessions the same way.
  const readSession = createSessionReader(service);

  // Validation failures answer as a validation_failed Problem, like every other error.
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(setupStatus, async (c) => c.json(await service.setupStatus(), 200));

  app.openapi(setupAdmin, async (c) => {
    try {
      return c.json(await service.setupAdmin(c.req.valid("json")), 201);
    } catch (error) {
      // The service only throws the three setup kinds here; anything else is a bug.
      if (error instanceof AccountsError && error.kind !== "invalid_credentials") {
        return failure(c, error);
      }
      throw error;
    }
  });

  app.openapi(
    login,
    async (c) => {
      try {
        const { token, email } = await service.login(c.req.valid("json"));
        setCookie(c, SESSION_COOKIE, token, {
          ...fixedCookieAttributes,
          secure: policy.secure,
          maxAge: policy.maxAgeSeconds,
        });
        return c.json({ email }, 200);
      } catch (error) {
        // The service decides that login failures are uniform: whatever went wrong, the
        // only error kind login can produce is invalid_credentials.
        if (error instanceof AccountsError && error.kind === "invalid_credentials") {
          return problemResponse(c, {
            status: statusFor.invalid_credentials,
            code: error.kind,
            title: error.message,
          });
        }
        throw error;
      }
    },
    // The service decides that a malformed or overlong attempt is wrong credentials too.
    (result, c) => {
      if (result.success) return undefined;
      const rejected = rejectLogin();
      return problemResponse(c, {
        status: statusFor.invalid_credentials,
        code: rejected.kind,
        title: rejected.message,
      });
    },
  );

  app.openapi(session, async (c) => {
    const account = await readSession(c);
    if (account === null) {
      return problemResponse(c, { status: 401, code: "not_signed_in", title: "Not signed in." });
    }
    // The declared resource is the SessionResponse, not the service's fuller account:
    // the client learns its email and whether that address is verified, nothing else.
    return c.json({ email: account.email, emailVerified: account.emailVerifiedAt !== null }, 200);
  });

  return app;
}

// Resolves the signed-in account behind a request's session cookie, or null when the
// request is not signed in. The cookie is accounts' transport detail: other features
// borrow this reader through the feature's index instead of learning the cookie's name.
export type SessionReader = (c: Context) => Promise<SessionAccount | null>;

export function createSessionReader(service: AccountsService): SessionReader {
  return async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    return token === undefined ? null : service.session(token);
  };
}
