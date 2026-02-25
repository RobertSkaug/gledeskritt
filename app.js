const WALKING_STRIDE_METERS = 0.75;
const MIN_STEPS = 500;
const MIN_METERS = Math.round(MIN_STEPS * WALKING_STRIDE_METERS);
const HISTORY_KEY = "onsketur_history_v1";
const SEEN_KEY = "onsketur_seen_v1";
const MAX_CANDIDATES = 20;
const MAX_SEARCH_ROUNDS = 3;
const MANEUVER_REACHED_METERS = 25;
const ROUTE_BATCH_SIZE = 6;
const OVERPASS_REQUEST_TIMEOUT_MS = 3000;
const WALKABLE_FETCH_SOFT_TIMEOUT_MS = 2500;
const WALKABLE_FETCH_RADIUS_MIN = 800;
const WALKABLE_FETCH_RADIUS_MAX = 5500;
const WALKABLE_MAX_WAYS = 450;
const SEARCH_STAGES = [
  {
    label: "±5%",
    tolerancePct: 0.05,
    radiusScale: 0.75,
    waypointCounts: [2, 3],
  },
  {
    label: "±10%",
    tolerancePct: 0.1,
    radiusScale: 0.95,
    waypointCounts: [2, 3, 4],
  },
  {
    label: "±15%",
    tolerancePct: 0.15,
    radiusScale: 1.2,
    waypointCounts: [3, 4],
  },
];
const OSLO_CENTER = { lat: 59.9139, lng: 10.7522 };
const OSLO_FALLBACK_MAX_DISTANCE = 6500;
const OSLO_FALLBACK_LOOPS = [
  {
    name: "Akerselva loop",
    approxMeters: 5200,
    waypoints: [
      { lat: 59.922, lng: 10.7537 },
      { lat: 59.9138, lng: 10.7411 },
      { lat: 59.9079, lng: 10.7582 },
    ],
  },
  {
    name: "Aker Brygge og Tjuvholmen",
    approxMeters: 4300,
    waypoints: [
      { lat: 59.9107, lng: 10.7286 },
      { lat: 59.9052, lng: 10.7237 },
      { lat: 59.9081, lng: 10.7375 },
    ],
  },
  {
    name: "Frognerparken loop",
    approxMeters: 6200,
    waypoints: [
      { lat: 59.9262, lng: 10.7065 },
      { lat: 59.9196, lng: 10.7023 },
      { lat: 59.9138, lng: 10.7218 },
    ],
  },
  {
    name: "St. Hanshaugen loop",
    approxMeters: 3800,
    waypoints: [
      { lat: 59.9254, lng: 10.7461 },
      { lat: 59.9201, lng: 10.7595 },
      { lat: 59.9138, lng: 10.7482 },
    ],
  },
  {
    name: "Ekeberg loop",
    approxMeters: 7100,
    waypoints: [
      { lat: 59.8987, lng: 10.7821 },
      { lat: 59.8937, lng: 10.7706 },
      { lat: 59.9052, lng: 10.7592 },
    ],
  },
  {
    name: "Bjørvika-Hovinbyen loop",
    approxMeters: 5600,
    waypoints: [
      { lat: 59.9083, lng: 10.7618 },
      { lat: 59.9176, lng: 10.7839 },
      { lat: 59.9135, lng: 10.7643 },
    ],
  },
];
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const WALKABLE_HIGHWAY_REGEX = [
  "footway",
  "path",
  "pedestrian",
  "living_street",
  "residential",
  "track",
  "service",
  "unclassified",
  "tertiary",
].join("|");

const stepsInput = document.getElementById("steps");
const metersInput = document.getElementById("meters");
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

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  subdomains: "abcd",
  attribution: '&copy; OpenStreetMap &copy; CARTO',
}).addTo(map);

let startPoint = { lat: 59.9139, lng: 10.7522 };
let startMarker = null;
let routeLine = null;
let userMarker = null;

let currentRoute = null;
let navWatchId = null;
let navStepIndex = 0;
let isSyncingInputs = false;
let walkableCache = {
  key: null,
  points: [],
};

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

function stepsToMeters(steps) {
  return roundMeters(steps * WALKING_STRIDE_METERS);
}

function metersToSteps(meters) {
  return Math.max(0, Math.round(meters / WALKING_STRIDE_METERS));
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

function normalizeBearingDelta(value) {
  const normalized = ((value % 360) + 360) % 360;
  return normalized > 180 ? 360 - normalized : normalized;
}

function bearingDegrees(from, to) {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const angle = (Math.atan2(y, x) * 180) / Math.PI;
  return (angle + 360) % 360;
}

function cacheKeyForWalkable(radiusMeters) {
  const roundedLat = startPoint.lat.toFixed(4);
  const roundedLng = startPoint.lng.toFixed(4);
  const roundedRadius = Math.round(radiusMeters / 100) * 100;
  return `${roundedLat}|${roundedLng}|${roundedRadius}`;
}

function normalizedSegmentKey(a, b) {
  const aLng = a[0].toFixed(5);
  const aLat = a[1].toFixed(5);
  const bLng = b[0].toFixed(5);
  const bLat = b[1].toFixed(5);
  const first = `${aLng},${aLat}`;
  const second = `${bLng},${bLat}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function routeBacktrackRatio(geometry) {
  const coordinates = geometry?.coordinates || [];
  if (coordinates.length < 2) {
    return 1;
  }

  const seenSegments = new Set();
  let repeated = 0;
  let total = 0;

  for (let i = 1; i < coordinates.length; i += 1) {
    const prev = coordinates[i - 1];
    const next = coordinates[i];
    const segmentMeters = haversineMeters(
      { lat: prev[1], lng: prev[0] },
      { lat: next[1], lng: next[0] }
    );

    if (segmentMeters <= 0) {
      continue;
    }

    total += segmentMeters;
    const key = normalizedSegmentKey(prev, next);
    if (seenSegments.has(key)) {
      repeated += segmentMeters;
    } else {
      seenSegments.add(key);
    }
  }

  if (total <= 0) {
    return 1;
  }

  return repeated / total;
}

function routeQualityScore(route, targetMeters) {
  const distanceDelta = Math.abs(route.meters - targetMeters);
  const loopPenalty = routeBacktrackRatio(route.geometry);
  return distanceDelta + loopPenalty * targetMeters * 0.35;
}

function isNearOsloCenter(point) {
  return haversineMeters(point, OSLO_CENTER) <= OSLO_FALLBACK_MAX_DISTANCE;
}

function getOsloFallbackCandidates(targetMeters) {
  return OSLO_FALLBACK_LOOPS
    .slice()
    .sort(
      (a, b) =>
        Math.abs(a.approxMeters - targetMeters) - Math.abs(b.approxMeters - targetMeters)
    )
    .slice(0, 6)
    .map((template) => ({
      waypoints: template.waypoints,
      templateName: template.name,
      isOsloFallback: true,
    }));
}

function buildOverpassQuery(radiusMeters, maxWays) {
  return `[out:json][timeout:25];
(
  way(around:${Math.round(radiusMeters)},${startPoint.lat},${startPoint.lng})
    ["highway"~"^(${WALKABLE_HIGHWAY_REGEX})$"]
    ["area"!="yes"]
    ["access"!~"^(private|no)$"]
    ["foot"!~"^(private|no)$"];
);
out center ${Math.max(100, maxWays)};`;
}

async function fetchOverpassData(endpoint, query) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OVERPASS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: query,
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Overpass-feil ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function withTimeout(promise, timeoutMs, fallbackValue) {
  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function fetchWalkablePoints(targetMeters, radiusScale = 0.75) {
  const radiusMeters = Math.min(
    WALKABLE_FETCH_RADIUS_MAX,
    Math.max(WALKABLE_FETCH_RADIUS_MIN, targetMeters * radiusScale)
  );
  const key = cacheKeyForWalkable(radiusMeters);

  if (walkableCache.key === key) {
    return walkableCache.points;
  }

  const query = buildOverpassQuery(radiusMeters, WALKABLE_MAX_WAYS);

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const data = await fetchOverpassData(endpoint, query);
      const points = (data.elements || [])
        .map((element) => {
          const center = element.center;
          if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
            return null;
          }

          return {
            lat: center.lat,
            lng: center.lon,
            highway: element.tags?.highway || "",
          };
        })
        .filter(Boolean);

      if (points.length) {
        walkableCache = {
          key,
          points,
        };
        return points;
      }
    } catch {
      // Prøver neste endepunkt
    }
  }

  walkableCache = {
    key,
    points: [],
  };
  return [];
}

async function fetchRouteForCandidate(candidate) {
  const waypoints = Array.isArray(candidate.waypoints)
    ? candidate.waypoints.filter(
        (point) =>
          point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
      )
    : [];

  if (!waypoints.length) {
    return null;
  }

  const coordinates = [
    `${startPoint.lng},${startPoint.lat}`,
    ...waypoints.map((point) => `${point.lng},${point.lat}`),
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
    waypoints,
    templateName: candidate.templateName || null,
    isOsloFallback: Boolean(candidate.isOsloFallback),
  };
}

function buildFallbackCandidates(targetMeters, round = 0, waypointCount = 2) {
  const radius = Math.max(250, targetMeters / (waypointCount + 1));
  const candidates = [];
  const base = (Math.random() * 360 + round * 31 + waypointCount * 17) % 360;
  const spread = 360 / waypointCount;

  for (let i = 0; i < MAX_CANDIDATES; i += 1) {
    const waypoints = [];
    for (let waypointIndex = 0; waypointIndex < waypointCount; waypointIndex += 1) {
      const bearing = (base + spread * waypointIndex + i * (13 + waypointIndex * 3)) % 360;
      const distanceScale = 0.82 + ((i + waypointIndex) % 5) * 0.06;
      waypoints.push(
        destinationPoint(startPoint.lat, startPoint.lng, radius * distanceScale, bearing)
      );
    }

    candidates.push({ waypoints });
  }

  return candidates;
}

function buildNetworkCandidates(targetMeters, round = 0, walkablePoints = [], waypointCount = 2) {
  if (walkablePoints.length < 8) {
    return [];
  }

  const minLeg = 120;
  const maxLeg = Math.max(500, targetMeters * 0.8);
  const idealLeg = Math.max(220, targetMeters / (waypointCount + 1));

  const usable = walkablePoints
    .map((point) => {
      const distance = haversineMeters(startPoint, point);
      const bearing = bearingDegrees(startPoint, point);
      return {
        ...point,
        distance,
        bearing,
      };
    })
    .filter((point) => point.distance >= minLeg && point.distance <= maxLeg);

  if (usable.length < 6) {
    return [];
  }

  const baseIndex = (round * 11) % usable.length;
  const scoredCandidates = [];
  const attempts = Math.min(usable.length * 3, MAX_CANDIDATES * 7);

  for (let i = 0; i < attempts; i += 1) {
    const waypoints = [];
    for (let waypointIndex = 0; waypointIndex < waypointCount; waypointIndex += 1) {
      const point =
        usable[
          (baseIndex + i * 3 + waypointIndex * (5 + round * 2) + waypointIndex * 11) %
            usable.length
        ];
      if (!point) {
        continue;
      }
      waypoints.push(point);
    }

    if (waypoints.length !== waypointCount) {
      continue;
    }

    const uniquePoints = new Set(
      waypoints.map((point) => `${point.lat.toFixed(5)}|${point.lng.toFixed(5)}`)
    );
    if (uniquePoints.size !== waypointCount) {
      continue;
    }

    const bearings = waypoints.map((point) => point.bearing).sort((a, b) => a - b);
    let minGap = 360;
    for (let index = 0; index < bearings.length; index += 1) {
      const current = bearings[index];
      const next = bearings[(index + 1) % bearings.length] + (index + 1 === bearings.length ? 360 : 0);
      minGap = Math.min(minGap, next - current);
    }

    if (minGap < 25) {
      continue;
    }

    let pairwisePenalty = 0;
    for (let index = 1; index < waypoints.length; index += 1) {
      const between = haversineMeters(waypoints[index - 1], waypoints[index]);
      if (between < 120) {
        pairwisePenalty += 250;
      }
    }

    const legBalance =
      waypoints.reduce((sum, point) => sum + Math.abs(point.distance - idealLeg), 0) +
      Math.abs(minGap - 360 / waypointCount) * 2 +
      pairwisePenalty;

    scoredCandidates.push({
      waypoints: waypoints.map((point) => ({ lat: point.lat, lng: point.lng })),
      score: legBalance,
    });
  }

  scoredCandidates.sort((a, b) => a.score - b.score);
  return scoredCandidates
    .slice(0, MAX_CANDIDATES)
    .map(({ waypoints }) => ({ waypoints }));
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];

  for (const candidate of candidates) {
    const key = (candidate.waypoints || [])
      .map((point) => `${point.lat.toFixed(4)}|${point.lng.toFixed(4)}`)
      .join("|");

    if (!key) {
      continue;
    }

    if (!seen.has(key)) {
      seen.add(key);
      result.push(candidate);
    }

    if (result.length >= MAX_CANDIDATES) {
      break;
    }
  }

  return result;
}

function buildCandidates(targetMeters, round = 0, walkablePoints = []) {
  const stage = SEARCH_STAGES[Math.min(round, SEARCH_STAGES.length - 1)] || SEARCH_STAGES[0];
  const waypointCounts = stage.waypointCounts || [2, 3];

  const networkCandidates = waypointCounts.flatMap((waypointCount) =>
    buildNetworkCandidates(targetMeters, round, walkablePoints, waypointCount)
  );
  const fallbackCandidates = waypointCounts.flatMap((waypointCount) =>
    buildFallbackCandidates(targetMeters, round, waypointCount)
  );
  return dedupeCandidates([...networkCandidates, ...fallbackCandidates]);
}

async function evaluateCandidateBatch(batch, targetMeters, seen, toleranceMeters) {
  const routes = await Promise.all(
    batch.map(async (candidate) => {
      try {
        const route = await fetchRouteForCandidate(candidate);
        return route ? { route, candidate } : null;
      } catch {
        return null;
      }
    })
  );

  let accepted = null;
  let best = null;
  let smallestDiff = Number.POSITIVE_INFINITY;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const item of routes) {
    if (!item) {
      continue;
    }

    const hash = hashRoute(item.route.geometry, item.route.meters);
    if (seen.has(hash)) {
      continue;
    }

    const diff = Math.abs(item.route.meters - targetMeters);
    const candidateResult = { ...item.route, hash };
    const score = routeQualityScore(candidateResult, targetMeters);

    if (score < bestScore) {
      best = candidateResult;
      bestScore = score;
    }

    if (diff < smallestDiff) {
      smallestDiff = diff;
    }

    if (diff <= toleranceMeters) {
      if (!accepted || score < accepted.score) {
        accepted = {
          route: candidateResult,
          score,
        };
      }
    }
  }

  return {
    accepted: accepted ? accepted.route : null,
    best,
    smallestDiff,
  };
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
  const targetMeters = Number(metersInput.value);
  if (!Number.isFinite(targetMeters) || targetMeters < MIN_METERS) {
    statusEl.textContent = `Skriv inn minst ${MIN_METERS} meter.`;
    return;
  }

  const requestedSteps = metersToSteps(targetMeters);
  stepsInput.value = String(requestedSteps);
  statusEl.textContent = "Lager forslag langs stier, gangveier og gåbare veier…";
  suggestBtn.disabled = true;

  try {
    const seen = new Set(getSeen());
    let accepted = null;
    let best = null;
    let smallestDiff = Number.POSITIVE_INFINITY;

    for (let round = 0; round < MAX_SEARCH_ROUNDS && !accepted; round += 1) {
      const stage = SEARCH_STAGES[Math.min(round, SEARCH_STAGES.length - 1)] || SEARCH_STAGES[0];
      const toleranceMeters = Math.max(80, targetMeters * stage.tolerancePct);
      statusEl.textContent = `Prøver ${stage.label} toleranse (${roundMeters(toleranceMeters)} meter)…`;

      const walkablePoints = await withTimeout(
        fetchWalkablePoints(targetMeters, stage.radiusScale),
        WALKABLE_FETCH_SOFT_TIMEOUT_MS,
        []
      );

      if (!walkablePoints.length && round === 0) {
        statusEl.textContent = "Fant ikke nok stidata i området. Bruker reserveforslag og utvider søk…";
      }

      const candidates = buildCandidates(targetMeters, round, walkablePoints);

      for (let index = 0; index < candidates.length && !accepted; index += ROUTE_BATCH_SIZE) {
        const batch = candidates.slice(index, index + ROUTE_BATCH_SIZE);
        const result = await evaluateCandidateBatch(batch, targetMeters, seen, toleranceMeters);

        if (result.smallestDiff < smallestDiff) {
          best = result.best;
          smallestDiff = result.smallestDiff;
        }

        if (result.accepted) {
          accepted = result.accepted;
        }
      }
    }

    if (!accepted && isNearOsloCenter(startPoint)) {
      const osloFallbackCandidates = getOsloFallbackCandidates(targetMeters);
      const osloResult = await evaluateCandidateBatch(
        osloFallbackCandidates,
        targetMeters,
        seen,
        Math.max(120, targetMeters * 0.15)
      );

      if (osloResult.smallestDiff < smallestDiff) {
        best = osloResult.best;
        smallestDiff = osloResult.smallestDiff;
      }

      if (osloResult.accepted) {
        accepted = osloResult.accepted;
      }
    }

    if (!accepted && best) {
      accepted = best;
    }

    if (!accepted) {
      statusEl.textContent =
        "Fant ingen rute akkurat nå. Prøv igjen eller flytt startpunkt nær gangvei/sti.";
      suggestionEl.textContent = "Ingen rute innen ønsket toleranse akkurat nå.";
      setCurrentRoute(null);
      stopNavigation();
      return;
    }

    drawRoute(accepted.geometry);
    stopNavigation();

    const distanceKm = (accepted.meters / 1000).toFixed(2);
    const meterDelta = roundMeters(Math.abs(accepted.meters - targetMeters));
    const estimatedSteps = Math.round(accepted.meters / WALKING_STRIDE_METERS);
    const meterValue = roundMeters(accepted.meters);
    const steps = flattenSteps(accepted.legs);

    setCurrentRoute({ ...accepted, steps });

    const fallbackTag = accepted.templateName ? ` (${accepted.templateName})` : "";
    suggestionEl.textContent = `Ca. ${meterValue} meter (${distanceKm} km / ${estimatedSteps} skritt), estimert tid ${formatDuration(accepted.seconds)}.${fallbackTag}`;
    statusEl.textContent = `Turforslag klart (avvik ${meterDelta} meter).`;

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
