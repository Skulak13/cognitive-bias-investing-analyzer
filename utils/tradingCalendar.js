/**
 * WERSJA TYMCZASOWA (Etap 2).
 *
 * Docelowo (Etap 5) ta funkcja zmapuje `actionDate` na faktyczny dzień
 * sesji giełdowej NYSE/NASDAQ, korzystając z Twelve Data — z uwzględnieniem
 * weekendów i świąt giełdowych (np. akcja zapisana w sobotę powinna odnosić
 * się do piątkowej sesji).
 *
 * Na tym etapie potrzebujemy WYŁĄCZNIE tego, żeby `Action.tradingDateRef`
 * (pole wymagane w schemacie — patrz models/Action.js) miało jakąkolwiek
 * deterministyczną wartość, bo bez niej żaden zapis akcji nie przejdzie
 * walidacji Mongoose. Funkcja poniżej po prostu obcina znacznik czasu do
 * północy UTC danego dnia — nie wie nic o tym, czy to sobota czy Boxing Day.
 *
 * Nazwa i sygnatura zostają takie same w Etapie 5 — zmieni się tylko ciało
 * funkcji, więc żaden kod wywołujący `toTradingDateRef` nie będzie wymagał
 * zmian.
 */
export function toTradingDateRef(actionDate) {
  const date = new Date(actionDate);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Nieprawidłowa actionDate: "${actionDate}"`);
  }

  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}
