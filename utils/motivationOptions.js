/**
 * Dozwolone wartości Action.statedMotivation.
 * Jedyne źródło prawdy — importowane przez model (walidacja enum)
 * i docelowo udostępniane frontendowi przez API, żeby UI renderował
 * dokładnie te same opcje bez ręcznego przepisywania listy w dwóch miejscach.
 */
export const STATED_MOTIVATIONS = [
  "spodziewam się wzrostu ceny",
  "spodziewam się spadku ceny / chcę ograniczyć stratę",
  "chcę zrealizować dotychczasowy zysk",
  "boję się zrealizować zysk lub stratę (unikam decyzji)",
  "nowe informacje o spółce zmieniły moją ocenę",
  "podążam za tym, co robią inni inwestorzy",
  "chcę zmniejszyć ryzyko ekspozycji",
  "świadomie nic nie zmieniam na razie (teza wciąż aktualna)",
  "zapomniałem / nie śledziłem aktywnie",
  "inny powód",
];
