import mongoose from "mongoose";
import Position from "../models/Position.js";
import Action from "../models/Action.js";
import { getPriceAtMoment } from "../services/intradayPriceService.js";
import { toTradingDateRef } from "../utils/tradingCalendar.js";
import {
  validateStaticQuantity,
  buildActionUpdate,
} from "../utils/actionInvariants.js";

/**
 * Tworzy błąd z jawnym statusem HTTP — patrz middleware/errorHandler.js (Etap 1).
 */
function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Wymaga "Z" albo jawnego offsetu (+02:00/-05:00) — NIGDY samego
 * "2026-09-22T15:00" bez strefy.
 *
 * Bez tego: `new Date("2026-09-22T15:00")` jest interpretowane jako czas
 * LOKALNY PROCESU, nie UTC. Ten sam string wysłany przez klienta dałby
 * więc inny wynik zależnie od tego, czy backend akurat działa w UTC
 * (typowo na Render) czy lokalnie na komputerze dewelopera w Polsce
 * (CET/CEST, UTC+1/+2) — a różnica nawet dwóch godzin potrafi przesunąć
 * `tradingDateRef`/`latestCompletedTradingDate` (tradingCalendar.js,
 * Etap 5) o całą sesję giełdową, bez żadnego widocznego błędu po drodze.
 */
const UNAMBIGUOUS_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// Tolerancja na przesunięcie zegara klienta względem serwera — realne
// urządzenia rzadko mają idealnie zsynchronizowany czas, więc odrzucanie
// z dokładnością co do sekundy karałoby zwykłe drobne rozjechanie się
// zegarów, nie prawdziwą przyszłą datę (jutro, za tydzień).
const FUTURE_ACTION_DATE_TOLERANCE_MS = 5 * 60 * 1000; // 5 minut

/**
 * Sprawdza, że actionDate jest jednoznacznym znacznikiem czasu — ISO-8601
 * z "Z" albo offsetem — a nie tylko "czymś, co `new Date()` jakoś
 * sparsuje". Rzuca ten sam kształt błędu (fail(400, ...)) co reszta
 * walidacji w tym pliku.
 *
 * Zakres godzin/minut/sekund oraz offsetu NIE jest tu ręcznie sprawdzany —
 * `new Date()` sam odrzuca np. "25:00:00" albo "+25:00" jako Invalid Date
 * (sprawdzone empirycznie), więc łapie to już check `Number.isNaN` niżej.
 *
 * Kalendarzowe istnienie samej daty JEST sprawdzane ręcznie — bo tego
 * `new Date()` NIE łapie: "2026-02-30T15:00:00.000Z" nie daje Invalid
 * Date, tylko po cichu "przewija się" na 2026-03-02 (sprawdzone
 * empirycznie, niezależnie od tego, czy użyto "Z" czy offsetu — offset
 * tylko przesuwa WYNIK po fakcie, nie chroni przed przewinięciem samej
 * daty). Technika identyczna jak w `assertDateOnly` z tradingCalendar.js:
 * budujemy datę ze składowych i porównujemy, czy to, co wróciło, zgadza
 * się z tym, co wpisano — jeśli nie, taki dzień nie istnieje.
 */
export function assertUnambiguousActionDate(actionDate, now = new Date()) {
  const match =
    typeof actionDate === "string"
      ? UNAMBIGUOUS_TIMESTAMP_RE.exec(actionDate)
      : null;

  if (!match) {
    throw fail(
      400,
      'actionDate musi być pełnym ISO-8601 z jawną strefą czasową — "Z" ' +
        'albo offsetem, np. "2026-09-22T15:00:00.000Z" albo ' +
        '"2026-09-22T17:00:00+02:00". Zapis bez strefy (np. ' +
        '"2026-09-22T15:00") jest niedozwolony, bo bywa odczytany jako czas ' +
        "lokalny procesu, a nie UTC.",
    );
  }

  const [year, month, day] = match[1].split("-").map(Number);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));

  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw fail(400, `actionDate zawiera nieistniejącą datę: "${actionDate}"`);
  }

  const date = new Date(actionDate);

  if (Number.isNaN(date.getTime())) {
    throw fail(400, `Nieprawidłowy format actionDate: "${actionDate}"`);
  }

  // Dziennik Decyzji Inwestycyjnych rejestruje decyzje, które już zapadły
  // — nie planowanie przyszłych. Potwierdzone jako świadoma reguła dla
  // wersji testowej (nie wspieramy jeszcze planowania na przyszłość).
  if (date.getTime() > now.getTime() + FUTURE_ACTION_DATE_TOLERANCE_MS) {
    throw fail(
      400,
      `actionDate nie może wskazywać przyszłości: "${actionDate}". ` +
        "Ten dziennik rejestruje decyzje, które już zapadły.",
    );
  }

  return date;
}

/**
 * Pobiera cenę rynkową NAJBLIŻSZĄ momentowi decyzji, w sposób bezpieczny.
 *
 * WAŻNE (Etap 5, naprawa semantyki pola): wcześniej ta funkcja wołała
 * `getCurrentPrice(ticker)` — czyli cenę z chwili ZAPISU akcji, nie z
 * chwili DECYZJI (`actionDate`). Dla wpisu bez opóźnienia to prawie to
 * samo, ale dla wpisu spóźnionego (decyzja o 15:00, zapis o 17:00; albo
 * decyzja wczoraj, zapis dziś rano) dawało to fałszywy kontekst —
 * `marketPriceAtDecision` pokazywało cenę z zupełnie innego momentu, niż
 * sugerowała nazwa pola. Teraz woła `getPriceAtMoment(ticker, actionDate)`
 * z intradayPriceService.js, które respektuje zasadę "bez wglądu w
 * przyszłość" — patrz komentarz w tamtym pliku.
 *
 * marketPriceAtDecision pozostaje informacją pomocniczą.
 * Jej brak nie powinien anulować prawidłowej operacji
 * domenowej, np. zapisania open/add.
 *
 * executionPrice pozostaje źródłem prawdy
 * o wykonaniu transakcji.
 *
 * @param {string} ticker
 * @param {Date} actionDate już zwalidowany Date (assertUnambiguousActionDate)
 */
async function getMarketPriceSafely(ticker, actionDate) {
  try {
    const result = await getPriceAtMoment(ticker, actionDate);

    return result?.price;
  } catch (error) {
    console.warn(
      `Nie udało się pobrać marketPriceAtDecision dla ${ticker}: ${error.message}`,
    );

    return undefined;
  }
}

/**
 * POST /api/positions
 *
 * Otwiera nową pozycję + zapisuje pierwszą akcję "open"
 * w jednej transakcji ACID.
 *
 * executionPrice:
 *   - pochodzi od użytkownika,
 *   - jest źródłem prawdy o wykonaniu transakcji.
 *
 * marketPriceAtDecision:
 *   - jest pobierane przez backend z Twelve Data/cache (intradayPriceService),
 *     dla momentu actionDate — patrz komentarz przy getMarketPriceSafely,
 *   - NIE jest przyjmowane z req.body,
 *   - ma charakter informacyjnego snapshotu, nie ceny "co do sekundy".
 *
 * (Etap 2: brak ensureAiAccessible, brak wywołań AI — to Etap 8.)
 */
export const createPosition = async (req, res) => {
  const {
    ticker,
    quantity,
    executionPrice,
    actionDate,
    statedMotivation,
    reasoning,
    expectedOutcome,
  } = req.body;

  // 1. Obecność i typ wymaganych pól
  if (
    typeof ticker !== "string" ||
    !ticker.trim() ||
    executionPrice === undefined ||
    !actionDate ||
    !statedMotivation
  ) {
    throw fail(
      400,
      "Brak wymaganych pól: ticker (tekst), executionPrice, actionDate, statedMotivation",
    );
  }

  // 2. Typy danych — Number.isFinite (nie samo typeof) odrzuca też
  // Infinity/-Infinity, które przechodziłyby dalej jako "liczba" i
  // spełniałyby np. "executionPrice >= 0".
  if (!Number.isFinite(executionPrice) || executionPrice < 0) {
    throw fail(
      400,
      "executionPrice musi być skończoną liczbą większą lub równą 0",
    );
  }

  // 3. Format daty — jednoznaczny ISO-8601 z "Z" albo offsetem, patrz
  //    komentarz przy assertUnambiguousActionDate. Wynik (już zwalidowany
  //    Date) łapiemy i używamy dalej zamiast ponownie parsować ten sam
  //    string — jedno źródło prawdy dla openedAt/Action.actionDate.
  const parsedActionDate = assertUnambiguousActionDate(actionDate);

  // 4. Inwariant ilości
  const quantityError = validateStaticQuantity("open", quantity);

  if (quantityError) {
    throw fail(400, quantityError);
  }

  // 5. Pobranie pomocniczej ceny rynkowej — najbliższej momentowi decyzji
  //    (parsedActionDate), nie chwili zapisu. Patrz komentarz przy
  //    getMarketPriceSafely.
  //
  // Awaria Twelve Data/cache nie blokuje utworzenia pozycji.
  // executionPrice pozostaje źródłem prawdy.
  const marketPriceAtDecision = await getMarketPriceSafely(
    ticker,
    parsedActionDate,
  );

  const session = await mongoose.startSession();

  let position;
  let action;

  try {
    await session.withTransaction(async () => {
      [position] = await Position.create(
        [
          {
            userId: req.userId,
            ticker,
            status: "open",
            openedAt: parsedActionDate,
            currentQuantity: quantity,
          },
        ],
        { session },
      );

      [action] = await Action.create(
        [
          {
            positionId: position._id,
            userId: req.userId,
            actionType: "open",
            quantity,
            executionPrice,
            marketPriceAtDecision,
            actionDate: parsedActionDate,
            tradingDateRef: toTradingDateRef(parsedActionDate),
            statedMotivation,
            reasoning,
            reasoningAddedAt: reasoning ? new Date() : null,
            expectedOutcome,
          },
        ],
        { session },
      );
    });
  } finally {
    // endSession ZAWSZE, niezależnie od tego,
    // czy transakcja się powiodła.
    await session.endSession();
  }

  res.status(201).json({ position, action });
};

/**
 * POST /api/positions/:id/actions
 *
 * Dodaje akcję add/reduce/hold/close do ISTNIEJĄCEJ pozycji.
 *
 * marketPriceAtDecision jest pobierane przez backend
 * na podstawie tickera pozycji.
 *
 * Właściwy wzorzec z sekcji 7.2:
 * atomowa aktualizacja Position.currentQuantity
 * (inwariant wbudowany w filtr — patrz buildActionUpdate)
 * + zapis Action w tej samej sesji.
 *
 * Jeśli findOneAndUpdate nie znajdzie dopasowania:
 * - quantity łamie inwariant,
 * - pozycja nie istnieje,
 * - pozycja nie należy do usera,
 * - pozycja jest zamknięta,
 * - pozycja jest usunięta,
 *
 * rzucamy błąd WEWNĄTRZ withTransaction.
 * Mongo automatycznie wycofuje wszystko,
 * co zdążyło się zapisać w tej sesji.
 */
export const addAction = async (req, res) => {
  const { id: positionId } = req.params;

  const {
    actionType,
    quantity,
    executionPrice,
    actionDate,
    statedMotivation,
    reasoning,
    expectedOutcome,
  } = req.body;

  if (!["add", "reduce", "hold", "close"].includes(actionType)) {
    throw fail(
      400,
      `Nieobsługiwany actionType dla tego endpointu: "${actionType}". ` +
        "Nową pozycję (open) twórz przez POST /api/positions.",
    );
  }

  const quantityError = validateStaticQuantity(actionType, quantity);

  if (quantityError) {
    throw fail(400, quantityError);
  }

  // executionPrice: dla "hold" nie ma sensu domenowo (hold = brak
  // transakcji, więc brak ceny wykonania) — wariant A z dwóch omawianych:
  // prosty zakaz zamiast "dozwolone, jeśli poprawne". Dla pozostałych
  // typów wymagane i musi być skończoną, nieujemną liczbą (Number.isFinite,
  // nie samo typeof — patrz komentarz w createPosition).
  if (actionType === "hold") {
    if (executionPrice !== undefined) {
      throw fail(
        400,
        'executionPrice nie jest dozwolone dla actionType "hold" — hold ' +
          "oznacza brak transakcji, więc nie ma czego wyceniać.",
      );
    }
  } else {
    if (executionPrice === undefined) {
      throw fail(
        400,
        `executionPrice jest wymagane dla actionType "${actionType}"`,
      );
    }

    if (!Number.isFinite(executionPrice) || executionPrice < 0) {
      throw fail(
        400,
        "executionPrice musi być skończoną liczbą większą lub równą 0",
      );
    }
  }

  if (!actionDate || !statedMotivation) {
    throw fail(400, "Brak wymaganych pól: actionDate, statedMotivation");
  }

  const parsedActionDate = assertUnambiguousActionDate(actionDate);

  /**
   * Najpierw pobieramy tylko dane potrzebne do znalezienia
   * tickera pozycji.
   *
   * Robimy to PRZED rozpoczęciem transakcji MongoDB, żeby
   * transakcja nie musiała czekać na zewnętrzne API.
   */
  const positionMeta = await Position.findOne({
    _id: positionId,
    userId: req.userId,
    deletedAt: null,
  })
    .select("ticker status")
    .lean();

  if (!positionMeta || positionMeta.status !== "open") {
    throw fail(409, "Naruszenie inwariantu ilości lub pozycja niedostępna");
  }

  /**
   * Pobieramy cenę rynkową najbliższą momentowi decyzji (parsedActionDate),
   * nie chwili zapisu — patrz komentarz przy getMarketPriceSafely.
   *
   * Awaria Twelve Data nie blokuje zapisania Action.
   */
  const marketPriceAtDecision = await getMarketPriceSafely(
    positionMeta.ticker,
    parsedActionDate,
  );

  const { filter, update } = buildActionUpdate(
    actionType,
    quantity,
    req.userId,
    positionId,
    parsedActionDate,
  );

  const session = await mongoose.startSession();

  let position;
  let action;

  try {
    await session.withTransaction(async () => {
      position = await Position.findOneAndUpdate(filter, update, {
        returnDocument: "after",
        session,
      });

      if (!position) {
        // Brak dopasowania = naruszenie inwariantu ilości
        // ALBO pozycja niedostępna.
        //
        // Rzucenie tutaj wymusza rollback całej transakcji.
        // Action poniżej nie zostanie zapisany.
        throw fail(409, "Naruszenie inwariantu ilości lub pozycja niedostępna");
      }

      [action] = await Action.create(
        [
          {
            positionId,
            userId: req.userId,
            actionType,
            quantity,
            executionPrice,
            marketPriceAtDecision,
            actionDate: parsedActionDate,
            tradingDateRef: toTradingDateRef(parsedActionDate),
            statedMotivation,
            reasoning,
            reasoningAddedAt: reasoning ? new Date() : null,
            expectedOutcome,
          },
        ],
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  res.status(201).json({ position, action });
};

/**
 * PATCH /api/positions/:id/actions/:actionId/reasoning
 *
 * Aktualizuje `reasoning` i/lub `expectedOutcome` na JUŻ ISTNIEJĄCEJ akcji.
 * Zdarzenie (co/ile/kiedy/po jakiej cenie) zapisujesz od razu przy
 * `open`/`actions`; uzasadnienie może przyjść później — po to jest ten
 * osobny endpoint (zasada 7 planu).
 *
 * Parent-Child IDOR Guard (sekcja 8.5 planu v7): samo sprawdzenie
 * właściciela POZYCJI nie wystarcza — trzeba też potwierdzić, że TA
 * KONKRETNA akcja jest dzieckiem TEJ KONKRETNEJ pozycji. Bez tego drugiego
 * warunku user mógłby przesłać poprawny `positionId` WŁASNEJ pozycji A,
 * sparowany z `actionId` należącym do WŁASNEJ, ale zupełnie innej
 * pozycji B — i przez pomyłkę (albo złośliwie) zmienić uzasadnienie akcji
 * z niewłaściwej inwestycji. Dzięki denormalizowanemu `Action.userId`
 * (patrz models/Action.js, 4.2 i 7.2 planu) własność i relacja
 * rodzic-dziecko sprawdzają się JEDNYM zapytaniem — `{_id, positionId,
 * userId}` — a nie dwoma sekwencyjnymi (najpierw `Position.findOne`,
 * potem `Action.findOne`). To świadomy wybór z samego planu: mniej
 * round-tripów do bazy i zero ryzyka, że ktoś w przyszłości doda nowy
 * endpoint na `actionId` i zapomni o drugim kroku weryfikacji.
 *
 * `findOneAndUpdate` z tym samym trzyczłonowym filtrem łączy guard i zapis
 * w JEDNYM zapytaniu (ten sam wzorzec co `softDeletePosition` wyżej) —
 * zamiast osobnego `findOne` (guard) + `save()` (zapis), które dawałyby
 * dwa round-tripy i okno czasowe na race condition między nimi.
 */
export const updateActionReasoning = async (req, res) => {
  const { id: positionId, actionId } = req.params;
  const { reasoning, expectedOutcome } = req.body;

  const reasoningProvided = typeof reasoning !== "undefined";
  const expectedOutcomeProvided = typeof expectedOutcome !== "undefined";

  if (!reasoningProvided && !expectedOutcomeProvided) {
    throw fail(
      400,
      "Podaj przynajmniej jedno pole do zaktualizowania: reasoning lub expectedOutcome",
    );
  }

  if (reasoningProvided && typeof reasoning !== "string") {
    throw fail(400, "reasoning musi być tekstem");
  }

  if (expectedOutcomeProvided && typeof expectedOutcome !== "string") {
    throw fail(400, "expectedOutcome musi być tekstem");
  }

  const update = { $set: {} };

  if (reasoningProvided) {
    update.$set.reasoning = reasoning;

    // reasoningAddedAt to moment OSTATNIEGO dopisania/zmiany uzasadnienia —
    // nie moment powstania akcji. Sekcja 9 planu liczy z tej pary
    // ("opóźnienie refleksji": actionDate vs reasoningAddedAt), więc musi
    // się aktualizować za KAŻDYM razem, gdy reasoning faktycznie się
    // zmienia — również przy czyszczeniu na pusty string, bo to też jest
    // świadoma zmiana treści w danym momencie.
    update.$set.reasoningAddedAt = new Date();
  }

  if (expectedOutcomeProvided) {
    update.$set.expectedOutcome = expectedOutcome;
  }

  const action = await Action.findOneAndUpdate(
    {
      _id: actionId,
      positionId,
      userId: req.userId,
    },
    update,
    { returnDocument: "after", runValidators: true },
  );

  if (!action) {
    throw fail(404, "Akcja nie została znaleziona w kontekście tej pozycji.");
  }

  res.status(200).json(action);
};

export const getPositions = async (req, res) => {
  const positions = await Position.find({
    userId: req.userId,
    deletedAt: null,
  }).sort({ createdAt: -1 });

  res.json(positions);
};

/**
 * GET /api/positions/:id
 *
 * 404, nie 403, jeśli pozycja należy do innego usera —
 * nie zdradzamy czy w ogóle istnieje.
 */
export const getPositionById = async (req, res) => {
  const position = await Position.findOne({
    _id: req.params.id,
    userId: req.userId,
    deletedAt: null,
  });

  if (!position) {
    throw fail(404, "Nie znaleziono pozycji");
  }

  res.json(position);
};

/**
 * DELETE /api/positions/:id
 *
 * Soft-delete — ustawia deletedAt,
 * nigdy nie usuwa dokumentu fizycznie.
 */
export const softDeletePosition = async (req, res) => {
  const position = await Position.findOneAndUpdate(
    {
      _id: req.params.id,
      userId: req.userId,
      deletedAt: null,
    },
    {
      $set: {
        deletedAt: new Date(),
      },
    },
    {
      returnDocument: "after",
    },
  );

  if (!position) {
    throw fail(404, "Nie znaleziono pozycji");
  }

  res.status(204).send();
};
