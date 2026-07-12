import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  currentToken,
  identityFromAuth,
  loginId,
  loginLabel,
  UNSUPPORTED_LOGIN_HELP,
} from "../src/app/grok-credentials.js";

const OIDC = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const LEGACY = "https://accounts.x.ai/sign-in";

/** Build a fake JWT with the given payload (header/sig are ignored). */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

test("currentToken prefers the OIDC scope, falls back to legacy", () => {
  assert.equal(currentToken({ [OIDC]: { key: "a" }, [LEGACY]: { key: "b" } }), "a");
  assert.equal(currentToken({ [LEGACY]: { key: "b" } }), "b");
  assert.equal(currentToken({}), undefined);
});

test("loginId is stable and distinguishes different tokens", () => {
  const a = { [OIDC]: { key: "token-aaaa" } };
  const b = { [OIDC]: { key: "token-bbbb" } };
  assert.equal(loginId(a), loginId({ [OIDC]: { key: "token-aaaa" } })); // stable
  assert.notEqual(loginId(a), loginId(b)); // distinct
  assert.equal(loginId({}), undefined);
});

test("identityFromAuth decodes email from the sign-in JWT", () => {
  const auth = { [OIDC]: { key: jwt({ email: "dev@example.com", name: "Dev" }) } };
  const id = identityFromAuth(auth);
  assert.equal(id.email, "dev@example.com");
  assert.equal(id.name, "Dev");
  // Non-email preferred_username is ignored for the email field.
  assert.equal(identityFromAuth({ [OIDC]: { key: jwt({ preferred_username: "handle" }) } }).email, undefined);
});

test("identityFromAuth prefers auth-entry email when JWT has no email claim", () => {
  // Real grok login tokens often omit email; CLI stores it on the entry.
  const auth = {
    [OIDC]: {
      key: jwt({ sub: "user-1", principal_id: "user-1" }),
      email: "uriel@example.com",
      first_name: "Chris",
      last_name: "Jackson",
    },
  };
  const id = identityFromAuth(auth);
  assert.equal(id.email, "uriel@example.com");
  assert.equal(id.name, "Chris Jackson");
  assert.equal(loginLabel(auth), "uriel@example.com");
});

test("identityFromAuth entry email wins over JWT email", () => {
  const auth = {
    [OIDC]: {
      key: jwt({ email: "old@example.com" }),
      email: "fresh@example.com",
    },
  };
  assert.equal(identityFromAuth(auth).email, "fresh@example.com");
});

test("UNSUPPORTED_LOGIN_HELP mentions grok login", () => {
  assert.match(UNSUPPORTED_LOGIN_HELP, /grok login/i);
});
