/**
 * Inwarianty quantity dla każdego actionType (sekcja 4.2.1 planu).
 * Dwie kategorie, bo wymagają dwóch różnych mechanizmów obrony:
 *
 *  1. Warunki NIEZALEŻNE od współbieżnego stanu (quantity > 0, quantity === 0)
 *     → validateStaticQuantity(): zwykłe sprawdzenie, bezpieczne przed
 *       otwarciem transakcji.
 *
 *  2. Warunki ZALEŻNE od aktualnego currentQuantity pozycji (reduce, close)
 *     → buildActionUpdate(): NIE WOLNO sprawdzać ich osobnym odczytem +
 *       osobnym zapisem (TOCTOU race — dwa równoczesne żądania mogą oba
 *       przejść walidację na starym odczycie, a potem oba coś zapisać).
 *       Zamiast tego warunek trafia do filtra atomowej operacji
 *       `findOneAndUpdate` w tej samej transakcji (sekcja 7.2) — jeśli
 *       żaden dokument nie pasuje, operacja zwraca null i to jest sygnał
 *       do rollbacku, a nie osobny krok "sprawdź, potem zapisz".
 */

/**
 * @param {"open"|"add"|"reduce"|"hold"|"close"} actionType
 * @param {number} quantity
 * @returns {string|null} komunikat błędu, albo null jeśli quantity jest poprawne
 */
export function validateStaticQuantity(actionType, quantity) {
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    // Number.isFinite (nie Number.isNaN!) — samo sprawdzenie NaN
    // przepuszczało Infinity/-Infinity: typeof Infinity === "number" i
    // Number.isNaN(Infinity) === false, więc "Infinity" jako quantity
    // przechodziło dalej i dla open/add spełniało nawet "> 0".
    return "quantity musi być skończoną liczbą";
  }

  switch (actionType) {
    case "open":
    case "add":
      if (!(quantity > 0)) {
        return `Dla akcji "${actionType}" quantity musi być większe od zera`;
      }
      return null;

    case "hold":
      if (quantity !== 0) {
        return 'Dla akcji "hold" quantity musi wynosić dokładnie 0';
      }
      return null;

    case "reduce":
    case "close":
      if (!(quantity > 0)) {
        return `Dla akcji "${actionType}" quantity musi być większe od zera`;
      }
      return null;

    default:
      return `Nieznany actionType: "${actionType}"`;
  }
}

/**
 * Buduje {filter, update} dla atomowej aktualizacji Position.currentQuantity
 * — WYŁĄCZNIE dla actionType, które modyfikują ISTNIEJĄCĄ pozycję: add,
 * reduce, close, hold.
 *
 * ("open" tworzy nową Position, więc nie ma tu zastosowania — patrz
 * positionsController#createPosition, który używa zwykłego Position.create
 * w tej samej sesji transakcyjnej, bez ryzyka wyścigu, bo nic wcześniej
 * nie istnieje.)
 *
 * @param {"add"|"reduce"|"close"|"hold"} actionType
 * @param {number} quantity
 * @param {import("mongoose").Types.ObjectId|string} userId
 * @param {import("mongoose").Types.ObjectId|string} positionId
 * @param {Date} [actionDate] wymagane dla "close" — patrz niżej
 */
export function buildActionUpdate(
  actionType,
  quantity,
  userId,
  positionId,
  actionDate,
) {
  const baseFilter = {
    _id: positionId,
    userId,
    status: "open",
    deletedAt: null,
  };

  switch (actionType) {
    case "add":
      return {
        filter: baseFilter,
        update: { $inc: { currentQuantity: quantity } },
      };

    case "reduce":
      // "0 < quantity < currentQuantity" — jeśli quantity === currentQuantity,
      // to jest close, nie reduce, więc filtr wymaga ŚCIŚLE większego stanu.
      return {
        filter: { ...baseFilter, currentQuantity: { $gt: quantity } },
        update: { $inc: { currentQuantity: -quantity } },
      };

    case "close": {
      // Filtr: "quantity === currentQuantity" dokładnie — nigdy "<=" (to
      // odróżnia close od reduce, patrz komentarz przy "reduce" wyżej).
      //
      // closedAt = actionDate (moment DECYZJI o zamknięciu), NIE new Date()
      // (moment ZAPISU rekordu). Bez tego openedAt (ustawiane z actionDate
      // w positionsController#createPosition) i closedAt opisywałyby dwa
      // różne rodzaje momentu — jeden domenowy, drugi techniczny — mimo że
      // wyglądają jak symetryczna para "początek/koniec cyklu życia
      // pozycji". Przykład, gdzie to miało znaczenie: użytkownik zamyka
      // pozycję o 15:00, ale wpisuje to do dziennika dopiero następnego
      // dnia rano — closedAt powinien pokazywać 15:00 (kiedy DECYZJA
      // zapadła), nie moment porannego wpisu.
      //
      // Rzucamy, jeśli brak poprawnego actionDate, zamiast po cichu
      // wracać do new Date() — cichy fallback przywróciłby dokładnie tę
      // niespójność, którą ta zmiana ma usunąć, i to w sposób trudny do
      // zauważenia (kod by "działał", tylko czasem zapisywał zły moment).
      if (!(actionDate instanceof Date) || Number.isNaN(actionDate.getTime())) {
        throw new Error(
          'buildActionUpdate: actionType "close" wymaga poprawnego actionDate ' +
            "(Date) — closedAt ma odzwierciedlać faktyczny moment decyzji o " +
            "zamknięciu, ten sam co Action.actionDate, a nie moment zapisu.",
        );
      }

      return {
        filter: { ...baseFilter, currentQuantity: quantity },
        update: {
          $inc: { currentQuantity: -quantity },
          $set: { status: "closed", closedAt: actionDate },
        },
      };
    }

    case "hold":
      // Nie rusza currentQuantity — ale nadal musi przejść przez ten sam
      // atomowy filtr, żeby nie dało się dopisać "świadomego hold" do
      // cudzej, zamkniętej albo usuniętej pozycji.
      return {
        filter: baseFilter,
        update: { $set: { updatedAt: new Date() } },
      };

    default:
      throw new Error(
        `buildActionUpdate: nieobsługiwany actionType "${actionType}"`,
      );
  }
}
