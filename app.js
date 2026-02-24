const METERS_PER_STEP = 0.75;
const STEP_TOLERANCE = 100;
const METER_TOLERANCE = STEP_TOLERANCE * METERS_PER_STEP;
const HISTORY_KEY = "onsketur_history_v1";
const SEEN_KEY = "onsketur_seen_v1";
const MAX_CANDIDATES = 18;
const MAX_SEARCH_ROUNDS = 3;

const stepsInput = document.getElementById("steps");
const suggestBtn = document.getElementById("suggestBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const installBtn = document.getElementById("installBtn");
const statusEl = document.getElementById("status");
const suggestionEl = document.getElementById("suggestion");
const historyListEl = document.getElementById("historyList");
let deferredInstallPrompt = null;

const map = L.map("map", {
  zoomControl: true,
  tap: true,
});

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap",
}).addTo(map);

let startPoint = { lat: 59.9139, lng: 10.7522 };
let startMarker = null;
let routeLine = null;

function loadJson(key, fallback) {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getHistory() {
  return loadJson(HISTORY_KEY, []);
}

function getSeen() {
  return loadJson(SEEN_KEY, []);
}

function renderHistory() {
  const history = getHistory();
  historyListEl.innerHTML = "";

  if (!history.length) {
    const item = document.createElement("li");
    item.textContent = "Ingen tidligere forslag.";
    historyListEl.appendChild(item);
    return;
  }

  for (const entry of history.slice(0, 10)) {
    const item = document.createElement("li");
    item.textContent = `${entry.when} – ${entry.steps} skritt (~${entry.distanceKm} km)`;
    historyListEl.appendChild(item);
  }
}

function setStartPoint(latlng, text = "Startpunkt valgt i kartet.") {
  startPoint = { lat: latlng.lat, lng: latlng.lng };
  if (!startMarker) {
    startMarker = L.marker(latlng, { draggable: true }).addTo(map);
    startMarker.on("dragend", (event) => {
      const pos = event.target.getLatLng();
      setStartPoint(pos, "Startpunkt oppdatert via pin.");
    });
  } else {
    startMarker.setLatLng(latlng);
  }
  statusEl.textContent = text;
}

function hashRoute(geometry, meters) {
  const first = geometry.coordinates[0];
  const last = geometry.coordinates[geometry.coordinates.length - 1];
  const mid = geometry.coordinates[Math.floor(geometry.coordinates.length / 2)];
  return [
    first[0].toFixed(4),
    first[1].toFixed(4),
    mid[0].toFixed(4),
    mid[1].toFixed(4),
    last[0].toFixed(4),
    last[1].toFixed(4),
    Math.round(meters / 50),
  ].join("|");
}

function destinationPoint(lat, lng, distanceMeters, bearingDegrees) {
  const radius = 6371000;
  const bearing = (bearingDegrees * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const dByR = distanceMeters / radius;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dByR) +
      Math.cos(lat1) * Math.sin(dByR) * Math.cos(bearing)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(dByR) * Math.cos(lat1),
      Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: (lat2 * 180) / Math.PI,
    lng: (lng2 * 180) / Math.PI,
  };
}

async function fetchRouteForCandidate(candidate) {
  const coordinates = [
    `${startPoint.lng},${startPoint.lat}`,
    `${candidate.w1.lng},${candidate.w1.lat}`,
    `${candidate.w2.lng},${candidate.w2.lat}`,
    `${startPoint.lng},${startPoint.lat}`,
  ].join(";");

  const url = `https://router.project-osrm.org/route/v1/foot/${coordinates}?overview=full&geometries=geojson`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Kunne ikke hente rute fra rutetjeneste.");
  }

  const data = await response.json();
  if (!data.routes || !data.routes.length) {
    return null;
  }

  const route = data.routes[0];
  return {
    meters: route.distance,
    seconds: route.duration,
    geometry: route.geometry,
  };
}

function buildCandidates(targetMeters, round = 0) {
  const radius = Math.max(250, targetMeters / 3.2);
  const candidates = [];
  const base = (Math.random() * 360 + round * 31) % 360;

  for (let i = 0; i < MAX_CANDIDATES; i += 1) {
    const firstBearing = (base + i * 23) % 360;
    const secondBearing = (firstBearing + 110 + (i % 5) * 6) % 360;

    candidates.push({
      w1: destinationPoint(startPoint.lat, startPoint.lng, radius, firstBearing),
      w2: destinationPoint(startPoint.lat, startPoint.lng, radius * 0.85, secondBearing),
    });
  }

  return candidates;
}

function formatDuration(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) {
    return `${mins} min`;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} t ${m} min`;
}

function drawRoute(geometry) {
  const latlngs = geometry.coordinates.map(([lng, lat]) => [lat, lng]);

  if (routeLine) {
    routeLine.remove();
  }

  routeLine = L.polyline(latlngs, {
    color: "#1565c0",
    weight: 5,
    opacity: 0.9,
  }).addTo(map);

  map.fitBounds(routeLine.getBounds(), { padding: [32, 32] });
}

function saveSuggestion(entry, routeHash) {
  const history = getHistory();
  history.unshift(entry);
  saveJson(HISTORY_KEY, history.slice(0, 100));

  const seen = new Set(getSeen());
  seen.add(routeHash);
  saveJson(SEEN_KEY, Array.from(seen));
}

async function suggestRoute() {
  const steps = Number(stepsInput.value);
  if (!Number.isFinite(steps) || steps < 500) {
    statusEl.textContent = "Skriv inn minst 500 skritt.";
    return;
  }

  const targetMeters = steps * METERS_PER_STEP;
  statusEl.textContent = "Lager forslag…";
  suggestBtn.disabled = true;

  try {
    const seen = new Set(getSeen());
    let accepted = null;
    let best = null;
    let smallestDiff = Number.POSITIVE_INFINITY;

    for (let round = 0; round < MAX_SEARCH_ROUNDS && !accepted; round += 1) {
      const candidates = buildCandidates(targetMeters, round);

      for (const candidate of candidates) {
        const route = await fetchRouteForCandidate(candidate);
        if (!route) {
          continue;
        }

        const hash = hashRoute(route.geometry, route.meters);
        if (seen.has(hash)) {
          continue;
        }

        const diff = Math.abs(route.meters - targetMeters);
        if (diff < smallestDiff) {
          best = { ...route, hash };
          smallestDiff = diff;
        }

        if (diff <= METER_TOLERANCE) {
          accepted = { ...route, hash };
          break;
        }
      }
    }

    if (!accepted) {
      if (best) {
        const bestSteps = Math.round(best.meters / METERS_PER_STEP);
        const stepDelta = Math.abs(bestSteps - steps);
        statusEl.textContent = `Fant ingen nye turer innen ±${STEP_TOLERANCE} skritt. Nærmeste var ${stepDelta} skritt unna.`;
      } else {
        statusEl.textContent = `Fant ingen nye turer innen ±${STEP_TOLERANCE} skritt. Prøv annet startpunkt.`;
      }
      suggestionEl.textContent = "Ingen rute innen ønsket toleranse akkurat nå.";
      return;
    }

    const bestMatch = accepted;

    if (!bestMatch) {
      statusEl.textContent = "Fant ingen nye turer nå. Prøv annet startpunkt eller skrittmål.";
      return;
    }

    drawRoute(bestMatch.geometry);
    const distanceKm = (bestMatch.meters / 1000).toFixed(2);
    const estimatedSteps = Math.round(bestMatch.meters / METERS_PER_STEP);

    const stepDelta = Math.abs(estimatedSteps - steps);
    suggestionEl.textContent = `Ca. ${distanceKm} km (${estimatedSteps} skritt), estimert tid ${formatDuration(bestMatch.seconds)}.`;
    statusEl.textContent = `Nytt turforslag klart (avvik ${stepDelta} skritt).`;

    const now = new Date();
    saveSuggestion(
      {
        when: now.toLocaleString("no-NO", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        steps: estimatedSteps,
        distanceKm,
      },
      bestMatch.hash
    );

    renderHistory();
  } catch (error) {
    statusEl.textContent = "Noe gikk galt ved henting av rute. Prøv igjen.";
    console.error(error);
  } finally {
    suggestBtn.disabled = false;
  }
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem(SEEN_KEY);
  renderHistory();
  statusEl.textContent = "Logg tømt.";
}

map.on("click", (event) => {
  setStartPoint(event.latlng);
});

suggestBtn.addEventListener("click", suggestRoute);
clearHistoryBtn.addEventListener("click", clearHistory);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBtn.classList.remove("hidden");
});

installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.classList.add("hidden");
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installBtn.classList.add("hidden");
  statusEl.textContent = "App installert på enheten.";
});

renderHistory();
map.setView([startPoint.lat, startPoint.lng], 13);
setStartPoint(startPoint, "Trykk i kartet for å velge startpunkt.");

if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const latlng = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      map.setView([latlng.lat, latlng.lng], 14);
      setStartPoint(latlng, "Posisjon funnet. Du kan flytte pinnen eller trykke i kartet.");
    },
    () => {
      statusEl.textContent = "Bruker standardposisjon. Trykk i kartet for å velge startpunkt.";
    },
    { enableHighAccuracy: true, timeout: 6000 }
  );
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.error("Service worker feilet:", error);
    });
  });
}