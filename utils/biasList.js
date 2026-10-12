/**
 * Zamknięta taksonomia biasów (Etap 7, krok 1) — JEDNO źródło prawdy dla
 * nazw kanonicznych i ich aliasów.
 *
 * Źródło: Załącznik A planu Etapu 7 (wersja 1.1). Lista 35 pozycji i lista
 * aliasów są ZAMKNIĘTE dla wersji testowej:
 *   - nie dopisujemy kategorii ani aliasów "na wszelki wypadek" (FOMO,
 *     "awersja do ryzyka" itp. są celowo poza listą — walidator skieruje je
 *     do fallbacku z zachowaną oryginalną nazwą),
 *   - nowy alias to osobna, świadoma decyzja (np. po przejrzeniu zebranych
 *     etykiet w `proposedLabel` / `proposedBiasLabels`),
 *   - brak dopasowania "na podobieństwo": rozpoznawanie to wyłącznie
 *     normalizacja + dokładne trafienie w nazwę kanoniczną lub alias.
 *
 * Ten plik zawiera same dane, bez logiki. Normalizacja i rozpoznawanie
 * nazw (`resolveBias`) są w utils/validateAiResponse.js (kroki 3–5 planu).
 *
 * Zapis nazw i aliasów jest od razu w postaci ZNORMALIZOWANEJ (małe litery,
 * Unicode NFC, zwykłe apostrofy i myślniki, pojedyncze spacje), bo walidator
 * porównuje je z odpowiedzią Gemini po normalizacji. Polskie znaki zostają.
 *
 * `group`: "A" — klasyczne błędy poznawcze, "B" — błędy emocjonalne i
 * związane z preferencjami, "C" — specyficzne efekty inwestycyjne. Pole nie
 * wpływa na walidację; posłuży do budowy promptu w Etapie 8.
 */

/**
 * Fallback dla biasu spoza taksonomii. To NIE jest jedna z 35 kategorii:
 * nie występuje w BIAS_LIST ani jako nazwa, ani jako alias.
 */
export const OTHER_BIAS = "inne / nieskatalogowane";

// Tworzy wpis z zamrożoną listą aliasów (ochrona przed przypadkową mutacją).
const entry = (name, group, aliases) =>
  Object.freeze({
    name,
    group,
    aliases: Object.freeze([...aliases]),
  });

export const BIAS_LIST = Object.freeze([
  // ---- Grupa A — klasyczne błędy poznawcze (1–15) ----
  // 1.
  entry("nadmierna pewność siebie", "A", [
    "overconfidence bias",
    "overconfidence",
    "excessive confidence",
    "nadmierna pewność",
  ]),
  // 2.
  entry("zakotwiczenie", "A", [
    "anchoring bias",
    "anchoring",
    "anchoring and adjustment",
    "anchor effect",
    "efekt zakotwiczenia",
    "heurystyka zakotwiczenia",
    "kotwiczenie",
    "efekt kotwiczenia",
  ]),
  // 3.
  entry("heurystyka reprezentatywności", "A", [
    "representativeness bias",
    "representativeness heuristic",
    "representativeness",
    "błąd reprezentatywności",
    "efekt reprezentatywności",
  ]),
  // 4.
  entry("heurystyka dostępności", "A", [
    "availability bias",
    "availability heuristic",
    "błąd dostępności",
    "efekt dostępności",
  ]),
  // 5.
  entry("błąd potwierdzenia", "A", [
    "confirmation bias",
    "efekt potwierdzenia",
    "efekt potwierdzania",
  ]),
  // 6.
  entry("konserwatyzm poznawczy", "A", ["conservatism bias"]),
  // 7.
  entry("iluzja kontroli", "A", [
    "illusion of control",
    "illusion of control bias",
    "perceived control",
    "złudzenie kontroli",
  ]),
  // 8.
  entry("błąd wstecznej wiedzy", "A", [
    "hindsight bias",
    "hindsight",
    "efekt wstecznej wiedzy",
  ]),
  // 9.
  entry("dysonans poznawczy", "A", [
    "cognitive dissonance",
    "cognitive dissonance bias",
    "błąd dysonansu poznawczego",
    "efekt dysonansu poznawczego",
  ]),
  // 10.
  entry("błąd atrybucji własnych sukcesów", "A", [
    "self-attribution bias",
    "self attribution",
    "self-serving attribution",
    "błąd samoatrybucji",
    "samoatrybucja",
  ]),
  // 11.
  entry("błąd wyniku", "A", ["outcome bias", "efekt wyniku"]),
  // 12.
  entry("efekt świeżości", "A", [
    "recency bias",
    "recent information bias",
    "błąd świeżości",
    "efekt recencji",
  ]),
  // 13.
  entry("efekt ramowania", "A", [
    "framing effect",
    "framing bias",
    "błąd ramowania",
    "efekt kadrowania",
  ]),
  // 14.
  entry("księgowanie mentalne", "A", [
    "mental accounting",
    "mental accounting bias",
    "mentalne księgowanie",
    "rachunkowość mentalna",
  ]),
  // 15.
  entry("awersja do niejednoznaczności", "A", [
    "ambiguity aversion",
    "ambiguity aversion bias",
    "niechęć do niejednoznaczności",
  ]),

  // ---- Grupa B — błędy emocjonalne i związane z preferencjami (16–22) ----
  // 16.
  entry("niechęć do straty", "B", [
    "loss aversion",
    "loss aversion bias",
    "aversion to losses",
    "awersja do strat",
    "awersja do straty",
    "niechęć do strat",
  ]),
  // 17.
  entry("nadmierny optymizm", "B", [
    "optimism bias",
    "optimistic bias",
    "unrealistic optimism",
    "błąd optymizmu",
    "efekt optymizmu",
  ]),
  // 18.
  entry("brak samokontroli", "B", [
    "self-control bias",
    "lack of self-control",
    "self control bias",
    "błąd samokontroli",
  ]),
  // 19.
  entry("status quo", "B", [
    "status quo bias",
    "efekt status quo",
    "błąd status quo",
  ]),
  // 20.
  entry("efekt posiadania", "B", ["endowment effect", "endowment bias"]),
  // 21.
  entry("awersja do żalu", "B", [
    "regret aversion",
    "regret aversion bias",
    "regret bias",
    "unikanie żalu",
  ]),
  // 22.
  entry("stronniczość sympatii/afiliacji", "B", [
    "affinity bias",
    "stronniczość afiliacji",
    "stronniczość sympatii",
  ]),

  // ---- Grupa C — specyficzne efekty inwestycyjne (23–35) ----
  // 23.
  entry("efekt dyspozycji", "C", [
    "disposition effect",
    "disposition bias",
    "błąd dyspozycji",
  ]),
  // 24.
  entry("efekt stadny", "C", [
    "herding",
    "herding bias",
    "herd behavior",
    "herd behaviour",
    "owczy pęd",
    "zachowania stadne",
    "zachowanie stadne",
  ]),
  // 25.
  entry("bias znajomości", "C", [
    "familiarity bias",
    "familiarity preference",
    "efekt znajomości",
    "błąd znajomości",
  ]),
  // 26.
  entry("bias krajowy", "C", [
    "home bias",
    "domestic bias",
    "home-country bias",
  ]),
  // 27.
  entry("bias lokalny", "C", [
    "local bias",
    "local preference",
    "geographic proximity bias",
  ]),
  // 28.
  entry("podążanie za trendem", "C", [
    "trend chasing",
    "return chasing",
    "performance chasing",
    "pogoń za trendem",
    "gonienie za trendem",
    "podążanie za trendami",
    "pogoń za wynikami",
  ]),
  // 29.
  entry("preferencja akcji loteryjnych", "C", [
    "lottery stock preference",
    "lottery-like stocks",
  ]),
  // 30.
  entry("nadmierny handel", "C", [
    "overtrading",
    "excessive trading",
    "excessive turnover",
    "nadmierne handlowanie",
  ]),
  // 31.
  entry("niedostateczna dywersyfikacja", "C", [
    "under-diversification",
    "under diversification",
    "insufficient diversification",
    "niewystarczająca dywersyfikacja",
    "niedostateczna dywersyfikacja portfela",
  ]),
  // 32.
  entry("ograniczona uwaga", "C", [
    "limited attention",
    "limited investor attention",
    "ograniczona uwaga inwestora",
  ]),
  // 33.
  entry("wąskie ramowanie decyzji", "C", [
    "narrow framing",
    "narrow framing bias",
    "wąskie ramowanie",
    "wąskie kadrowanie",
  ]),
  // 34.
  entry("efekt utopionych kosztów", "C", [
    "sunk cost effect",
    "sunk cost fallacy",
    "sunk costs",
    "błąd utopionych kosztów",
    "pułapka utopionych kosztów",
    "efekt kosztów utopionych",
    "błąd kosztów utopionych",
  ]),
  // 35.
  entry("błąd hazardzisty", "C", [
    "gambler's fallacy",
    "gambler fallacy",
    "gambler's error",
    "monte carlo fallacy",
    "złudzenie hazardzisty",
    "pułapka hazardzisty",
  ]),
]);
