# git-tree — drzewko git dla Claude Code

Mod do [Claude Code](https://claude.com/claude-code), który pokazuje stan repozytorium git
bezpośrednio w interfejsie: graf commitów w panelu obok rozmowy i pasek statusu nad polem
wpisywania.

<p align="center">
  <img src="docs/panel.png" alt="Panel Drzewko git: graf commitów z rozwiniętym commitem, kolorowymi statusami plików, diffem i przyciskiem Wyjaśnij z Claude" width="720">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/pasek-ciemny.png">
    <img src="docs/pasek-jasny.png" alt="Pasek nad polem wpisywania: gałąź, commity do push, zmiany, worktree ze zmianami i PR-y do review" width="820">
  </picture>
</p>

<sub>Zrzuty z repozytorium demonstracyjnego.</sub>

## Co robi

**Pasek nad polem wpisywania**
- gałąź z logo GitHuba — zielona, gdy jest zsynchronizowana ze zdalną
- `↑ N do push` / `↓ N do pobrania` (co 5 minut ciche `git fetch`, tylko odczyt)
- `● N zmian` — niezacommitowane pliki w bieżącym katalogu
- inne worktree repo, które mają niezacommitowane zmiany
- PR-y: ile czeka na Twoje review i ile wróciło do poprawy, z linkami do najnowszych
- ikona drzewka i `›` otwierające panel

**Panel „Drzewko git”** (otwiera się sam albo komendą `/git-tree`)
- graf ostatnich 50 commitów z liniami gałęzi i scaleń
- kliknięcie commita rozwija listę zmienionych plików ze statusem jak na GitHubie
  (żółte **M**, zielone **A**, czerwone **D**, niebieskie **R**) i liczbą linii `+/−`;
  kliknięcie pliku pokazuje jego diff
- **✨ Wyjaśnij z Claude** przy rozwiniętym commicie wpisuje do pola gotowe pytanie:
  co commit zmienia, dlaczego i czy coś w nim budzi wątpliwości — wystarczy Enter
- gałęzie botów (dependabot, renovate) są zawsze ukryte; gałęzie już scalone
  (także przez squash) można ukryć przyciskiem 🧹
- lista PR-ów do review i do poprawy z linkami
- w worktree: przycisk, który zamyka worktree i przenosi jego zmiany do głównego repo
  jako staged (bez commita, bez push); odmawia, gdy worktree jest zablokowane

W aplikacji desktop graf i pasek są rysowane jako grafika (SVG), w terminalu — tekstem.

## Instalacja

W sesji Claude Code w terminalu:

```
/plugin install git-tree --marketplace bpor92/claude-git-tree
```

Potwierdź dodanie marketplace (`y`) i wybierz zakres użytkownika (user), żeby mod działał
we wszystkich projektach. Zainstalowany z terminala działa też w lokalnych sesjach aplikacji
desktop.

### Wymagania

- `git`
- [`gh`](https://cli.github.com/) zalogowany do GitHuba (`gh auth login`) — tylko dla
  liczników i list PR-ów; bez niego reszta działa, a etykieta PR się nie pokazuje

## Co mod uruchamia

Wyłącznie lokalne komendy `git` (odczyt stanu, a zapis tylko po kliknięciu przycisku
zamykania worktree), co 5 minut `git fetch --quiet --no-tags` oraz zapytania
`gh search prs` / `gh api user` (tylko odczyt). Nic nie jest wypychane (`push`).

## Rozwój

```
claude plugin validate .
claude plugin test .
```

Kod: `hooks/register.tsx` (rejestracja, panel, pasek), `hooks/graph.ts` (układ grafu),
`hooks/band.ts` (pasek jako SVG), `hooks/commit.ts` (pliki i diff commita),
`hooks/merged.ts` (wykrywanie scalonych gałęzi), `hooks/worktree.ts`, `hooks/prs.ts`.

## Licencja

[MIT](LICENSE)
