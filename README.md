# Ønsketur (MVP)

Mobilvennlig webapp som foreslår gåturer basert på ønsket antall skritt.

## Funksjoner

- Velg startpunkt ved å trykke i kartet (pin oppdateres).
- Skriv inn ønsket antall skritt og hent turforslag.
- Foreslåtte turer logges lokalt i nettleseren.
- Tidligere forslag blir markert som brukt, så samme tur ikke foreslås igjen.

## Kjøring lokalt

Siden bruker eksterne kart/rute-tjenester og bør kjøres via en enkel lokal server.

### Alternativ 1: Python

```bash
python -m http.server 8080
```

Åpne: `http://localhost:8080`

### Alternativ 2: VS Code Live Server

Åpne `index.html` med Live Server.

## Mobilbruk

1. Start lokal server.
2. Finn PC-ens lokale IP og åpne `http://<ip>:8080` på mobilen i samme nett.
3. Tillat posisjon for enklere startpunkt.

## Installerbar app (PWA)

- I støttede nettlesere vises knappen **Installer app** i appen.
- Etter installasjon kan den åpnes fra hjemskjermen som en egen app.
- Første gang må enheten ha nett for å laste kart/rutetjenester.

## Teknisk

- Kart: Leaflet + OpenStreetMap
- Ruting: OSRM demo-endepunkt (`router.project-osrm.org`)
- Lagring: `localStorage`