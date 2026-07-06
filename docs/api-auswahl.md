# Ziel-API-Auswahl für den Showcase-Server (T-103)

> Kriterium: offen/dokumentiert, echter Nutzen, **noch keine gute, sichere MCP-Lösung** vorhanden.
> Der aktuelle Stand nutzt einen internen, mandantengetrennten Notes-Store als Domäne — läuft standalone,
> ohne fremde API-Keys, und demonstriert die Security-Schicht vollständig. Für die öffentliche Wirkung
> ("echte API") sollte eine der folgenden Kandidaten-APIs angebunden werden. Store-Interface (`TenantStore`)
> und Tool-Registry (`tools.ts`) sind so geschnitten, dass der Austausch lokal bleibt.

## Kandidaten (durch Gründer final wählen + verifizieren)
| API | Warum geeignet | Zu prüfen |
|-----|----------------|-----------|
| Ein populäres Open-Source-Tool mit REST-API (z. B. Ticketing/Docs/Notes-App) | Echter Nutzen, große Nutzerbasis, oft nur trivialer/kein MCP-Server vorhanden | Lizenz, Auth-Modell, ob schon guter MCP-Server existiert |
| Self-hosted SaaS mit dokumentierter API | Klarer Enterprise-Bezug (Mandanten!) | Testinstanz-Aufwand |
| Öffentliche Daten-API mit Nutzwert | Niedrige Einstiegshürde | Rate-Limits, ob "sicher" überhaupt relevant |

## Agenten-Rechercheauftrag (offen)
„Recherchiere 2026 populäre Open-Source-Software mit dokumentierter REST-API, für die es **keinen guten,
sicheren** MCP-Server gibt. Pro Kandidat: API-Doku-Link, Auth-Modell, existierende MCP-Server (Qualität),
Lizenz. Priorisiere nach Sichtbarkeit + Multi-Tenancy-Relevanz." (Quellen mit Datum.)

## Entscheidung
- Aktuell: interner Notes-Store (standalone lauffähig). 
- Final: _(offen — Gründer trägt gewählte API + Begründung in `docs/entscheidungen.md` ein)_
