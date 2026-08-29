# Die Domäne austauschen

Der Server nutzt einen bewusst belanglosen Notes-Store als Domäne. Das ist kein Platzhalter, den man
wegdenken muss, sondern Absicht: Was dieses Repo zeigt, ist die Security-Schicht — OAuth-2.1-Prüfung,
Mandantentrennung, Origin-Validierung, Scopes, Audit, Rate-Limiting. Eine interessantere Domäne würde
davon ablenken und bräuchte fremde API-Keys, um überhaupt zu starten. So läuft der Server standalone.

Für den Einsatz an einer echten API wird genau ein Baustein ersetzt.

## Was zu ersetzen ist

**1. Der Store** (`src/store.ts`). Das `Store`-Interface hat `tenant` als erstes Argument jeder
Operation — nicht aus Stilgründen, sondern damit es keine Signatur gibt, mit der sich versehentlich
mandantenübergreifend lesen lässt. Ein Adapter gegen eine fremde API implementiert dasselbe Interface;
`src/store-pg.ts` zeigt das für Postgres mit Row-Level-Security.

**2. Die Tools** (`src/tools.ts`). Jeder Handler bekommt `(args, ctx, store)` und beginnt mit
`requireScope(ctx, "...")`. Der Mandant kommt aus `ctx.tenant`, also aus dem verifizierten Token —
**nie** aus `args`. Das ist die Regel, deren Verletzung die Mandantentrennung aushebelt, und sie ist
in `test/tools.test.ts` festgeschrieben.

## Worauf bei einer fremden API zu achten ist

- **Mandantenmodell.** Kennt die Ziel-API überhaupt Mandanten, oder wird mit einem einzigen
  Dienst-Account gearbeitet? Im zweiten Fall muss die Trennung vollständig in diesem Server passieren
  — jede Query filtert dann nach `ctx.tenant`, und ein vergessener Filter ist ein Datenleck ohne
  zweite Verteidigungslinie. Eine API mit echtem Mandantenbegriff ist deutlich sicherer.
- **Kein Token-Passthrough.** Das eingehende Nutzer-Token wird nicht an die Ziel-API weitergereicht —
  das wäre ein Confused Deputy. Stattdessen Token-Exchange nach RFC 8693, siehe
  `src/token-exchange.ts`.
- **Rate-Limits der Ziel-API.** Das Limit hier schützt diesen Server; das Kontingent dort ist ein
  zweites, das eigenes Budgetieren braucht.
- **Fehlerdurchreichung.** Fehler der Ziel-API dürfen nicht roh nach außen gehen: sie enthalten
  regelmäßig interne Pfade, Konto-IDs oder Feldnamen. `dispatch` in `src/server.ts` beantwortet
  Unerwartetes generisch und loggt die Ursache nur intern.
