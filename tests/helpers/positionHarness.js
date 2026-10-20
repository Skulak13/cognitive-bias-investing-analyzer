/**
 * Wspólne środowisko testów stanu analiz na `Position` (Etap 8.6).
 *
 * Dwa tryby (wybór automatyczny; nazwa trybu jest wypisywana w nazwach testów):
 *   - "mongo": gdy `MONGODB_TEST_URI` spełnia zabezpieczenia z testDb.js
 *     (osobna baza, nazwa zawiera „test”) — PRAWDZIWY Mongoose i baza testowa,
 *   - "fake":  w przeciwnym razie — prosta atrapa kolekcji w pamięci, która
 *     odtwarza TYLKO podzbiór zapytań używany przez serwis (równość, `$ne`,
 *     `$lt/$gt`, `$or/$and`, `$set/$inc/$push`). Sprawdza logikę serwisu, ale NIE
 *     zastępuje testu na MongoDB (atomowość `findOneAndUpdate` itd.).
 */
import "dotenv/config";
import mongoose from "mongoose";
import Position from "../../models/Position.js";
import { resolveTestDb } from "./testDb.js";

// ---------------------------------------------------------------- atrapa

// structuredClone psuje ObjectId (zamienia na zwykły obiekt) — własne kopiowanie.
function clone(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  }
  return v;
}

const same = (a, b) => {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  }
  return String(a) === String(b);
};

const cmp = (a, b) => {
  if (a == null || b == null) return null;
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
};

function matchField(value, cond) {
  const isOps =
    cond !== null &&
    typeof cond === "object" &&
    !(cond instanceof Date) &&
    !(cond instanceof mongoose.Types.ObjectId) &&
    Object.keys(cond).some((k) => k.startsWith("$"));
  if (!isOps) return same(value, cond);
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case "$ne":
        return !same(value, arg);
      case "$lt":
        return cmp(value, arg) === -1;
      case "$gt":
        return cmp(value, arg) === 1;
      case "$lte":
        return [-1, 0].includes(cmp(value, arg));
      case "$gte":
        return [1, 0].includes(cmp(value, arg));
      case "$regex":
        return typeof value === "string" && new RegExp(arg).test(value);
      case "$in":
        return arg.some((a) => same(value, a));
      default:
        throw new Error(`Atrapa nie obsługuje operatora ${op}`);
    }
  });
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((f) => matches(doc, f));
    if (key === "$and") return cond.every((f) => matches(doc, f));
    if (key.startsWith("$")) throw new Error(`Atrapa nie obsługuje ${key}`);
    return matchField(doc[key], cond);
  });
}

function applyUpdate(doc, update) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [k, v] of Object.entries(fields)) {
      if (op === "$set") doc[k] = v;
      else if (op === "$inc") doc[k] = (doc[k] ?? 0) + v;
      else if (op === "$push") doc[k] = [...(doc[k] ?? []), clone(v)];
      else throw new Error(`Atrapa nie obsługuje ${op}`);
    }
  }
}

// Opóźnienie operacji atrapy (ms) — FAKE_DB_LATENCY_MS=3 npm run test:ai-state odtwarza
// zachowanie prawdziwej bazy (operacje trwają) i wykrywa testy bez poprawnej synchronizacji.
class FakeQuery {
  constructor(run) {
    this.run = run;
    this.opts = {};
  }
  select(s) {
    this.opts.select = s;
    return this;
  }
  lean() {
    return this;
  }
  sort(s) {
    this.opts.sort = s;
    return this;
  }
  limit(n) {
    this.opts.limit = n;
    return this;
  }
  then(resolve, reject) {
    // odroczenie do mikrozadania — jak zapytanie do bazy
    return new Promise((r) =>
      setTimeout(r, Number(process.env.FAKE_DB_LATENCY_MS || 0)),
    )
      .then(() => this.run(this.opts))
      .then(resolve, reject);
  }
}

const project = (doc, select) => {
  const copy = clone(doc);
  if (!select) return copy;
  const keep = new Set(["_id", ...select.split(/\s+/).filter(Boolean)]);
  return Object.fromEntries(Object.entries(copy).filter(([k]) => keep.has(k)));
};

export function createFakePositionModel() {
  const docs = [];
  return {
    _docs: docs,
    findOneAndUpdate(filter, update, options = {}) {
      return new FakeQuery((o) => {
        const doc = docs.find((d) => matches(d, filter));
        if (!doc) return null;
        const before = clone(doc);
        applyUpdate(doc, update);
        return project(
          options.returnDocument === "after" ? doc : before,
          o.select,
        );
      });
    },
    findOne(filter) {
      return new FakeQuery((o) => {
        const doc = docs.find((d) => matches(d, filter));
        return doc ? project(doc, o.select) : null;
      });
    },
    find(filter) {
      return new FakeQuery((o) => {
        let found = docs.filter((d) => matches(d, filter));
        if (o.sort) {
          const [[k, dir]] = Object.entries(o.sort);
          found = [...found].sort((a, b) => (cmp(a[k], b[k]) ?? 0) * dir);
        }
        if (o.limit) found = found.slice(0, o.limit);
        return found.map((d) => project(d, o.select));
      });
    },
    exists(filter) {
      return new FakeQuery(() => {
        const doc = docs.find((d) => matches(d, filter));
        return doc ? { _id: doc._id } : null;
      });
    },
    updateMany(filter, update) {
      return new FakeQuery(() => {
        const found = docs.filter((d) => matches(d, filter));
        found.forEach((d) => applyUpdate(d, update));
        return { matchedCount: found.length, modifiedCount: found.length };
      });
    },
  };
}

// ---------------------------------------------------------------- środowisko

/**
 * Pola wymagane przez schemat `Position` (userId, ticker, status, openedAt,
 * currentQuantity). Obie ścieżki — "mongo" i "fake" — budują dokument TYM SAMYM
 * schematem Mongoose (`new Position(...)`): domyślne wartości i walidacja są więc
 * identyczne; atrapa tylko nie zapisuje do bazy. Nie utrzymujemy własnej kopii
 * wartości domyślnych, która mogłaby rozjechać się ze schematem.
 */
const requiredPositionFields = () => ({
  userId: new mongoose.Types.ObjectId(),
  ticker: "TEST",
  openedAt: new Date("2026-01-05T10:00:00Z"),
  currentQuantity: 1,
});

/**
 * @returns {Promise<{backend: "mongo"|"fake", Position: any, insert: Function,
 *   get: Function, setFields: Function, reset: Function, close: Function}>}
 */
export async function createPositionHarness(env = process.env) {
  const testDb = resolveTestDb(env);

  if (testDb.ok) {
    await mongoose.connect(testDb.uri);
    // Serwis działa na CAŁEJ kolekcji (odzyskiwanie po restarcie, przegląd cykliczny),
    // więc testy wymagają pustej kolekcji `positions` w bazie testowej — inaczej
    // cudze lub pozostałe po przerwanym biegu dokumenty zmieniłyby wyniki.
    // To bezpieczne tylko dlatego, że `resolveTestDb` dopuszcza wyłącznie bazę
    // testową (nazwa zawiera „test”, adres ≠ MONGODB_URI).
    await Position.deleteMany({});
    const created = [];
    return {
      backend: "mongo",
      Position,
      async insert(overrides = {}) {
        const doc = await Position.create({
          ...requiredPositionFields(),
          ...overrides,
        });
        created.push(doc._id);
        return String(doc._id);
      },
      async get(id) {
        return Position.findById(id).lean();
      },
      async setFields(id, fields) {
        await Position.updateOne({ _id: id }, { $set: fields });
      },
      async all() {
        return Position.find({ _id: { $in: created } }).lean();
      },
      async reset() {
        created.length = 0;
        await Position.deleteMany({});
      },
      async close() {
        created.length = 0;
        await Position.deleteMany({});
        await mongoose.disconnect();
      },
    };
  }

  const fake = createFakePositionModel();
  return {
    backend: "fake",
    Position: fake,
    async insert(overrides = {}) {
      // ta sama walidacja i te same wartości domyślne co w trybie "mongo"
      const model = new Position({ ...requiredPositionFields(), ...overrides });
      await model.validate();
      const doc = clone(model.toObject());
      fake._docs.push(doc);
      return String(doc._id);
    },
    async get(id) {
      const d = fake._docs.find((x) => String(x._id) === String(id));
      return d ? clone(d) : null;
    },
    async setFields(id, fields) {
      Object.assign(
        fake._docs.find((x) => String(x._id) === String(id)),
        fields,
      );
    },
    async all() {
      return fake._docs.map((d) => clone(d));
    },
    async reset() {
      fake._docs.length = 0;
    },
    async close() {
      fake._docs.length = 0;
    },
  };
}
