/** Zabezpieczenie testów na bazie: tylko osobna baza testowa (patrz models.stage8.integration.test.js). */
export function resolveTestDb(env = process.env) {
  const uri = env.MONGODB_TEST_URI;
  if (!uri) return { ok: false, reason: "brak MONGODB_TEST_URI (testy wymagają osobnej bazy testowej)" };
  if (env.MONGODB_URI && uri === env.MONGODB_URI) {
    return { ok: false, reason: "MONGODB_TEST_URI jest identyczny z MONGODB_URI — odmowa" };
  }
  let dbName = "";
  try {
    dbName = decodeURIComponent(new URL(uri).pathname.replace(/^\//, ""));
  } catch {
    return { ok: false, reason: "MONGODB_TEST_URI nie jest poprawnym adresem" };
  }
  if (!/test/i.test(dbName)) {
    return { ok: false, reason: 'nazwa bazy w MONGODB_TEST_URI musi zawierać "test"' };
  }
  return { ok: true, uri };
}
