# Ønsketur (MVP)

Mobilvennlig webapp som foreslår gåturer basert på ønsket antall skritt.

## Funksjoner

- Velg startpunkt ved å trykke i kartet (pin oppdateres).
- Skriv inn ønsket antall skritt og hent turforslag.
- Turforslag må være innen ±200 skritt fra ønsket verdi.
- Skrittestimat beregnes fra gådistanse (gåprofil) i ruten.
- Turkandidater bygges primært fra faktiske gåbare stier, gangveier og veier i OpenStreetMap (med fallback hvis datasøk feiler).
- Rutesøk kjøres i parallelle batcher for raskere forslag.
- Start tur med enkel turn-by-turn veiledning i appen.
- Du kan åpne samme rute i Google Maps for ekstern navigator.
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

## Publisering på GitHub Pages

Repoet er satt opp med workflow for automatisk publisering ved push til `main`.

- Forventet URL: `https://robertskaug.github.io/gledeskritt/`
- Første gang: gå til repo → **Settings** → **Pages** og sett **Source** til **GitHub Actions**.
- Deretter publiseres nye endringer automatisk.

## Teknisk

- Kart: Leaflet + CARTO (OpenStreetMap-data)
- Ruting: OSRM demo-endepunkt (`router.project-osrm.org`)
- Lagring: `localStorage`