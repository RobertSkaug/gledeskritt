# Ønsketur (MVP)

Mobilvennlig webapp som foreslår gåturer i Google Maps basert på ønsket distanse/skritt.

## Funksjoner

- Velg startpunkt ved å trykke i kartet (pin oppdateres).
- Tegn en lasso i kartet for ønsket område.
- Skriv inn ønsket distanse/skritt og slingringsmonn.
- Få 2–3 fargekodede turforslag innenfor lassoen.
- Skrittestimat beregnes fra gådistanse i ruten.
- Start tur med enkel turn-by-turn veiledning i appen.
- Du kan åpne samme rute i Google Maps for ekstern navigator.
- Foreslåtte turer logges lokalt i nettleseren.
- Tidligere forslag blir markert som brukt, så samme tur ikke foreslås igjen.

## Google Maps-oppsett

Appen krever Google Maps JavaScript API med aktiv API-nøkkel.

1. Opprett API-nøkkel i Google Cloud.
2. Aktiver disse API-ene:
	 - Maps JavaScript API
	 - Directions API
3. Legg nøkkelen i `config.js`:

```js
window.APP_CONFIG = {
	GOOGLE_MAPS_API_KEY: "DIN_NOKKEL_HER",
};
```

Tips: Begrens nøkkelen til ditt domene og riktige API-er i Google Cloud Console.

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

- Kart + ruting: Google Maps JavaScript API + Directions API
- Lagring: `localStorage`