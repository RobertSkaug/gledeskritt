const WALKING_STRIDE_METERS = 0.75;
const MIN_STEPS = 500;
const MIN_METERS = Math.round(MIN_STEPS * WALKING_STRIDE_METERS);
const HISTORY_KEY = "onsketur_history_v1";
const SEEN_KEY = "onsketur_seen_v1";
const ROUTE_OPTION_LIMIT = 3;
const CANDIDATE_BATCH_SIZE = 4;
const MAX_CANDIDATE_ROUNDS = 8;
const MANEUVER_REACHED_METERS = 25;
const ROUTE_OPTION_COLORS = ["#1565c0", "#2e7d32", "#ef6c00"];
const OSLO_CENTER = { lat: 59.9139, lng: 10.7522 };

const stepsInput = document.getElementById("steps");
const metersInput = document.getElementById("meters");
const toleranceInput = document.getElementById("tolerancePct");
const suggestBtn = document.getElementById("suggestBtn");
const drawLassoBtn = document.getElementById("drawLassoBtn");
const clearLassoBtn = document.getElementById("clearLassoBtn");
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

let map = null;
let directionsService = null;
let startMarker = null;
let lassoPolygon = null;
let drawingManager = null;
let userMarker = null;
let routePolylines = [];

let startPoint = { ...OSLO_CENTER };
let currentSuggestions = [];
let selectedSuggestionIndex = -1;
let currentRoute = null;
let navWatchId = null;
let navStepIndex = 0;
let isSyncingInputs = false;

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

function roundMeters(value) {
  return Math.max(0, Math.round(value / 10) * 10);
}

function stepsToMeters(steps) {
  return roundMeters(steps * WALKING_STRIDE_METERS);
}

function metersToSteps(meters) {
  return Math.max(0, Math.round(meters / WALKING_STRIDE_METERS));
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

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function syncMetersFromSteps() {
  if (isSyncingInputs) {
    return;
  }

  const steps = Number(stepsInput.value);
  if (!Number.isFinite(steps) || steps <= 0) {
    return;
  }

  isSyncingInputs = true;
  metersInput.value = String(stepsToMeters(steps));
  isSyncingInputs = false;
}

function syncStepsFromMeters() {
  if (isSyncingInputs) {
    return;
  }

  const meters = Number(metersInput.value);
  if (!Number.isFinite(meters) || meters <= 0) {
    return;
  }

  isSyncingInputs = true;
  stepsInput.value = String(metersToSteps(meters));
  isSyncingInputs = false;
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

function routeColor(index) {
  return ROUTE_OPTION_COLORS[index] || ROUTE_OPTION_COLORS[0];
}

function saveSuggestion(entry, routeHash) {
  const history = getHistory();
  history.unshift(entry);
  saveJson(HISTORY_KEY, history.slice(0, 100));

  const seen = new Set(getSeen());
  seen.add(routeHash);
  saveJson(SEEN_KEY, Array.from(seen));
}

function hashRouteFromPath(path, meters) {
  if (!path.length) {
    return `empty|${Math.round(meters / 50)}`;
  }

  const first = path[0];
  const mid = path[Math.floor(path.length / 2)];
  const last = path[path.length - 1];

  return [
    first.lat().toFixed(4),
    first.lng().toFixed(4),
    mid.lat().toFixed(4),
    mid.lng().toFixed(4),
    last.lat().toFixed(4),
    last.lng().toFixed(4),
    Math.round(meters / 50),
  ].join("|");
}

function clearRoutePolylines() {
  for (const polyline of routePolylines) {
    polyline.setMap(null);
  }
  routePolylines = [];
}

function drawRouteOptions(routes, selectedIndex = 0) {
  clearRoutePolylines();

  if (!map || !routes.length) {
    return;
  }

  const bounds = new google.maps.LatLngBounds();

  routes.forEach((route, index) => {
    const isSelected = index === selectedIndex;
    const polyline = new google.maps.Polyline({
      map,
      path: route.path,
      strokeColor: routeColor(index),
      strokeOpacity: isSelected ? 0.95 : 0.55,
      strokeWeight: isSelected ? 6 : 4,
      clickable: true,
    });

    polyline.addListener("click", () => {
      selectSuggestion(index);
    });

    route.path.forEach((point) => bounds.extend(point));
    routePolylines.push(polyline);
  });

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, 48);
  }
}

function flattenGoogleSteps(legs) {
  const result = [];
  for (const leg of legs || []) {
    for (const step of leg.steps || []) {
      if (step && step.end_location) {
        result.push(step);
      }
    }
  }
  return result;
}

function renderSuggestionOptions() {
  if (!currentSuggestions.length) {
    suggestionEl.textContent = "Ingen tur innen valgt slingringsmonn akkurat nå.";
    return;
  }

  suggestionEl.innerHTML = "";
  const list = document.createElement("div");
  list.className = "suggestion-options";

  currentSuggestions.forEach((route, index) => {
    const distanceKm = (route.meters / 1000).toFixed(2);
    const estimatedSteps = Math.round(route.meters / WALKING_STRIDE_METERS);
    const meterValue = roundMeters(route.meters);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-option secondary";
    if (index === selectedSuggestionIndex) {
      button.classList.add("selected");
    }

    button.innerHTML = `
      <span class="suggestion-swatch" style="--swatch:${routeColor(index)}"></span>
      <span class="suggestion-text">Forslag ${index + 1}: ca. ${meterValue} m (${distanceKm} km / ${estimatedSteps} skritt), ${formatDuration(route.seconds)}</span>
    `;

    button.addEventListener("click", () => {
      selectSuggestion(index);
    });

    list.appendChild(button);
  });

  suggestionEl.appendChild(list);
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
    navInstructionEl.textContent = first
      ? stripHtml(first.instructions || "Start turen")
      : "Start turen.";
    navMetaEl.textContent = `Estimert ${Math.round(currentRoute.meters / WALKING_STRIDE_METERS)} skritt.`;
  } else {
    googleNavBtn.classList.add("hidden");
    resetNavigationUi();
  }
}

function setSuggestions(routes) {
  currentSuggestions = routes;
  selectedSuggestionIndex = routes.length ? 0 : -1;
  renderSuggestionOptions();

  if (!routes.length) {
    clearRoutePolylines();
  }
}

function selectSuggestion(index) {
  const route = currentSuggestions[index];
  if (!route) {
    return;
  }

  selectedSuggestionIndex = index;
  stopNavigation();
  setCurrentRoute(route);
  renderSuggestionOptions();
  drawRouteOptions(currentSuggestions, selectedSuggestionIndex);

  const meterDelta = roundMeters(Math.abs(route.meters - Number(metersInput.value)));
  statusEl.textContent = `Valgte forslag ${index + 1} av ${currentSuggestions.length} (avvik ${meterDelta} meter).`;
}

function clearLasso() {
  if (lassoPolygon) {
    lassoPolygon.setMap(null);
    lassoPolygon = null;
  }
}

function setStartPoint(latLngLiteral, text = "Startpunkt valgt i kartet.") {
  startPoint = {
    lat: latLngLiteral.lat,
    lng: latLngLiteral.lng,
  };

  if (!startMarker) {
    startMarker = new google.maps.Marker({
      map,
      position: startPoint,
      draggable: true,
      title: "Startpunkt",
    });

    startMarker.addListener("dragend", () => {
      const pos = startMarker.getPosition();
      if (!pos) {
        return;
      }
      setStartPoint({ lat: pos.lat(), lng: pos.lng() }, "Startpunkt oppdatert via pin.");
    });
  } else {
    startMarker.setPosition(startPoint);
  }

  statusEl.textContent = text;
}

function getLassoBounds(path) {
  const bounds = new google.maps.LatLngBounds();
  path.forEach((point) => bounds.extend(point));
  return bounds;
}

function randomPointInBounds(bounds) {
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();

  const lat = sw.lat() + Math.random() * (ne.lat() - sw.lat());
  const lng = sw.lng() + Math.random() * (ne.lng() - sw.lng());
  return new google.maps.LatLng(lat, lng);
}

function pickRandomPointInLasso(path, bounds, maxTries = 60) {
  for (let i = 0; i < maxTries; i += 1) {
    const candidate = randomPointInBounds(bounds);
    if (google.maps.geometry.poly.containsLocation(candidate, lassoPolygon)) {
      return candidate;
    }
  }

  return null;
}

function buildWaypointSet(path, bounds, waypointCount) {
  const waypoints = [];
  const used = new Set();

  while (waypoints.length < waypointCount) {
    const point = pickRandomPointInLasso(path, bounds);
    if (!point) {
      break;
    }

    const key = `${point.lat().toFixed(5)}|${point.lng().toFixed(5)}`;
    if (used.has(key)) {
      continue;
    }

    const fromStart = google.maps.geometry.spherical.computeDistanceBetween(
      point,
      new google.maps.LatLng(startPoint.lat, startPoint.lng)
    );

    if (fromStart < 120) {
      continue;
    }

    used.add(key);
    waypoints.push(point);
  }

  if (waypoints.length !== waypointCount) {
    return [];
  }

  return waypoints;
}

function routeLoop(waypoints) {
  return new Promise((resolve, reject) => {
    directionsService.route(
      {
        origin: startPoint,
        destination: startPoint,
        travelMode: google.maps.TravelMode.WALKING,
        avoidHighways: true,
        provideRouteAlternatives: false,
        optimizeWaypoints: false,
        waypoints: waypoints.map((point) => ({
          location: point,
          stopover: true,
        })),
      },
      (result, status) => {
        if (status !== "OK" || !result || !result.routes || !result.routes.length) {
          reject(new Error(status || "NO_ROUTE"));
          return;
        }
        resolve(result.routes[0]);
      }
    );
  });
}

function routeMeters(route) {
  return (route.legs || []).reduce((sum, leg) => sum + (leg.distance?.value || 0), 0);
}

function routeSeconds(route) {
  return (route.legs || []).reduce((sum, leg) => sum + (leg.duration?.value || 0), 0);
}

async function findRouteSuggestions(targetMeters, toleranceMeters) {
  if (!lassoPolygon) {
    statusEl.textContent = "Tegn en lasso i kartet først.";
    return [];
  }

  const path = lassoPolygon.getPath();
  const bounds = getLassoBounds(path);
  const seenHashes = new Set(getSeen());
  const accepted = [];
  const best = [];

  for (let round = 0; round < MAX_CANDIDATE_ROUNDS && accepted.length < ROUTE_OPTION_LIMIT; round += 1) {
    const waypointCount = round < 4 ? 2 : 3;
    const jobs = [];

    for (let i = 0; i < CANDIDATE_BATCH_SIZE; i += 1) {
      const waypoints = buildWaypointSet(path, bounds, waypointCount);
      if (waypoints.length === waypointCount) {
        jobs.push(routeLoop(waypoints).then((route) => ({ route, waypoints })));
      }
    }

    if (!jobs.length) {
      continue;
    }

    const results = await Promise.allSettled(jobs);

    for (const item of results) {
      if (item.status !== "fulfilled") {
        continue;
      }

      const route = item.value.route;
      const waypoints = item.value.waypoints;
      const pathPoints = route.overview_path || [];
      if (!pathPoints.length) {
        continue;
      }

      const meters = routeMeters(route);
      const seconds = routeSeconds(route);
      const hash = hashRouteFromPath(pathPoints, meters);

      if (seenHashes.has(hash)) {
        continue;
      }

      const candidate = {
        meters,
        seconds,
        hash,
        path: pathPoints,
        legs: route.legs || [],
        steps: flattenGoogleSteps(route.legs || []),
        waypoints: waypoints.map((point) => ({ lat: point.lat(), lng: point.lng() })),
      };

      const diff = Math.abs(meters - targetMeters);
      if (diff <= toleranceMeters) {
        accepted.push(candidate);
      } else {
        best.push({ candidate, diff });
      }
    }

    accepted.sort((a, b) => Math.abs(a.meters - targetMeters) - Math.abs(b.meters - targetMeters));
  }

  if (accepted.length) {
    return accepted.slice(0, ROUTE_OPTION_LIMIT);
  }

  best.sort((a, b) => a.diff - b.diff);
  return best.slice(0, ROUTE_OPTION_LIMIT).map((item) => item.candidate);
}

function toStepPoint(step) {
  return step.end_location;
}

function maneuverText(step) {
  return stripHtml(step.instructions || "Fortsett");
}

function stopNavigation() {
  if (navWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(navWatchId);
  }
  navWatchId = null;
  stopNavBtn.disabled = true;
  startNavBtn.disabled = !currentRoute;

  if (userMarker) {
    userMarker.setMap(null);
    userMarker = null;
  }
}

function updateNavigationProgress(position) {
  if (!currentRoute || !currentRoute.steps.length) {
    return;
  }

  const here = new google.maps.LatLng(position.coords.latitude, position.coords.longitude);

  if (!userMarker) {
    userMarker = new google.maps.Marker({
      map,
      position: here,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: "#ffffff",
        fillOpacity: 1,
        strokeColor: "#1565c0",
        strokeWeight: 2,
      },
      zIndex: 1000,
    });
  } else {
    userMarker.setPosition(here);
  }

  while (navStepIndex < currentRoute.steps.length - 1) {
    const targetStep = currentRoute.steps[navStepIndex];
    const targetPoint = toStepPoint(targetStep);
    const distanceToTarget = google.maps.geometry.spherical.computeDistanceBetween(here, targetPoint);
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

  const stepPoint = toStepPoint(step);
  const toNext = google.maps.geometry.spherical.computeDistanceBetween(here, stepPoint);
  const remainingLegDistance = currentRoute.steps
    .slice(navStepIndex + 1)
    .reduce((sum, item) => sum + (item.distance?.value || 0), 0);
  const remainingDistance = toNext + remainingLegDistance;
  const remainingSteps = Math.round(remainingDistance / WALKING_STRIDE_METERS);

  navInstructionEl.textContent = maneuverText(step);
  navMetaEl.textContent = `Neste punkt om ${formatDistance(toNext)}. Gjenstår ca. ${remainingSteps} skritt.`;
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
  if (!directionsService || !map) {
    statusEl.textContent = "Google Maps er ikke lastet ennå.";
    return;
  }

  const targetMeters = Number(metersInput.value);
  if (!Number.isFinite(targetMeters) || targetMeters < MIN_METERS) {
    statusEl.textContent = `Skriv inn minst ${MIN_METERS} meter.`;
    return;
  }

  const tolerancePct = Math.max(2, Math.min(40, Number(toleranceInput.value) || 12));
  toleranceInput.value = String(tolerancePct);
  const toleranceMeters = Math.max(120, (targetMeters * tolerancePct) / 100);

  stepsInput.value = String(metersToSteps(targetMeters));
  statusEl.textContent = "Beregner 2–3 turforslag i lassoen…";
  suggestBtn.disabled = true;

  try {
    const suggestions = await findRouteSuggestions(targetMeters, toleranceMeters);

    if (!suggestions.length) {
      setSuggestions([]);
      setCurrentRoute(null);
      stopNavigation();
      statusEl.textContent = "Fant ingen ruter i lassoen. Utvid lasso eller øk slingringsmonn.";
      return;
    }

    setSuggestions(suggestions);
    selectSuggestion(0);

    const best = suggestions[0];
    const meterDelta = roundMeters(Math.abs(best.meters - targetMeters));
    statusEl.textContent = `Fant ${suggestions.length} forslag i lassoen (beste avvik ${meterDelta} meter).`;

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
        steps: Math.round(best.meters / WALKING_STRIDE_METERS),
        distanceKm: (best.meters / 1000).toFixed(2),
      },
      best.hash
    );

    renderHistory();
  } catch (error) {
    statusEl.textContent = "Noe gikk galt ved rutehenting. Prøv igjen.";
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

function initMapUi() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: startPoint,
    zoom: 14,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true,
    gestureHandling: "greedy",
  });

  directionsService = new google.maps.DirectionsService();

  setStartPoint(startPoint, "Trykk i kartet for å velge startpunkt.");

  map.addListener("click", (event) => {
    if (!event.latLng) {
      return;
    }
    setStartPoint(
      {
        lat: event.latLng.lat(),
        lng: event.latLng.lng(),
      },
      "Startpunkt valgt i kartet."
    );
  });

  drawingManager = new google.maps.drawing.DrawingManager({
    drawingMode: null,
    drawingControl: false,
    polygonOptions: {
      fillColor: "#1565c0",
      fillOpacity: 0.12,
      strokeColor: "#1565c0",
      strokeOpacity: 0.9,
      strokeWeight: 2,
      editable: true,
      clickable: false,
    },
  });

  drawingManager.setMap(map);

  google.maps.event.addListener(drawingManager, "polygoncomplete", (polygon) => {
    clearLasso();
    lassoPolygon = polygon;
    drawingManager.setDrawingMode(null);
    statusEl.textContent = "Lasso klar. Trykk 'Få turforslag'.";
  });

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latlng = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        map.setCenter(latlng);
        setStartPoint(latlng, "Posisjon funnet. Tegn lasso rundt ønsket område.");
      },
      () => {
        statusEl.textContent = "Bruker standardposisjon. Tegn lasso i kartet.";
      },
      { enableHighAccuracy: true, timeout: 6000 }
    );
  }
}

function ensureGoogleMapsLoaded() {
  const apiKey = window.APP_CONFIG?.GOOGLE_MAPS_API_KEY || "";

  if (!apiKey || apiKey.includes("SET_ME")) {
    statusEl.textContent = "Sett GOOGLE_MAPS_API_KEY i config.js for full Google Maps.";
    suggestBtn.disabled = true;
    drawLassoBtn.disabled = true;
    clearLassoBtn.disabled = true;
    return;
  }

  window.initGoogleMap = () => {
    initMapUi();
    suggestBtn.disabled = false;
    drawLassoBtn.disabled = false;
    clearLassoBtn.disabled = false;
  };

  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geometry,drawing&v=weekly&callback=initGoogleMap`;
  script.async = true;
  script.defer = true;
  script.onerror = () => {
    statusEl.textContent = "Kunne ikke laste Google Maps. Sjekk API-nøkkel/restriksjoner.";
  };
  document.head.appendChild(script);
}

stepsInput.addEventListener("input", syncMetersFromSteps);
metersInput.addEventListener("input", syncStepsFromMeters);
suggestBtn.addEventListener("click", suggestRoute);
clearHistoryBtn.addEventListener("click", clearHistory);
startNavBtn.addEventListener("click", startNavigation);
stopNavBtn.addEventListener("click", () => {
  stopNavigation();
  navMetaEl.textContent = "Navigasjon stoppet.";
});
googleNavBtn.addEventListener("click", openGoogleMapsNavigation);

drawLassoBtn.addEventListener("click", () => {
  if (!drawingManager) {
    return;
  }
  drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  statusEl.textContent = "Tegn en lasso i kartet og dobbeltklikk for å fullføre.";
});

clearLassoBtn.addEventListener("click", () => {
  clearLasso();
  statusEl.textContent = "Lasso fjernet. Tegn ny lasso for forslag.";
});

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
syncStepsFromMeters();
setSuggestions([]);
setCurrentRoute(null);
ensureGoogleMapsLoaded();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    const host = window.location.hostname;
    const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";

    if (isLocalHost) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      } catch (error) {
        console.error("Kunne ikke fjerne service worker i utvikling:", error);
      }
      return;
    }

    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.error("Service worker feilet:", error);
    });
  });
}
