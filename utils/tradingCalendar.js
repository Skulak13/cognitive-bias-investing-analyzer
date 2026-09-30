/**
 * tradingCalendar.js — WERSJA DOCELOWA (Etap 5).
 *
 * Po co to w ogóle jest:
 *
 * `actionDate` to dokładny moment decyzji, zapisany w UTC. Dzień sesji
 * giełdowej to co innego. Przykład: akcja zapisana o 02:00 UTC we wtorek
 * to w Nowym Jorku jeszcze poniedziałek, 22:00 — czyli decyzja dotyczy
 * poniedziałkowej sesji, nie wtorkowej. Gdyby zostawić samo obcięcie
 * znacznika czasu do północy UTC (wersja z Etapu 2), pozycja dostałaby
 * błędny dzień odniesienia, a AI przy quick-checku (sekcja 6.1) zobaczyłaby
 * notowanie, którego użytkownik w chwili decyzji fizycznie nie mógł znać.
 *
 * Zasada mapowania, w jednym zdaniu: `tradingDateRef` to OSTATNIA sesja,
 * która w momencie decyzji była już otwarta.
 *
 *   - decyzja w dniu sesyjnym o 09:30 czasu nowojorskiego lub później
 *       → ten sam dzień,
 *   - decyzja przed otwarciem (np. 07:00 ET, handel przedsesyjny)
 *       → poprzednia sesja, bo dzisiejsza świeca dzienna jeszcze nie istnieje,
 *   - weekend albo święto giełdowe
 *       → poprzednia sesja.
 *
 * Dlaczego funkcja jest synchroniczna i nie pyta o nic Twelve Data:
 * zapis akcji jest operacją domenową i zgodnie z zasadą 8 planu nie może
 * zależeć od dostępności zewnętrznego API. Kalendarz świąt NYSE/NASDAQ da
 * się policzyć lokalnie — i tak właśnie robimy poniżej.
 *
 * Czego ten kalendarz NIE obejmuje: zamknięć nadzwyczajnych (żałoba
 * narodowa, huragan Sandy w 2012). Skrócone sesje SĄ modelowane
 * (`getSessionCloseMinutes`) dla lat 2026–2028, na podstawie oficjalnego
 * komunikatu NYSE Group z 23.12.2025 — dzień po Święcie Dziękczynienia i
 * Wigilia algorytmicznie dla dowolnego roku, plus sporadyczny dzień przed
 * 4 lipca z jawnej listy potwierdzonych dat (patrz `earlyCloseDaysForYear`
 * — to nie jest reguła policzalna wzorem, tylko decyzja NYSE ogłaszana
 * rok po roku). Dla samego `tradingDateRef` (próg otwarcia) to bez
 * znaczenia — sesja skrócona i tak zaczyna się o 09:30 — ale ma znaczenie
 * dla `latestCompletedTradingDate` niżej, która pyta o zamknięcie, nie o
 * otwarcie.
 */

export const EXCHANGE_TIME_ZONE = "America/New_York";

// Regularna sesja NYSE/NASDAQ: 09:30–16:00 czasu nowojorskiego.
const SESSION_OPEN_MINUTES = 9 * 60 + 30;
const SESSION_CLOSE_MINUTES = 16 * 60;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Jeden formatter na cały moduł.
 *
 * Intl.DateTimeFormat jest kosztowny przy tworzeniu, a tani przy użyciu —
 * tworzenie go przy każdym wywołaniu byłoby zauważalnym marnotrawstwem
 * przy zapisie wielu akcji. `hourCycle: "h23"` zapewnia godziny 00–23
 * (bez tego niektóre silniki zwracają "24" dla północy).
 */
const exchangeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: EXCHANGE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/* ------------------------------------------------------------------ *
 * Pomocnicze operacje na dacie kalendarzowej ("YYYY-MM-DD")
 * ------------------------------------------------------------------ */

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Nieprawidłowa ${label}: "${value}"`);
  }

  return date;
}

/**
 * Sprawdza format "YYYY-MM-DD" i zwraca wartość.
 */
/**
 * Sprawdza format "YYYY-MM-DD" ORAZ że taka data istnieje w kalendarzu.
 *
 * Sama regexa na to nie wystarcza: `new Date("2026-02-30T00:00:00.000Z")`
 * nie zwraca błędu ani Invalid Date — po cichu "przewija" się na
 * 2026-03-02. Dzień miesiąca 30 dla lutego jest więc składniowo
 * poprawny, ale kalendarzowo nie istnieje, a bez tej dodatkowej
 * weryfikacji przeszedłby dalej i cicho zepsuł każde kolejne przesunięcie
 * (`addCalendarDays`, `previousTradingDay`...) o nieprzewidziany błąd.
 * Sprawdzenie: konwertujemy w obie strony i porównujemy z oryginałem —
 * jeśli się nie zgadza, to znaczy, że taki dzień nie istnieje.
 */
export function assertDateOnly(value, label = "data") {
  if (typeof value !== "string" || !DATE_ONLY_RE.test(value)) {
    throw new Error(
      `${label} musi mieć format YYYY-MM-DD (otrzymano: "${value}")`,
    );
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  const roundTrip = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;

  if (roundTrip !== value) {
    throw new Error(`${label} nie istnieje w kalendarzu: "${value}"`);
  }

  return value;
}

/**
 * "YYYY-MM-DD" → Date ustawiony na północ UTC.
 *
 * Ta północ UTC to nasza umowa na "dzień bez godziny" — dokładnie w takiej
 * postaci `tradingDateRef` trafia do bazy (models/Action.js).
 */
export function dateOnlyToUtcDate(dateOnly) {
  assertDateOnly(dateOnly, "dateOnly");

  return new Date(`${dateOnly}T00:00:00.000Z`);
}

/**
 * Date (północ UTC) → "YYYY-MM-DD".
 *
 * UWAGA — to jest funkcja odwrotna do dateOnlyToUtcDate i czyta WYŁĄCZNIE
 * pola UTC. Używaj jej do wartości, które sam wyprodukował ten moduł
 * (czyli do `tradingDateRef` odczytanego z bazy). Do surowego znacznika
 * czasu (`actionDate`, `new Date()`) użyj toTradingDateString() — inaczej
 * data o 00:00 UTC cofnie Ci się o dzień, bo w Nowym Jorku jest wtedy
 * jeszcze wieczór dnia poprzedniego.
 */
export function formatDateOnly(value) {
  if (typeof value === "string") {
    return assertDateOnly(value, "data");
  }

  const date = toDate(value, "data");

  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate(),
  )}`;
}

function addCalendarDays(dateOnly, days) {
  const date = dateOnlyToUtcDate(dateOnly);

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

/**
 * 0 = niedziela, 6 = sobota.
 */
function weekdayOf(dateOnly) {
  return dateOnlyToUtcDate(dateOnly).getUTCDay();
}

/**
 * n-ty dany dzień tygodnia w miesiącu, np. 3. poniedziałek stycznia.
 */
function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = `${year}-${pad2(month)}-01`;
  const shift = (weekday - weekdayOf(first) + 7) % 7;

  return addCalendarDays(first, shift + (n - 1) * 7);
}

/**
 * Ostatni dany dzień tygodnia w miesiącu, np. ostatni poniedziałek maja.
 */
function lastWeekdayOfMonth(year, month, weekday) {
  // Pierwszy dzień kolejnego miesiąca minus jeden dzień = ostatni dzień tego miesiąca.
  const firstOfNext =
    month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`;

  const last = addCalendarDays(firstOfNext, -1);

  return addCalendarDays(last, -((weekdayOf(last) - weekday + 7) % 7));
}

/**
 * Niedziela wielkanocna (algorytm gregoriański) — potrzebna wyłącznie po to,
 * żeby wyliczyć Wielki Piątek, jedyne ruchome święto giełdowe niezwiązane
 * z "n-tym dniem tygodnia w miesiącu".
 */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Święto wypadające w sobotę giełda odbiera w poprzedzający piątek,
 * a wypadające w niedzielę — w następny poniedziałek.
 */
function observedDate(dateOnly) {
  const weekday = weekdayOf(dateOnly);

  if (weekday === 6) return addCalendarDays(dateOnly, -1);
  if (weekday === 0) return addCalendarDays(dateOnly, 1);

  return dateOnly;
}

/**
 * Wyliczone święta są zapamiętywane per rok — liczymy je raz, a zapis akcji
 * i budowanie okna historii sięgają po nie wielokrotnie.
 */
const holidayCache = new Map();

function holidaysForYear(year) {
  const cached = holidayCache.get(year);

  if (cached) return cached;

  const holidays = new Set();

  /*
   * Nowy Rok. Wyjątek od reguły "sobota → piątek": gdy 1 stycznia wypada
   * w sobotę, piątek zastępczy leżałby jeszcze w POPRZEDNIM roku i NYSE
   * takiego dnia wolnego nie robi (np. 31.12.2021 był normalną sesją).
   */
  const newYear = `${year}-01-01`;
  const newYearWeekday = weekdayOf(newYear);

  if (newYearWeekday === 0) {
    holidays.add(addCalendarDays(newYear, 1));
  } else if (newYearWeekday !== 6) {
    holidays.add(newYear);
  }

  holidays.add(nthWeekdayOfMonth(year, 1, 1, 3)); // Dzień Martina Luthera Kinga
  holidays.add(nthWeekdayOfMonth(year, 2, 1, 3)); // Dzień Prezydentów
  holidays.add(addCalendarDays(easterSunday(year), -2)); // Wielki Piątek
  holidays.add(lastWeekdayOfMonth(year, 5, 1)); // Memorial Day

  // Juneteenth: święto federalne od 2021, giełdowe od 2022.
  if (year >= 2022) {
    holidays.add(observedDate(`${year}-06-19`));
  }

  holidays.add(observedDate(`${year}-07-04`)); // Dzień Niepodległości
  holidays.add(nthWeekdayOfMonth(year, 9, 1, 1)); // Labor Day
  holidays.add(nthWeekdayOfMonth(year, 11, 4, 4)); // Święto Dziękczynienia
  holidays.add(observedDate(`${year}-12-25`)); // Boże Narodzenie

  holidayCache.set(year, holidays);

  return holidays;
}

// Skrócona sesja: zamknięcie o 13:00 ET zamiast 16:00.
const EARLY_CLOSE_MINUTES = 13 * 60;

const earlyCloseCache = new Map();

/**
 * Trzeci, NIEREGULARNY przypadek skróconej sesji: dzień przed 4 lipca —
 * ale tylko w te lata, gdy samo 4 lipca wypada w zwykły dzień roboczy
 * (nie w weekend, i nie jako "obserwowane" przesunięcie z weekendu).
 *
 * To NIE jest reguła policzalna wzorem (jak Wielki Piątek) — to decyzja,
 * którą NYSE ogłasza rok po roku, więc trzymam tu jawną listę
 * POTWIERDZONYCH dat z oficjalnego komunikatu NYSE Group z 23.12.2025
 * (businesswire.com/nyse.com — kalendarz na 2026, 2027 i 2028), zamiast
 * zgadywać wzorem dla lat, których jeszcze nie ogłoszono:
 *
 *   2026 — 4 lipca wypada w sobotę → święto PRZENIESIONE na piątek 3 lipca
 *          (pełny dzień wolny, nie skrócona sesja) → BRAK skróconej sesji.
 *   2027 — 4 lipca wypada w niedzielę → święto przeniesione na poniedziałek
 *          5 lipca → BRAK skróconej sesji.
 *   2028 — 4 lipca wypada we wtorek (zwykły dzień roboczy) → skrócona
 *          sesja w poniedziałek 3 lipca 2028, zamknięcie 13:00 ET.
 *
 * (Dla porządku: 2024 miało skróconą sesję w środę 3 lipca, 2025 — w
 * czwartek 3 lipca; oba poza zakresem tej listy, bo są już w przeszłości
 * względem budowy tej aplikacji.)
 *
 * Gdy NYSE ogłosi kalendarz na kolejne lata (zwykle na 2–3 lata naprzód),
 * dopisz tu nową datę zamiast zgadywać z samego dnia tygodnia — pozornie
 * ten sam wzór potrafi się nie potwierdzić (patrz różnica między 2025 a
 * 2026, gdzie oba "sąsiadują" ze świętem, a mimo to tylko jeden rok
 * dostaje skróconą sesję).
 *
 * JAWNA DEKLARACJA ZAKRESU: ten moduł — `isTradingDay`, `previousTradingDay`
 * itd. — wygląda jak ogólny kalendarz giełdowy na dowolny rok, i dla
 * regularnych świąt (Nowy Rok, MLK, Wielki Piątek...) faktycznie nim jest,
 * bo liczą się wzorem. Ale dla TEGO konkretnego przypadku (dzień przed
 * 4 lipca) świadomie ograniczam wsparcie do lat 2026–2028 — potwierdzonych
 * oficjalnym kalendarzem NYSE Group. To w pełni wystarcza dla wersji
 * testowej tej aplikacji. Dla lat spoza tego zakresu (np. actionDate z
 * przeszłości przy ewentualnym backfillu dziennika, albo pozycja otwarta
 * w 2029+) `latestCompletedTradingDate` może w te konkretne popołudnia
 * (13:00–16:00 ET wokół 2/3 lipca) pokazać o jeden dzień historii mniej,
 * niż technicznie mogłaby — nigdy więcej. To świadomy, udokumentowany
 * kompromis (opcja A), nie przeoczenie.
 */
const KNOWN_JULY_EARLY_CLOSES = Object.freeze({
  2028: "2028-07-03",
});

/**
 * Dni ze skróconą sesją NYSE/NASDAQ — potwierdzone oficjalnym kalendarzem
 * NYSE Group (nyse.com/markets/hours-calendars, komunikat z 23.12.2025):
 * dzień po Święcie Dziękczynienia i Wigilia (algorytmicznie, dla
 * dowolnego roku) oraz sporadyczny dzień przed 4 lipca (z jawnej listy
 * powyżej, tylko dla lat, w których to potwierdzone).
 */
function earlyCloseDaysForYear(year) {
  const cached = earlyCloseCache.get(year);

  if (cached) return cached;

  const days = new Set();

  // Dzień po Święcie Dziękczynienia: zawsze piątek, nigdy nie koliduje z
  // innym świętem z tej listy, więc bez dodatkowego sprawdzenia.
  days.add(addCalendarDays(nthWeekdayOfMonth(year, 11, 4, 4), 1));

  // Wigilia — ale TYLKO jeśli akurat sama nie stała się obserwowanym
  // świętem Bożego Narodzenia (patrz observedDate w holidaysForYear:
  // gdy 25 grudnia wypada w sobotę, święto przenosi się na piątek 24).
  const christmasEve = `${year}-12-24`;

  if (isTradingDay(christmasEve)) days.add(christmasEve);

  if (KNOWN_JULY_EARLY_CLOSES[year]) days.add(KNOWN_JULY_EARLY_CLOSES[year]);

  earlyCloseCache.set(year, days);

  return days;
}

/* ------------------------------------------------------------------ *
 * Publiczne API kalendarza
 * ------------------------------------------------------------------ */

/**
 * Czy dany dzień kalendarzowy jest dniem sesyjnym?
 *
 * @param {string} dateOnly "YYYY-MM-DD"
 * @returns {boolean}
 */
export function isTradingDay(dateOnly) {
  assertDateOnly(dateOnly, "dateOnly");

  const weekday = weekdayOf(dateOnly);

  if (weekday === 0 || weekday === 6) return false;

  const year = Number(dateOnly.slice(0, 4));

  return !holidaysForYear(year).has(dateOnly);
}

/**
 * Najbliższa sesja PRZED podanym dniem (sam dzień nie jest brany pod uwagę).
 */
export function previousTradingDay(dateOnly) {
  let candidate = addCalendarDays(assertDateOnly(dateOnly, "dateOnly"), -1);

  // Najdłuższa realna przerwa to kilka dni; 10 obiegów to zapas
  // bezpieczeństwa, żeby błąd w danych nie zrobił pętli nieskończonej.
  for (let i = 0; i < 10; i += 1) {
    if (isTradingDay(candidate)) return candidate;

    candidate = addCalendarDays(candidate, -1);
  }

  throw new Error(`Nie znaleziono sesji przed ${dateOnly}`);
}

/**
 * Najbliższa sesja PO podanym dniu.
 */
export function nextTradingDay(dateOnly) {
  let candidate = addCalendarDays(assertDateOnly(dateOnly, "dateOnly"), 1);

  for (let i = 0; i < 10; i += 1) {
    if (isTradingDay(candidate)) return candidate;

    candidate = addCalendarDays(candidate, 1);
  }

  throw new Error(`Nie znaleziono sesji po ${dateOnly}`);
}

/**
 * Przesuwa datę o zadaną liczbę SESJI (nie dni kalendarzowych).
 *
 * Używane w historyPriceService do zbudowania okna "kilka sesji przed
 * otwarciem pozycji", żeby AI widziała też kontekst sprzed decyzji.
 *
 * @param {string} dateOnly punkt startowy
 * @param {number} sessions liczba ujemna = w tył
 */
export function shiftTradingDays(dateOnly, sessions) {
  assertDateOnly(dateOnly, "dateOnly");

  if (!Number.isInteger(sessions)) {
    throw new Error("shiftTradingDays: sessions musi być liczbą całkowitą");
  }

  let current = dateOnly;
  const step = sessions < 0 ? previousTradingDay : nextTradingDay;

  for (let i = 0; i < Math.abs(sessions); i += 1) {
    current = step(current);
  }

  return current;
}

/**
 * Rozkłada znacznik czasu na dzień i godzinę w strefie giełdy.
 *
 * @param {Date|string|number} value
 * @returns {{date: string, minutesSinceMidnight: number}}
 */
export function getExchangeMoment(value) {
  const date = toDate(value, "actionDate");

  const parts = {};

  for (const part of exchangeFormatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  // % 24 jako zabezpieczenie: część środowisk zwraca "24" zamiast "00".
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

/**
 * Dzień sesji giełdowej, do którego odnosi się dana decyzja — jako tekst.
 *
 * @param {Date|string|number} actionDate moment decyzji (UTC)
 * @returns {string} "YYYY-MM-DD"
 */
export function toTradingDateString(actionDate) {
  const { date, minutesSinceMidnight } = getExchangeMoment(actionDate);

  const beforeOpen = minutesSinceMidnight < SESSION_OPEN_MINUTES;

  if (!isTradingDay(date) || beforeOpen) {
    return previousTradingDay(date);
  }

  return date;
}

/**
 * To samo co wyżej, tylko jako Date ustawiony na północ UTC — w takiej
 * postaci pole `tradingDateRef` trafia do bazy.
 *
 * Nazwa i sygnatura są identyczne jak w wersji tymczasowej z Etapu 2,
 * więc positionsController nie wymaga ŻADNEJ zmiany.
 *
 * @param {Date|string|number} actionDate
 * @returns {Date}
 */
export function toTradingDateRef(actionDate) {
  return dateOnlyToUtcDate(toTradingDateString(actionDate));
}

/**
 * Ostatnia sesja, która już się rozpoczęła (domyślnie: względem teraz).
 * Górna granica okna danych historycznych.
 */
export function latestTradingDate(now = new Date()) {
  return toTradingDateString(now);
}

/**
 * Godzina zamknięcia danej sesji, w minutach od północy czasu
 * nowojorskiego — 16:00 zwykle, 13:00 w dniu skróconej sesji.
 *
 * @param {string} dateOnly
 * @returns {number|null} null, jeśli to w ogóle nie jest dzień sesyjny
 */
export function getSessionCloseMinutes(dateOnly) {
  assertDateOnly(dateOnly, "dateOnly");

  if (!isTradingDay(dateOnly)) return null;

  const year = Number(dateOnly.slice(0, 4));

  return earlyCloseDaysForYear(year).has(dateOnly)
    ? EARLY_CLOSE_MINUTES
    : SESSION_CLOSE_MINUTES;
}

/**
 * Czy sesja danego dnia jest już zamknięta?
 *
 * Główny konsument: `latestCompletedTradingDate` niżej — pyta "czy TA
 * sesja się już domknęła", żeby wiedzieć, czy jej świeca dzienna jest
 * już kompletna, a więc bezpieczna do pokazania AI. (Wcześniej służyło to
 * też do kosmetycznej flagi `isPartial` w historyPriceService.js — ta
 * flaga została usunięta, bo w połączeniu z cache'em [TTL 12h] potrafiła
 * przestać odpowiadać rzeczywistemu stanowi danych; patrz komentarz przy
 * `getMarketContext` w historyPriceService.js. `historyPriceService.js`
 * dziś w ogóle nie pyta o dzień, który jeszcze się nie domknął, więc ten
 * problem zniknął strukturalnie, a nie przez pilnowanie flagi.)
 *
 * Uwzględnia skrócone sesje przez `getSessionCloseMinutes` — dzień po
 * Święcie Dziękczynienia i Wigilia zamykają się o 13:00, nie o 16:00.
 *
 * @param {string} dateOnly
 * @param {Date} [now]
 */
export function isSessionClosed(dateOnly, now = new Date()) {
  assertDateOnly(dateOnly, "dateOnly");

  if (!isTradingDay(dateOnly)) return true;

  const moment = getExchangeMoment(now);

  if (moment.date > dateOnly) return true;
  if (moment.date < dateOnly) return false;

  return moment.minutesSinceMidnight >= getSessionCloseMinutes(dateOnly);
}

/**
 * Ostatni dzień sesyjny, którego świeca dzienna (EOD) była już KOMPLETNA
 * w danym momencie. To jest granica dla danych pokazywanych AI — coś
 * innego niż `toTradingDateRef`.
 *
 * Różnica w jednym zdaniu:
 *   - toTradingDateRef pyta „do której sesji NALEŻY ta decyzja?” (próg: 9:30 —
 *     otwarcie),
 *   - latestCompletedTradingDate pyta „jaka historia BYŁA JUŻ ZNANA w tym
 *     momencie?” (próg: 16:00 — zamknięcie).
 *
 * Przykład: decyzja we wtorek o 11:00 ET.
 *   toTradingDateRef            → wtorek   (sesja już trwała)
 *   latestCompletedTradingDate  → poniedziałek (wtorkowa świeca jeszcze się buduje)
 *
 * Dlaczego to nie to samo pole: `tradingDateRef` jest zapisywany RAZ, przy
 * tworzeniu akcji, i służy do podpisania decyzji właściwą sesją (przydatne
 * dla człowieka czytającego własny dziennik). Granica danych dla AI musi
 * natomiast zostać policzona PONOWNIE, za każdym razem, WYŁĄCZNIE z
 * `actionDate` — nigdy z bieżącego czasu. Gdyby użyć do tego samego
 * `tradingDateRef` i przefiltrować historię pobraną później (np. przy
 * ponownej próbie quick-checku wieczorem, już po zamknięciu wtorkowej
 * sesji), AI dostałoby ostateczny, domknięty kurs zamknięcia wtorku —
 * czyli dokładnie tę informację, której użytkownik o 11:00 nie mógł znać.
 * Ta funkcja nie przyjmuje osobnego `now` OBOK `momentValue` właśnie po to,
 * żeby ta pomyłka była niemożliwa: dla decyzji z przeszłości wynik zależy
 * tylko od `actionDate`, więc quick-check uruchomiony od razu i quick-check
 * powtórzony następnego dnia dają identyczny wynik. Domyślna wartość
 * `momentValue = new Date()` poniżej nie osłabia tego — służy wyłącznie
 * wywołaniom bez konkretnej decyzji w tle (np. `getDailyHistorySnapshot`
 * pytające "jaki jest dziś ostatni bezpieczny dzień do pobrania", patrz
 * historyPriceService.js), gdzie "teraz" jest właśnie tym, o co pytamy.
 *
 * Skrócone sesje (dzień po Święcie Dziękczynienia, Wigilia, oraz — dla
 * potwierdzonych lat — dzień przed 4 lipca) SĄ tu uwzględnione, przez
 * `isSessionClosed` → `getSessionCloseMinutes`. Jedyna pozostała luka:
 * lata spoza `KNOWN_JULY_EARLY_CLOSES` (na razie tylko 2028), dla których
 * NYSE jeszcze nie ogłosiła kalendarza. Konsekwencja pomyłki jest tam
 * bezpieczna: co najwyżej jeden dzień mniej danych, nigdy więcej niż
 * powinno być widoczne.
 *
 * @param {Date|string|number} [momentValue] zwykle `action.actionDate`;
 *                                            domyślnie "teraz"
 * @returns {string} "YYYY-MM-DD"
 */
export function latestCompletedTradingDate(momentValue = new Date()) {
  const ref = toTradingDateString(momentValue);

  return isSessionClosed(ref, momentValue) ? ref : previousTradingDay(ref);
}

/**
 * Czy dany moment przypada W TRAKCIE regularnej sesji (09:30 – zamknięcie,
 * uwzględniając skrócone sesje)?
 *
 * Potrzebne w intradayPriceService.js: tylko wtedy ma sens szukanie świecy
 * 1-minutowej dla `actionDate` — poza tymi godzinami (przed otwarciem, po
 * zamknięciu, weekend, święto) żadna świeca "dzisiejszej sesji" nie
 * istnieje, więc trzeba spaść na inny mechanizm (ostatnie zamknięcie
 * dzienne — patrz `latestCompletedTradingDate` + `historyPriceService`).
 *
 * @param {Date|string|number} momentValue
 * @returns {boolean}
 */
export function isWithinRegularSession(momentValue) {
  const { date, minutesSinceMidnight } = getExchangeMoment(momentValue);

  if (!isTradingDay(date)) return false;

  const closeMinutes = getSessionCloseMinutes(date);

  return (
    minutesSinceMidnight >= SESSION_OPEN_MINUTES &&
    minutesSinceMidnight < closeMinutes
  );
}

/**
 * Moment otwarcia regularnej sesji (09:30 ET) TEGO SAMEGO dnia sesyjnego
 * co `momentValue`, jako Date w UTC.
 *
 * Potrzebne w intradayPriceService.js do pobrania świec 1-minutowych od
 * początku bieżącej sesji, zamiast ze stałego, krótkiego okna wstecz —
 * dzięki temu wyszukiwanie ostatniej dostępnej świecy jest odporne na
 * przerwy w notowaniach (halt, mało płynny instrument), nie tylko na
 * kilka minut ciszy.
 *
 * Liczymy to przesunięciem względem `momentValue`, a nie budową nowej
 * daty od zera — strefa czasowa ET (EST/EDT) jest STAŁA w obrębie
 * jednego dnia sesyjnego (zmiana czasu letniego/zimowego zdarza się o
 * 2:00 w nocy czasu lokalnego, nigdy w trakcie sesji 9:30–16:00), więc
 * proste odjęcie minut w UTC jest tu bezpieczne i poprawne.
 *
 * UWAGA — sekundy i milisekundy: `getExchangeMoment` zwraca tylko pełne
 * minuty (formatter nie prosi o sekundy), więc samo odjęcie
 * `minutesSinceOpen` zostawiłoby sekundy/milisekundy z `momentValue`
 * (15:37:42.123 → 09:30:42.123 zamiast 09:30:00.000). Dlatego odejmujemy
 * je osobno. Przesunięcia stref ET są całkowitymi godzinami, więc
 * sekundy i milisekundy w UTC i w ET są identyczne.
 *
 * WYMAGA, żeby `momentValue` przypadał w dniu sesyjnym — dla dnia
 * wolnego od giełdy `SESSION_OPEN_MINUTES` nie ma znaczenia, więc taki
 * przypadek rzuca błąd zamiast zwracać mylący wynik.
 *
 * @param {Date|string|number} momentValue
 * @returns {Date} dokładnie 09:30:00.000 ET tego dnia, jako UTC
 */
export function regularSessionOpenUtc(momentValue) {
  const moment = toDate(momentValue, "momentValue");
  const { date, minutesSinceMidnight } = getExchangeMoment(moment);

  if (!isTradingDay(date)) {
    throw new Error(`regularSessionOpenUtc: "${date}" nie jest dniem sesyjnym`);
  }

  const minutesSinceOpen = minutesSinceMidnight - SESSION_OPEN_MINUTES;
  const msIntoCurrentMinute =
    moment.getUTCSeconds() * 1000 + moment.getUTCMilliseconds();

  return new Date(
    moment.getTime() - minutesSinceOpen * 60 * 1000 - msIntoCurrentMinute,
  );
}
