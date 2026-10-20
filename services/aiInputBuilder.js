/**
 * Dane wejściowe do analizy AI i migawka (Etap 8.7.1–8.7.3; plan 6.5–6.6).
 *
 * Ten moduł składa JEDEN obiekt `modelInput`, z którego powstają dwie rzeczy:
 *   - treść wysyłana do modelu (blok JSON w treści użytkownika),
 *   - migawka zapisywana razem z wynikiem (`inputSnapshot`).
 * Migawka jest głęboką kopią TEGO SAMEGO, ostatecznie złożonego obiektu (po
 * filtrach i przycięciach) — nie osobnym zapytaniem do bazy i nie
 * odtwarzaniem wejścia później.
 *
 * Czego tu NIE ma (granica zakresu 8.7):
 *   - klienta Gemini i formatu żądania Google (8.8),
 *   - rezerwacji, zapisu wyniku i dziennika zużycia (8.6, 8.9),
 *   - tras HTTP (8.10).
 * Moduł nie zapisuje niczego w bazie i nie zmienia usług rynkowych.
 *
 * Wartości zwracane zamiast wyjątków (`{ok:false, reason}`): wywołujący
 * (orkiestrator, 8.9) sam zdecyduje, jak zamienić powód na status analizy.
 * Powody: `position_not_found`, `action_not_found`, `no_actions`,
 * `market_data_unavailable`.
 *
 * Bezpieczeństwo logów: logujemy wyłącznie rodzaje zdarzeń i liczby —
 * nigdy treści uzasadnień, newsów ani komunikatów błędów usług zewnętrznych
 * (mogłyby zawierać adres z kluczem).
 */
import mongoose from "mongoose";
import Action from "../models/Action.js";
import Position from "../models/Position.js";
import { getMarketContext as defaultGetMarketContext } from "./historyPriceService.js";
import { getCompanyNews as defaultGetCompanyNews } from "./currentPriceService.js";
import {
  formatDateOnly,
  latestCompletedTradingDate,
  toTradingDateString,
} from "../utils/tradingCalendar.js";
import {
  ANALYSIS_KINDS,
  PROMPT_VERSION,
  buildUserContent,
  getResponseSchema,
  getSystemInstruction,
  getSystemInstructionHash,
  serializeModelInput,
} from "../utils/aiPrompt.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Limity danych dla modelu. PROPONOWANE (plan 6.6: „np. 20 najnowszych,
 * skrócone”; test 8.2 nie rozstrzygnął liczb) — do oceny po danych z realnych
 * pozycji. Nie ma od nich zmiennych środowiskowych.
 */
export const AI_INPUT_LIMITS = Object.freeze({
  maxNews: 20,
  maxHeadlineChars: 200,
  maxSummaryChars: 500,
  maxSourceChars: 60,
  // Dolna granica wiadomości: otwarcie pozycji minus ten margines.
  newsLeadMs: DAY_MS,
});

/**
 * Zakres wiarygodnego `datetime` (sekundy UNIX): od 2000-01-01 do wartości
 * poniżej 1e11. Milisekundy z tej epoki to wartości ≥ ~9,5e11, więc zostają
 * odrzucone jako niepoprawny format, zamiast być odczytane jako odległa
 * przyszłość lub przeszłość.
 */
export const NEWS_DATETIME_MIN_SECONDS = 946_684_800;
export const NEWS_DATETIME_MAX_SECONDS = 99_999_999_999;

const defaultLog = (event, fields = {}) => {
  console.log(JSON.stringify({ event, ...fields }));
};

/* ------------------------------------------------------------------ *
 * Drobne pomocnicze
 * ------------------------------------------------------------------ */

function toIso(value) {
  if (value === null || value === undefined) return null;

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const finiteOrNull = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const textOrEmpty = (value) => (typeof value === "string" ? value : "");

/** Skraca po punktach kodowych (nie dzieli par zastępczych), z wielokropkiem. */
function truncate(value, maxChars) {
  const text = textOrEmpty(value).trim();
  const chars = Array.from(text);

  if (chars.length <= maxChars) return { text, truncated: false };

  return {
    text: `${chars
      .slice(0, maxChars - 1)
      .join("")
      .trimEnd()}…`,
    truncated: true,
  };
}

function shiftIsoDay(dateOnly, days) {
  return new Date(Date.parse(`${dateOnly}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function compareActions(a, b) {
  const byDate =
    new Date(a.actionDate).getTime() - new Date(b.actionDate).getTime();

  if (byDate !== 0) return byDate;

  const byCreated =
    (a.createdAt ? new Date(a.createdAt).getTime() : 0) -
    (b.createdAt ? new Date(b.createdAt).getTime() : 0);

  if (byCreated !== 0) return byCreated;

  return String(a._id) < String(b._id)
    ? -1
    : String(a._id) > String(b._id)
      ? 1
      : 0;
}

/* ------------------------------------------------------------------ *
 * Filtr wiadomości (8.7.2)
 * ------------------------------------------------------------------ */

/**
 * Dokładne filtrowanie wiadomości po stronie aplikacji.
 *
 * Wiadomość zostaje tylko wtedy, gdy ma poprawny `datetime` (liczba całkowita
 * sekund UNIX z dopuszczalnego zakresu) i `lowerMs ≤ datetime·1000 ≤ upperMs`.
 * Element bez poprawnego czasu jest ODRZUCANY — nie da się wykluczyć, że
 * pochodzi z przyszłości. Wiadomość „równo na granicy” zostaje, o sekundę
 * późniejsza jest odrzucana.
 *
 * Jednostka `datetime` (sekundy) to założenie z dokumentacji Finnhub —
 * NIE potwierdzono jej na prawdziwej odpowiedzi (plan 3.5, 8.7.2).
 *
 * @returns {{ items: Array, stats: object }}
 */
export function filterNews(
  rawItems,
  { lowerMs, upperMs, limits = AI_INPUT_LIMITS },
) {
  const stats = {
    fetched: Array.isArray(rawItems) ? rawItems.length : 0,
    droppedNoTime: 0,
    droppedLater: 0,
    droppedEarlier: 0,
    droppedEmpty: 0,
    droppedOverLimit: 0,
    truncatedTexts: 0,
    truncatedItems: 0,
  };

  const candidates = [];

  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    const seconds =
      item && typeof item === "object" ? item.datetime : undefined;

    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds < NEWS_DATETIME_MIN_SECONDS ||
      seconds > NEWS_DATETIME_MAX_SECONDS
    ) {
      stats.droppedNoTime += 1;
      continue;
    }

    const ms = seconds * 1000;

    if (ms > upperMs) {
      stats.droppedLater += 1;
      continue;
    }

    if (ms < lowerMs) {
      stats.droppedEarlier += 1;
      continue;
    }

    const headline = truncate(item.headline, limits.maxHeadlineChars);
    const summary = truncate(item.summary, limits.maxSummaryChars);
    const source = truncate(item.source, limits.maxSourceChars);

    if (headline.text === "" && summary.text === "") {
      stats.droppedEmpty += 1;
      continue;
    }

    const truncatedFields =
      Number(headline.truncated) +
      Number(summary.truncated) +
      Number(source.truncated);

    stats.truncatedTexts += truncatedFields;
    stats.truncatedItems += truncatedFields > 0 ? 1 : 0;

    // Tylko dozwolone pola — bez `url` i bez niczego, czego nie wymienia plan.
    candidates.push({
      seconds,
      value: {
        publishedAt: new Date(ms).toISOString(),
        headline: headline.text,
        summary: summary.text,
        source: source.text,
      },
    });
  }

  candidates.sort(
    (a, b) =>
      a.seconds - b.seconds ||
      (a.value.headline < b.value.headline
        ? -1
        : a.value.headline > b.value.headline
          ? 1
          : 0),
  );

  // Przy nadmiarze zostają NAJNOWSZE; kolejność wyjściowa: chronologiczna.
  const excess = Math.max(0, candidates.length - limits.maxNews);
  stats.droppedOverLimit = excess;

  return {
    items: candidates.slice(excess).map((entry) => entry.value),
    stats,
  };
}

/* ------------------------------------------------------------------ *
 * Zakres danych rynkowych (dataCoverage)
 * ------------------------------------------------------------------ */

function buildCoverage({ kind, momentMs, bars, cutoff, news, limits }) {
  const sessionDay = toTradingDateString(new Date(momentMs));
  const currentSessionCandleMissing = sessionDay > cutoff;
  const firstBarDate = bars.length > 0 ? bars[0].date : null;
  const lastBarDate = bars.length > 0 ? bars[bars.length - 1].date : null;
  const notes = [];

  if (currentSessionCandleMissing) {
    notes.push(
      kind === "full"
        ? `Analiza wykonana w trakcie sesji ${sessionDay}: świeca z tego dnia jeszcze nie istnieje; dane dzienne kończą się na sesji ${cutoff}.`
        : `Decyzja podjęta w trakcie sesji ${sessionDay}: świeca z tego dnia nie jest uwzględniona; dane dzienne kończą się na sesji ${cutoff}.`,
    );
  }

  if (bars.length === 0) {
    notes.push("Brak danych dziennych w badanym oknie.");
  } else if (lastBarDate < cutoff) {
    notes.push(
      `Najnowsza dostępna świeca dzienna pochodzi z ${lastBarDate}, czyli sprzed granicy danych ${cutoff}.`,
    );
  }

  if (!news.available) {
    notes.push(
      "Nie udało się pobrać wiadomości; brak wiadomości w danych nie oznacza braku wiadomości na rynku.",
    );
  } else {
    if (news.stats.droppedNoTime > 0) {
      notes.push(
        `Część wiadomości (${news.stats.droppedNoTime}) pominięto z powodu braku poprawnego czasu publikacji.`,
      );
    }

    if (news.stats.droppedOverLimit > 0) {
      notes.push(
        `Pokazano ${news.items.length} najnowszych wiadomości; starsze (${news.stats.droppedOverLimit}) pominięto z powodu limitu.`,
      );
    }

    if (news.stats.truncatedItems > 0) {
      notes.push(
        `Treść części wiadomości (${news.stats.truncatedItems}) została skrócona (nagłówek do ${limits.maxHeadlineChars} znaków, streszczenie do ${limits.maxSummaryChars}, źródło do ${limits.maxSourceChars}); pełny tekst nie był dostępny dla modelu.`,
      );
    }
  }

  return {
    analysisMoment: new Date(momentMs).toISOString(),
    dataCutoffDate: cutoff,
    firstBarDate,
    lastBarDate,
    barCount: bars.length,
    currentSessionCandleMissing,
    newsAvailable: news.available,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * Budowanie modelInput (8.7.1)
 * ------------------------------------------------------------------ */

const POSITION_FIELDS = "ticker status openedAt closedAt";
const ACTION_FIELDS =
  "actionType quantity executionPrice marketPriceAtDecision actionDate tradingDateRef statedMotivation reasoning reasoningAddedAt expectedOutcome createdAt";

function toModelAction(action, index) {
  return {
    sequenceNo: index + 1,
    actionType: action.actionType,
    quantity: finiteOrNull(action.quantity),
    executionPrice: finiteOrNull(action.executionPrice),
    marketPriceAtDecision: finiteOrNull(action.marketPriceAtDecision),
    actionDate: toIso(action.actionDate),
    tradingDateRef: action.tradingDateRef
      ? formatDateOnly(action.tradingDateRef)
      : null,
    statedMotivation: textOrEmpty(action.statedMotivation),
    reasoning: textOrEmpty(action.reasoning),
    reasoningAddedAt: toIso(action.reasoningAddedAt),
    expectedOutcome: textOrEmpty(action.expectedOutcome),
  };
}

/**
 * @param {object} [deps] wstrzykiwane w testach
 */
export function createAiInputBuilder({
  PositionModel = Position,
  ActionModel = Action,
  getMarketContext = defaultGetMarketContext,
  getCompanyNews = defaultGetCompanyNews,
  now = () => new Date(),
  log = defaultLog,
  limits = AI_INPUT_LIMITS,
} = {}) {
  /**
   * @param {object} args
   * @param {string} args.positionId
   * @param {string} args.userId       właściciel — wszystkie odczyty filtrują po nim
   * @param {"full"|"quickCheck"} args.kind
   * @param {string} [args.actionId]   wymagane dla quickCheck (akcja sprawdzana)
   * @returns {Promise<{ok:true, kind, modelInput, market, actionRefs} | {ok:false, reason:string}>}
   */
  async function buildModelInput({ positionId, userId, kind, actionId }) {
    if (!ANALYSIS_KINDS.includes(kind)) {
      throw new TypeError(`Nieznany rodzaj analizy: ${JSON.stringify(kind)}.`);
    }

    if (kind === "quickCheck" && !actionId) {
      throw new TypeError("quickCheck wymaga actionId.");
    }

    if (
      !mongoose.isValidObjectId(positionId) ||
      !mongoose.isValidObjectId(userId)
    ) {
      return { ok: false, reason: "position_not_found" };
    }

    const position = await PositionModel.findOne({
      _id: positionId,
      userId,
      deletedAt: null,
    })
      .select(POSITION_FIELDS)
      .lean();

    if (!position) return { ok: false, reason: "position_not_found" };

    // Wszystkie akcje tej pozycji tego właściciela (Parent-Child Guard); bez
    // `earlyAiCheck`, `userId` i `positionId` — tych pól nie wybieramy z bazy.
    const stored = await ActionModel.find({ positionId, userId })
      .select(ACTION_FIELDS)
      .lean();
    const sorted = [...stored].sort(compareActions);

    let included = sorted;
    let target = null;

    if (kind === "quickCheck") {
      const index = sorted.findIndex(
        (action) => String(action._id) === String(actionId),
      );

      if (index === -1) return { ok: false, reason: "action_not_found" };

      // Tylko ta akcja i wcześniejsze — późniejsze nie trafiają nawet do pamięci modelu.
      included = sorted.slice(0, index + 1);
      target = sorted[index];
    }

    if (included.length === 0) return { ok: false, reason: "no_actions" };

    const nowDate = now();
    const moment =
      kind === "quickCheck" ? new Date(target.actionDate) : new Date(nowDate);
    const momentMs = moment.getTime();

    // Stan pozycji NA MOMENT analizy: dla quick-checka nie ujawniamy, że
    // pozycja została zamknięta później niż sprawdzana decyzja.
    const closedAsOf =
      kind === "quickCheck"
        ? target.actionType === "close"
        : position.status === "closed";
    const positionStatus = closedAsOf ? "closed" : "open";
    const closedAt = closedAsOf
      ? toIso(kind === "quickCheck" ? target.actionDate : position.closedAt)
      : null;

    // Dane rynkowe. Granica dla quick-checka to ostatnia ZAKOŃCZONA sesja
    // względem actionDate — nigdy tradingDateRef (patrz historyPriceService).
    let market;

    try {
      market = await getMarketContext(position.ticker, {
        since: position.openedAt,
        ...(kind === "quickCheck"
          ? { upTo: latestCompletedTradingDate(moment) }
          : {}),
        now: nowDate,
      });
    } catch (error) {
      log("ai_input_market_unavailable", {
        kind,
        errorName: error?.name ?? "Error",
      });

      return { ok: false, reason: "market_data_unavailable" };
    }

    const bars = (market.bars ?? []).map((bar) => ({
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume ?? null,
    }));
    const cutoff = market.upTo ?? market.window.endDate;

    // Wiadomości: zapytanie szersze o dzień z obu stron (strefa from/to Finnhub
    // nie jest potwierdzona), potem dokładny filtr lokalny.
    const lowerMs = new Date(position.openedAt).getTime() - limits.newsLeadMs;
    const rangeFrom = shiftIsoDay(utcDay(lowerMs), -1);
    const rangeTo = shiftIsoDay(utcDay(momentMs), 1);
    const news = {
      available: true,
      items: [],
      stats: filterNews([], { lowerMs, upperMs: momentMs, limits }).stats,
    };

    try {
      const rawNews = await getCompanyNews(position.ticker, rangeFrom, rangeTo);

      if (!Array.isArray(rawNews))
        throw new TypeError("Odpowiedź newsów nie jest listą.");

      const filtered = filterNews(rawNews, {
        lowerMs,
        upperMs: momentMs,
        limits,
      });

      news.items = filtered.items;
      news.stats = filtered.stats;
    } catch (error) {
      news.available = false;
      log("ai_input_news_unavailable", {
        kind,
        errorName: error?.name ?? "Error",
      });
    }

    const modelInput = {
      ticker: position.ticker,
      positionStatus,
      openedAt: toIso(position.openedAt),
      closedAt,
      actions: included.map(toModelAction),
      marketContext: {
        interval: market.interval,
        source: market.source,
        bars,
      },
      news: news.items,
      dataCoverage: buildCoverage({
        kind,
        momentMs,
        bars,
        cutoff,
        news,
        limits,
      }),
    };

    const metaMarket = {
      source: market.source,
      interval: market.interval,
      fetchedAt: toIso(market.fetchedAt),
      fromCache: Boolean(market.fromCache),
      window: { ...market.window },
      upTo: market.upTo ?? null,
      dataCutoffDate: cutoff,
      news: {
        source: "finnhub",
        available: news.available,
        rangeFrom,
        rangeTo,
        ...news.stats,
        kept: news.items.length,
      },
    };

    const actionRefs = included.map((action, index) => ({
      sequenceNo: index + 1,
      actionId: String(action._id),
      reasoningAddedAt: toIso(action.reasoningAddedAt),
    }));

    log("ai_input_built", {
      kind,
      actions: included.length,
      bars: bars.length,
      newsAvailable: news.available,
      newsFetched: news.stats.fetched,
      newsKept: news.items.length,
      newsDroppedNoTime: news.stats.droppedNoTime,
      newsDroppedLater: news.stats.droppedLater,
      fromCache: metaMarket.fromCache,
    });

    return { ok: true, kind, modelInput, market: metaMarket, actionRefs };
  }

  return { buildModelInput };
}

export const aiInputBuilder = createAiInputBuilder();

/* ------------------------------------------------------------------ *
 * Żądanie i migawka z jednego źródła (8.7.3)
 * ------------------------------------------------------------------ */

/**
 * Z wyniku `buildModelInput` robi dwie rzeczy z TEGO SAMEGO tekstu JSON:
 *   - `request` — neutralny kontrakt dla klienta modelu (8.8): instrukcja
 *     systemowa i dane w OSOBNYCH polach, schemat odpowiedzi, wersja promptu,
 *   - `snapshot` — `{ modelInput, meta, capturedAt }`.
 *
 * `snapshot.modelInput` powstaje przez zdekodowanie dokładnie tego tekstu,
 * który trafia do `request.userContent` — jest więc niezależną, głęboką
 * kopią tego, co zostanie wysłane, i nie da się jej rozjechać z żądaniem.
 * Późniejsza zmiana `built.modelInput` ani żadnego dokumentu w bazie jej nie
 * zmienia. Klucze API, nagłówki ani konfiguracja nie biorą w tym udziału.
 *
 * `meta.modelVersion` jest `null` (odpowiedź Interactions nie ma osobnej
 * wersji — 8.2.5); jeśli API ją zwróci, użyj `withModelVersion`.
 *
 * @returns {{ request: object, snapshot: object, dataChars: number }}
 */
export function prepareAiRequest({
  kind,
  built,
  requestedModel,
  now = new Date(),
  provider = "gemini",
}) {
  if (!ANALYSIS_KINDS.includes(kind)) {
    throw new TypeError(`Nieznany rodzaj analizy: ${JSON.stringify(kind)}.`);
  }

  if (!built || built.ok !== true || built.kind !== kind) {
    throw new TypeError(
      "built musi być wynikiem buildModelInput dla tego samego rodzaju analizy.",
    );
  }

  if (typeof requestedModel !== "string" || requestedModel.trim() === "") {
    throw new TypeError("requestedModel musi być niepustym tekstem.");
  }

  const dataJson = serializeModelInput(built.modelInput);
  const systemInstructionHash = getSystemInstructionHash(kind);

  const snapshot = {
    modelInput: JSON.parse(dataJson),
    meta: {
      provider,
      requestedModel,
      modelVersion: null,
      promptVersion: PROMPT_VERSION,
      systemInstructionHash,
      market: structuredClone(built.market),
      actionRefs: structuredClone(built.actionRefs),
    },
    capturedAt: new Date(now),
  };

  const request = {
    kind,
    model: requestedModel,
    systemInstruction: getSystemInstruction(kind),
    userContent: buildUserContent(kind, dataJson),
    responseSchema: getResponseSchema(kind),
    promptVersion: PROMPT_VERSION,
    systemInstructionHash,
  };

  return { request, snapshot, dataChars: dataJson.length };
}

/**
 * Kopia migawki z uzupełnioną wersją modelu zwróconą w odpowiedzi (jeśli API
 * ją podaje). Nie zmienia migawki wejściowej.
 */
export function withModelVersion(snapshot, modelVersion) {
  const copy = structuredClone(snapshot);

  copy.meta.modelVersion =
    typeof modelVersion === "string" && modelVersion !== ""
      ? modelVersion
      : null;

  return copy;
}
