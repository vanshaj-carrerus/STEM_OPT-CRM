process.env.APP_SECRET ??= "test-secret-test-secret-test-secret-123456";
// In Atlas mode (DB_TEST_ON_ATLAS=1) tests/helpers/db.ts loads the real cluster URI from .env.local itself,
// so a placeholder must not be set first (loadEnvFile never overrides existing variables).
if (process.env.DB_TEST_ON_ATLAS !== "1") process.env.MONGODB_URI ??= "mongodb://127.0.0.1:1/unused";
(process.env as Record<string, string>).NODE_ENV = "test";
