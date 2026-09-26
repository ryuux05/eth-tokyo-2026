import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceCOrigin } from "../demo-service-c/origin.js";

test("Service C uses the requested trusted Vercel domain for the authentication audience", () => {
  const env = { VERCEL: "1", VERCEL_ENV: "production", VERCEL_URL: "build.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "service-c.vercel.app", SERVICE_C_ORIGIN: "https://old-preview.vercel.app" };
  assert.equal(serviceCOrigin(env, "service-c.vercel.app"), "https://service-c.vercel.app");
  assert.equal(serviceCOrigin(env, "build.vercel.app"), "https://build.vercel.app");
  assert.throws(() => serviceCOrigin(env, "evil.example"), /configured Service C origin/);
  assert.throws(() => serviceCOrigin({ ...env, VERCEL_ENV: "preview" }, "service-c.vercel.app"), /configured Service C origin/);
  assert.equal(serviceCOrigin({}, "127.0.0.1:8807"), "http://127.0.0.1:8807");
  assert.throws(() => serviceCOrigin({ VERCEL: "1", SERVICE_C_ORIGIN: "http://127.0.0.1:8807" }), /canonical HTTPS/);
});
