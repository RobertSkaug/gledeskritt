const WALKING_STRIDE_METERS = 0.75;
const STEP_TOLERANCE = 100;
const METER_TOLERANCE = STEP_TOLERANCE * WALKING_STRIDE_METERS;
const HISTORY_KEY = "onsketur_history_v1";
const SEEN_KEY = "onsketur_seen_v1";
const MAX_CANDIDATES = 18;
const MAX_SEARCH_ROUNDS = 3;
const MANEUVER_REACHED_METERS = 25;

const stepsInput = document.getElementById("steps");
const suggestBtn = document.getElementById("suggestBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const installBtn = document.getElementById("installBtn");
const startNavBtn = document.getElementById("startNavBtn");
const stopNavBtn = document.getElementById("stopNavBtn");
const googleNavBtn = document.getElementById("googleNavBtn");
const statusEl = document.getElementById("status");
const suggestionEl = document.getElementById("suggestion");
const historyListEl = document.getElementById("historyList");
const navInstructionEl = document.getElementById("navInstruction");
const navMetaEl = document.getElementById("navMeta");

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
let userMarker = null;

let currentRoute = null;
let navWatchId = null;
let navStepIndex = 0;

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

function toLatLngFromManeuver(step) {
  return {
    lat: step.maneuver.location[1],
    lng: step.maneuver.location[0],
  };
}

function haversineMeters(a, b) {
  const r = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const x = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * r * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function roundMeters(value) {
  return Math.max(0, Math.round(value / 10) * 10);
}

function formatDistance(meters) {
  if (meters < 1000) {
    return `${roundMeters(meters)} m`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
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

function maneuverText(step) {
  const type = step.maneuver.type || "continue";
  const modifier = step.maneuver.modifier || "straight";
  const road = step.name ? ` på ${step.name}` : "";

  if (type === "depart") {
    return `Start og gå${road}`;
  }
  if (type === "arrive") {
    return "Du er framme ved startpunktet.";
  }
  if (type === "roundabout") {
    return `Ta rundkjøring${road}`;
  }
  if (type === "turn") {
    if (modifier.includes("left")) {
      return `Sving til venstre${road}`;
    }
    if (modifier.includes("right")) {
      return `Sving til høyre${road}`;
    }
  }
  if (modifier.includes("left")) {
    return `Hold til venstre${road}`;
  }
  if (modifier.includes("right")) {
    return `Hold til høyre${road}`;
  }
  return `Fortsett${road}`;
}

function flattenSteps(legs) {
  const result = [];
  for (const leg of legs || []) {
    for (const step of leg.steps || []) {
      if (step && step.maneuver && Array.isArray(step.maneuver.location)) {
        result.push(step);
      }
    }
  }
  return result;
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

  const url = `https://router.project-osrm.org/route/v1/foot/${coordinates}?overview=full&geometries=geojson&steps=true`;
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
    legs: route.legs,
    waypoints: [candidate.w1, candidate.w2],
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

function resetNavigationUi() {
  navInstructionEl.textContent = "Velg et turforslag for å starte navigasjon.";
  navMetaEl.textContent = "Ingen aktiv tur.";
  startNavBtn.disabled = !currentRoute;
  stopNavBtn.disabled = true;
}

function setCurrentRoute(route) {
  currentRoute = route;
  navStepIndex = 0;
  if (currentRoute) {
    startNavBtn.disabled = false;
    googleNavBtn.classList.remove("hidden");
    const first = currentRoute.steps[0];
    navInstructionEl.textContent = first ? maneuverText(first) : "Start turen.";
    navMetaEl.textContent = `Estimert ${Math.round(currentRoute.meters / WALKING_STRIDE_METERS)} skritt.`;
  } else {
    googleNavBtn.classList.add("hidden");
    resetNavigationUi();
  }
}

function stopNavigation() {
  if (navWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(navWatchId);
  }
  navWatchId = null;
  stopNavBtn.disabled = true;
  startNavBtn.disabled = !currentRoute;

  if (userMarker) {
    userMarker.remove();
    userMarker = null;
  }
}

function updateNavigationProgress(position) {
  if (!currentRoute || !currentRoute.steps.length) {
    return;
  }

  const here = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
  };

  if (!userMarker) {
    userMarker = L.circleMarker([here.lat, here.lng], {
      radius: 7,
      color: "#1565c0",
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).addTo(map);
  } else {
    userMarker.setLatLng([here.lat, here.lng]);
  }

  while (navStepIndex < currentRoute.steps.length - 1) {
    const targetStep = currentRoute.steps[navStepIndex];
    const targetPoint = toLatLngFromManeuver(targetStep);
    const distanceToTarget = haversineMeters(here, targetPoint);
    if (distanceToTarget <= MANEUVER_REACHED_METERS) {
      navStepIndex += 1;
    } else {
      break;
    }
  }

  const step = currentRoute.steps[navStepIndex];
  if (!step) {
    navInstructionEl.textContent = "Du er framme.";
    navMetaEl.textContent = "Turen er fullført.";
    stopNavigation();
    return;
  }

  const stepPoint = toLatLngFromManeuver(step);
  const toNextManeuver = haversineMeters(here, stepPoint);
  const remainingStepsDistance = currentRoute.steps
    .slice(navStepIndex + 1)
    .reduce((sum, item) => sum + (item.distance || 0), 0);
  const remainingDistance = toNextManeuver + remainingStepsDistance;
  const remainingSteps = Math.round(remainingDistance / WALKING_STRIDE_METERS);

  navInstructionEl.textContent = maneuverText(step);
  navMetaEl.textContent = `Neste punkt om ${formatDistance(toNextManeuver)}. Gjenstår ca. ${remainingSteps} skritt.`;
}

function startNavigation() {
  if (!currentRoute) {
    return;
  }
  if (!navigator.geolocation) {
    navMetaEl.textContent = "Geolokasjon støttes ikke på denne enheten.";
    return;
  }

  stopNavigation();
  navStepIndex = 0;
  startNavBtn.disabled = true;
  stopNavBtn.disabled = false;
  navMetaEl.textContent = "Starter GPS-navigasjon…";

  navWatchId = navigator.geolocation.watchPosition(
    (position) => {
      updateNavigationProgress(position);
    },
    () => {
      navMetaEl.textContent = "Fikk ikke GPS-posisjon. Sjekk stedstjenester.";
      stopNavigation();
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 1000,
    }
  );
}

function openGoogleMapsNavigation() {
  if (!currentRoute) {
    return;
  }

  const origin = `${startPoint.lat},${startPoint.lng}`;
  const destination = origin;
  const waypoints = (currentRoute.waypoints || [])
    .map((point) => `${point.lat},${point.lng}`)
    .join("|");

  const params = new URLSearchParams({
    api: "1",
    origin,
    destination,
    travelmode: "walking",
    dir_action: "navigate",
  });

  if (waypoints) {
    params.set("waypoints", waypoints);
  }

  const url = `https://www.google.com/maps/dir/?${params.toString()}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

async function suggestRoute() {
  const requestedSteps = Number(stepsInput.value);
  if (!Number.isFinite(requestedSteps) || requestedSteps < 500) {
    statusEl.textContent = "Skriv inn minst 500 skritt.";
    return;
  }

  const targetMeters = requestedSteps * WALKING_STRIDE_METERS;
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
        const bestSteps = Math.round(best.meters / WALKING_STRIDE_METERS);
        const stepDelta = Math.abs(bestSteps - requestedSteps);
        statusEl.textContent = `Fant ingen nye turer innen ±${STEP_TOLERANCE} skritt. Nærmeste var ${stepDelta} skritt unna.`;
      } else {
        statusEl.textContent = `Fant ingen nye turer innen ±${STEP_TOLERANCE} skritt. Prøv annet startpunkt.`;
      }
      suggestionEl.textContent = "Ingen rute innen ønsket toleranse akkurat nå.";
      setCurrentRoute(null);
      stopNavigation();
      return;
    }

    drawRoute(accepted.geometry);
    stopNavigation();

    const distanceKm = (accepted.meters / 1000).toFixed(2);
    const estimatedSteps = Math.round(accepted.meters / WALKING_STRIDE_METERS);
    const stepDelta = Math.abs(estimatedSteps - requestedSteps);
    const steps = flattenSteps(accepted.legs);

    setCurrentRoute({ ...accepted, steps });

    suggestionEl.textContent = `Ca. ${distanceKm} km (${estimatedSteps} skritt), estimert tid ${formatDuration(accepted.seconds)}.`;
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
      accepted.hash
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
startNavBtn.addEventListener("click", startNavigation);
stopNavBtn.addEventListener("click", () => {
  stopNavigation();
  navMetaEl.textContent = "Navigasjon stoppet.";
});
googleNavBtn.addEventListener("click", openGoogleMapsNavigation);

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
setCurrentRoute(null);

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
