import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertDateOnly,
  getSessionCloseMinutes,
  isSessionClosed,
  isTradingDay,
  isWithinRegularSession,
  regularSessionOpenUtc,
  latestCompletedTradingDate,
  latestTradingDate,
  previousTradingDay,
  shiftTradingDays,
  toTradingDateRef,
  toTradingDateString,
} from "../utils/tradingCalendar.js";

/* ------------------------------------------------------------------ *
 * Dni sesyjne i święta
 * ------------------------------------------------------------------ */

test("isTradingDay — weekend nie jest dniem sesyjnym", () => {
  assert.equal(isTradingDay("2026-09-19"), false); // sobota
  assert.equal(isTradingDay("2026-09-20"), false); // niedziela
  assert.equal(isTradingDay("2026-09-18"), true); // piątek
});

test("isTradingDay — święta o stałej dacie", () => {
  assert.equal(isTradingDay("2027-01-01"), false); // Nowy Rok (piątek)
  assert.equal(isTradingDay("2026-12-25"), false); // Boże Narodzenie (piątek)
  assert.equal(isTradingDay("2026-06-19"), false); // Juneteenth (piątek)
});

test("isTradingDay — święta ruchome liczone z dnia tygodnia", () => {
  assert.equal(isTradingDay("2026-01-19"), false); // 3. poniedziałek stycznia
  assert.equal(isTradingDay("2026-02-16"), false); // 3. poniedziałek lutego
  assert.equal(isTradingDay("2026-05-25"), false); // ostatni poniedziałek maja
  assert.equal(isTradingDay("2026-09-07"), false); // 1. poniedziałek września
  assert.equal(isTradingDay("2026-11-26"), false); // 4. czwartek listopada
});

test("isTradingDay — Wielki Piątek (jedyne święto liczone z Wielkanocy)", () => {
  assert.equal(isTradingDay("2026-04-03"), false);
  assert.equal(isTradingDay("2026-04-02"), true); // Wielki Czwartek — sesja jest
});

test("isTradingDay — święto w sobotę odbierane w piątek", () => {
  // 4 lipca 2026 wypada w sobotę → giełda wolna w piątek 3 lipca.
  assert.equal(isTradingDay("2026-07-03"), false);
});

test("isTradingDay — Nowy Rok w sobotę NIE daje wolnego piątku", () => {
  // 1 stycznia 2022 to sobota, ale 31 grudnia 2021 był normalną sesją:
  // NYSE nie przenosi tego święta wstecz do poprzedniego roku.
  assert.equal(isTradingDay("2021-12-31"), true);
});

/* ------------------------------------------------------------------ *
 * Mapowanie actionDate → dzień sesji
 * ------------------------------------------------------------------ */

test("toTradingDateString — decyzja w trakcie sesji wskazuje ten sam dzień", () => {
  // piątek 18.09.2026, 16:00 UTC = 12:00 w Nowym Jorku
  assert.equal(toTradingDateString("2026-09-18T16:00:00Z"), "2026-09-18");
});

test("toTradingDateString — dokładnie 09:30 ET to już dzisiejsza sesja", () => {
  assert.equal(toTradingDateString("2026-09-18T13:30:00Z"), "2026-09-18");
  // minuta wcześniej sesja jeszcze nie ruszyła
  assert.equal(toTradingDateString("2026-09-18T13:29:00Z"), "2026-09-17");
});

test("toTradingDateString — decyzja przed otwarciem wskazuje poprzednią sesję", () => {
  // piątek 12:00 UTC = 08:00 ET, handel przedsesyjny
  assert.equal(toTradingDateString("2026-09-18T12:00:00Z"), "2026-09-17");
});

test("toTradingDateString — weekend cofa do piątku", () => {
  assert.equal(toTradingDateString("2026-09-19T15:00:00Z"), "2026-09-18");
  assert.equal(toTradingDateString("2026-09-20T15:00:00Z"), "2026-09-18");
});

test("toTradingDateString — święto cofa do poprzedniej sesji", () => {
  // Święto Dziękczynienia 26.11.2026 → środa 25.11.2026
  assert.equal(toTradingDateString("2026-11-26T18:00:00Z"), "2026-11-25");
});

test("toTradingDateString — to jest cały sens tego modułu: UTC ≠ dzień sesji", () => {
  // Wtorek 15.09.2026, 02:00 UTC to w Nowym Jorku poniedziałek 22:00.
  // Wersja z Etapu 2 (obcięcie do północy UTC) zapisałaby tu 15 września.
  assert.equal(toTradingDateString("2026-09-15T02:00:00Z"), "2026-09-14");
});

test("toTradingDateRef — zwraca Date ustawiony na północ UTC", () => {
  const ref = toTradingDateRef("2026-09-15T02:00:00Z");

  assert.ok(ref instanceof Date);
  assert.equal(ref.toISOString(), "2026-09-14T00:00:00.000Z");
});

test("toTradingDateRef — odrzuca nieprawidłową datę", () => {
  assert.throws(() => toTradingDateRef("nie-data"), /Nieprawidłowa actionDate/);
});

/* ------------------------------------------------------------------ *
 * Poruszanie się po sesjach
 * ------------------------------------------------------------------ */

test("previousTradingDay — przeskakuje weekend", () => {
  assert.equal(previousTradingDay("2026-09-21"), "2026-09-18");
});

test("shiftTradingDays — liczy sesje, nie dni kalendarzowe", () => {
  // pięć sesji wstecz od piątku 18.09 to piątek 11.09 (weekend się nie liczy)
  assert.equal(shiftTradingDays("2026-09-18", -5), "2026-09-11");
  assert.equal(shiftTradingDays("2026-09-18", 0), "2026-09-18");
});

test("latestTradingDate — w sobotę zwraca piątkową sesję", () => {
  assert.equal(
    latestTradingDate(new Date("2026-09-19T12:00:00Z")),
    "2026-09-18",
  );
});

test("isSessionClosed — rozpoznaje trwającą i zamkniętą sesję", () => {
  // 19:00 UTC = 15:00 ET, sesja trwa
  assert.equal(
    isSessionClosed("2026-09-18", new Date("2026-09-18T19:00:00Z")),
    false,
  );

  // 21:00 UTC = 17:00 ET, po zamknięciu
  assert.equal(
    isSessionClosed("2026-09-18", new Date("2026-09-18T21:00:00Z")),
    true,
  );
});

/* ------------------------------------------------------------------ *
 * latestCompletedTradingDate — granica danych, osobno od etykiety sesji
 * ------------------------------------------------------------------ */

test("latestCompletedTradingDate — decyzja w trakcie dnia cofa się do wczoraj", () => {
  // wtorek 15.09.2026, 15:00 UTC = 11:00 ET — sesja trwa, świeca niekompletna
  assert.equal(
    latestCompletedTradingDate("2026-09-15T15:00:00Z"),
    "2026-09-14",
  );
});

test("latestCompletedTradingDate — decyzja po zamknięciu zostaje przy tym samym dniu", () => {
  // wtorek 15.09.2026, 21:00 UTC = 17:00 ET — po 16:00, sesja już domknięta
  assert.equal(
    latestCompletedTradingDate("2026-09-15T21:00:00Z"),
    "2026-09-15",
  );
});

test("latestCompletedTradingDate — różni się od toTradingDateRef dla tej samej decyzji", () => {
  // To jest właściwy powód, dla którego to dwie osobne funkcje: dla decyzji
  // w środku dnia sesja "już trwała" (tradingDateRef), ale jej świeca
  // dzienna jeszcze nie jest gotowa (latestCompletedTradingDate).
  const decyzja = "2026-09-15T15:00:00Z"; // wtorek 11:00 ET

  assert.equal(formatRef(toTradingDateRef(decyzja)), "2026-09-15");
  assert.equal(latestCompletedTradingDate(decyzja), "2026-09-14");

  function formatRef(ref) {
    return ref.toISOString().slice(0, 10);
  }
});

test("latestCompletedTradingDate — wynik nie zależy od tego, KIEDY funkcja jest wywołana", () => {
  // Sedno naprawionego błędu: quick-check uruchomiony od razu i quick-check
  // powtórzony następnego dnia muszą dać ten sam wynik, bo funkcja liczy
  // się WYŁĄCZNIE z actionDate — nie przyjmuje "teraz" z zewnątrz.
  const decyzja = "2026-09-15T15:00:00Z"; // wtorek 11:00 ET

  // Wywołanie "od razu" i wywołanie "dzień później" to dokładnie to samo
  // wejście (decyzja się nie zmienia), więc z definicji dają ten sam wynik —
  // w przeciwieństwie do starego podejścia, które przez `now` w
  // isPartial/endDate potrafiło przemycić już domknięty kurs wtorku.
  assert.equal(latestCompletedTradingDate(decyzja), "2026-09-14");
  assert.equal(latestCompletedTradingDate(decyzja), "2026-09-14");
});

test("latestCompletedTradingDate — weekend i święto cofają tak samo jak toTradingDateRef", () => {
  assert.equal(
    latestCompletedTradingDate("2026-09-19T15:00:00Z"), // sobota
    "2026-09-18",
  );
  assert.equal(
    latestCompletedTradingDate("2026-11-26T18:00:00Z"), // Thanksgiving
    "2026-11-25",
  );
});

/* ------------------------------------------------------------------ *
 * Skrócone sesje — dzień po Święcie Dziękczynienia i Wigilia, 2026
 *
 * Daty potwierdzone oficjalnym kalendarzem NYSE Group (nyse.com/markets/
 * hours-calendars): 27.11.2026 i 24.12.2026, zamknięcie 13:00 ET.
 * ------------------------------------------------------------------ */

test("getSessionCloseMinutes — zwykły dzień zamyka się o 16:00", () => {
  assert.equal(getSessionCloseMinutes("2026-09-18"), 16 * 60);
});

test("getSessionCloseMinutes — dzień po Święcie Dziękczynienia zamyka się o 13:00", () => {
  assert.equal(getSessionCloseMinutes("2026-11-27"), 13 * 60);
});

test("getSessionCloseMinutes — Wigilia 2026 zamyka się o 13:00", () => {
  assert.equal(getSessionCloseMinutes("2026-12-24"), 13 * 60);
});

test("getSessionCloseMinutes — dzień wolny od giełdy zwraca null", () => {
  assert.equal(getSessionCloseMinutes("2026-12-25"), null); // Boże Narodzenie
});

test("isSessionClosed — 14:00 ET w dniu skróconej sesji to już PO zamknięciu", () => {
  // 27.11.2026, 19:00 UTC = 14:00 ET — godzinę po skróconym zamknięciu.
  // Przed poprawką ta funkcja porównywała do 16:00 i zwracała false.
  assert.equal(
    isSessionClosed("2026-11-27", new Date("2026-11-27T19:00:00Z")),
    true,
  );
});

test("isSessionClosed — 12:00 ET w dniu skróconej sesji to jeszcze PRZED zamknięciem", () => {
  // 17:00 UTC = 12:00 ET, sesja (skrócona) wciąż trwa.
  assert.equal(
    isSessionClosed("2026-11-27", new Date("2026-11-27T17:00:00Z")),
    false,
  );
});

test("latestCompletedTradingDate — decyzja po 13:00 ET w Wigilię liczy się jako ten sam dzień", () => {
  // 24.12.2026, 19:00 UTC = 14:00 ET, po skróconym zamknięciu — świeca
  // Wigilii jest już kompletna.
  assert.equal(
    latestCompletedTradingDate("2026-12-24T19:00:00Z"),
    "2026-12-24",
  );
});

test("latestCompletedTradingDate — decyzja przed 13:00 ET w Wigilię cofa się do dnia wcześniej", () => {
  // 16:00 UTC = 11:00 ET, sesja skrócona wciąż trwa — Wigilijna świeca
  // jeszcze się buduje.
  assert.equal(
    latestCompletedTradingDate("2026-12-24T16:00:00Z"),
    "2026-12-23",
  );
});

test("latestCompletedTradingDate — dokładna granica 12:59→13:00 ET, 27 listopada 2026 (dzień po Thanksgiving)", () => {
  // Oba dni są w EST (UTC-5), nie EDT — sprawdzone empirycznie przed
  // napisaniem tego testu (Intl.DateTimeFormat z timeZoneName).
  //
  // 12:59:00 ET = 17:59:00 UTC — minutę PRZED skróconym zamknięciem.
  assert.equal(
    latestCompletedTradingDate("2026-11-27T17:59:00Z"),
    "2026-11-25", // poprzednia sesja — 26.11 to samo Thanksgiving (pełne święto)
  );

  // Dokładnie 13:00:00 ET = 18:00:00 UTC — sesja już zamknięta.
  assert.equal(
    latestCompletedTradingDate("2026-11-27T18:00:00Z"),
    "2026-11-27",
  );
});

test("latestCompletedTradingDate — dokładna granica 12:59→13:00 ET, 24 grudnia 2026 (Wigilia)", () => {
  assert.equal(
    latestCompletedTradingDate("2026-12-24T17:59:00Z"), // 12:59 ET
    "2026-12-23",
  );
  assert.equal(
    latestCompletedTradingDate("2026-12-24T18:00:00Z"), // dokładnie 13:00 ET
    "2026-12-24",
  );
});

/* ------------------------------------------------------------------ *
 * assertDateOnly — nie tylko kształt, ale i rzeczywiste istnienie daty
 *
 * new Date("2026-02-30...") po cichu "przewija się" na 2026-03-02 zamiast
 * dać błąd — sam regex na kształt YYYY-MM-DD tego nie złapie.
 * ------------------------------------------------------------------ */

test("assertDateOnly — przyjmuje istniejące daty", () => {
  assert.equal(assertDateOnly("2026-09-18"), "2026-09-18");
  assert.equal(assertDateOnly("2028-02-29"), "2028-02-29"); // 2028 to rok przestępny
});

test("assertDateOnly — odrzuca 30 lutego, mimo że pasuje do regexu", () => {
  assert.throws(
    () => assertDateOnly("2026-02-30"),
    /nie istnieje w kalendarzu/,
  );
});

test("assertDateOnly — odrzuca 31 kwietnia (kwiecień ma 30 dni)", () => {
  assert.throws(
    () => assertDateOnly("2026-04-31"),
    /nie istnieje w kalendarzu/,
  );
});

test("assertDateOnly — odrzuca 29 lutego w roku NIEprzestępnym", () => {
  // 2026 nie jest przestępny (2026 / 4 nie jest liczbą całkowitą).
  assert.throws(
    () => assertDateOnly("2026-02-29"),
    /nie istnieje w kalendarzu/,
  );
});

test("assertDateOnly — odrzuca miesiąc 13", () => {
  assert.throws(
    () => assertDateOnly("2026-13-01"),
    /nie istnieje w kalendarzu/,
  );
});

/* ------------------------------------------------------------------ *
 * Skrócona sesja przed 4 lipca — tylko dla lat POTWIERDZONYCH przez NYSE
 * ------------------------------------------------------------------ */

test("getSessionCloseMinutes — 3 lipca 2028 ma potwierdzoną skróconą sesję", () => {
  // 4 lipca 2028 wypada we wtorek (zwykły dzień roboczy) — NYSE Group
  // potwierdziło skróconą sesję w poniedziałek 3 lipca 2028 (komunikat
  // z 23.12.2025).
  assert.equal(getSessionCloseMinutes("2028-07-03"), 13 * 60);
});

test("getSessionCloseMinutes — 2 lipca 2026 to zwykła, pełna sesja", () => {
  // 4 lipca 2026 wypada w sobotę → święto przenosi się na piątek 3 lipca
  // (pełny dzień wolny). Oficjalny komunikat NYSE Group NIE wymienia
  // żadnej skróconej sesji w lipcu 2026 — mimo że część wtórnych źródeł
  // to sugerowała.
  assert.equal(getSessionCloseMinutes("2026-07-02"), 16 * 60);
});

test("isTradingDay — 3 lipca 2026 jest dniem wolnym (obserwowane święto), nie sesją", () => {
  assert.equal(isTradingDay("2026-07-03"), false);
});

/* ------------------------------------------------------------------ *
 * Niejednoznaczny actionDate — ryzyko poza tym modułem
 *
 * tradingCalendar.js poprawnie liczy się z KAŻDYM Date, który dostanie —
 * ale to, CO dostanie, zależy od tego, jak actionDate zostanie
 * sparsowany na granicy API (positionsController). String bez strefy
 * czasowej (np. "2026-09-22T15:00", bez "Z") jest w JavaScript
 * interpretowany jako czas LOKALNY procesu, nie UTC — a to potrafi
 * przesunąć wynik o całą sesję. Poniżej: ta sama "naiwna" godzina
 * zegarowa, zapisana raz jako UTC, raz jako czas polski (CEST, latem
 * UTC+2), daje RÓŻNY tradingDateRef.
 * ------------------------------------------------------------------ */

test("UWAGA — ryzyko: naiwny 'ten sam' czas zegarowy w dwóch strefach daje różny dzień sesji", () => {
  // "15:00" odczytane jako UTC → 11:00 ET → sesja już trwa → wtorek.
  const jakoUtc = "2026-09-22T15:00:00.000Z";
  // To samo "15:00", ale czasu polskiego (CEST, UTC+2) → 13:00 UTC →
  // 9:00 ET → PRZED otwarciem (9:30) → poniedziałek.
  const jakoPolskiCzas = "2026-09-22T13:00:00.000Z";

  assert.equal(toTradingDateString(jakoUtc), "2026-09-22");
  assert.equal(toTradingDateString(jakoPolskiCzas), "2026-09-21");

  // Wniosek: kontrakt wejściowy (positionsController, poza tym modułem)
  // musi wymuszać jednoznaczny format z "Z" lub offsetem — inaczej to,
  // czy serwer akurat działa w UTC czy w czasie lokalnym dewelopera,
  // po cichu zmienia wynik dla dokładnie tego samego zgłoszenia.
});

/* ------------------------------------------------------------------ *
 * isWithinRegularSession — potrzebne w intradayPriceService.js
 * ------------------------------------------------------------------ */

test("isWithinRegularSession — w trakcie zwykłej sesji zwraca true", () => {
  assert.equal(isWithinRegularSession("2026-09-18T15:00:00Z"), true); // 11:00 ET
});

test("isWithinRegularSession — dokładnie w chwili otwarcia (9:30 ET) zwraca true", () => {
  assert.equal(isWithinRegularSession("2026-09-18T13:30:00Z"), true);
});

test("isWithinRegularSession — minutę przed otwarciem zwraca false", () => {
  assert.equal(isWithinRegularSession("2026-09-18T13:29:00Z"), false);
});

test("isWithinRegularSession — dokładnie w chwili zamknięcia (16:00 ET) zwraca false", () => {
  // Sesja to [otwarcie, zamknięcie) — w chwili zamknięcia jest już PO.
  assert.equal(isWithinRegularSession("2026-09-18T20:00:00Z"), false);
});

test("isWithinRegularSession — weekend i święto zwracają false", () => {
  assert.equal(isWithinRegularSession("2026-09-19T15:00:00Z"), false); // sobota
  assert.equal(isWithinRegularSession("2026-11-26T18:00:00Z"), false); // Thanksgiving
});

test("isWithinRegularSession — uwzględnia skróconą sesję (13:00 ET zamiast 16:00)", () => {
  assert.equal(isWithinRegularSession("2026-11-27T17:00:00Z"), true); // 12:00 ET — jeszcze trwa
  assert.equal(isWithinRegularSession("2026-11-27T18:00:00Z"), false); // 13:00 ET — już po
});

/* ------------------------------------------------------------------ *
 * regularSessionOpenUtc — potrzebne w intradayPriceService.js (całosesyjne
 * okno wyszukiwania świecy, odporne na przerwy w notowaniach)
 * ------------------------------------------------------------------ */

test("regularSessionOpenUtc — zwraca 9:30 ET jako UTC, niezależnie od pory w trakcie sesji", () => {
  assert.equal(
    regularSessionOpenUtc("2026-09-18T15:00:00Z").toISOString(), // 11:00 ET
    "2026-09-18T13:30:00.000Z",
  );
  assert.equal(
    regularSessionOpenUtc("2026-09-18T19:59:00Z").toISOString(), // 15:59 ET
    "2026-09-18T13:30:00.000Z",
  );
});

test("regularSessionOpenUtc — dokładnie w chwili otwarcia zwraca ten sam moment", () => {
  assert.equal(
    regularSessionOpenUtc("2026-09-18T13:30:00Z").toISOString(),
    "2026-09-18T13:30:00.000Z",
  );
});

test("regularSessionOpenUtc — rzuca dla dnia niesesyjnego", () => {
  assert.throws(
    () => regularSessionOpenUtc("2026-09-19T15:00:00Z"), // sobota
    /nie jest dniem sesyjnym/,
  );
});

test("regularSessionOpenUtc — zeruje sekundy i milisekundy (15:37:42.123 → dokładnie 09:30:00.000)", () => {
  // Regresja: wcześniej wynik zachowywał sekundy z momentValue i dawał
  // 09:30:42.123. Wszystkie wcześniejsze testy używały momentów równo na
  // minutę, więc tego nie łapały.
  assert.equal(
    regularSessionOpenUtc("2026-09-18T15:37:42.123Z").toISOString(),
    "2026-09-18T13:30:00.000Z",
  );
  assert.equal(
    regularSessionOpenUtc("2026-09-18T13:31:05Z").toISOString(), // 9:31:05 ET
    "2026-09-18T13:30:00.000Z",
  );
  assert.equal(
    regularSessionOpenUtc("2026-09-18T19:59:59.999Z").toISOString(), // 15:59:59.999 ET
    "2026-09-18T13:30:00.000Z",
  );
});

test("regularSessionOpenUtc — działa też w czasie zimowym (EST, UTC-5)", () => {
  // 15.12.2026: 9:30 EST = 14:30 UTC. Moment z sekundami: 11:20:33 EST.
  assert.equal(
    regularSessionOpenUtc("2026-12-15T16:20:33.500Z").toISOString(),
    "2026-12-15T14:30:00.000Z",
  );
});
