import { formatLocationsForPrompt, resolveLocations } from './agents/landmarkAgent';
import { Location, Env } from './types';
import { ModelSelector } from './agents/ai/modelSelector';
import { ParsedIntent } from './agents/ai/types';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface GenerateRouteRequest {
  query: string;
  location: Location;
  sessionId?: string;
}

interface RouteStats {
  distance_miles: number;
  elevation_gain_feet: number;
  num_turns: number;
  duration_minutes: number;
}

interface RouteGeometry {
  type: string;
  coordinates: [number, number][];
}

interface RouteData {
  sessionId: string;
  routeId: string;
  geometry: RouteGeometry;
  stats: RouteStats;
  originalQuery: string;
  name: string;
  elevation?: number[];
  createdAt: string;
}

interface MapboxStep {
  maneuver: {
    type: string;
    instruction: string;
  };
}

interface MapboxRoute {
  geometry: RouteGeometry;
  distance: number;
  duration: number;
  legs: Array<{
    steps: MapboxStep[];
  }>;
}

interface MapboxResponse {
  routes: MapboxRoute[];
}

interface ElevationPoint {
  latitude: number;
  longitude: number;
  elevation?: number;
}

interface ElevationResponse {
  results: ElevationPoint[];
}

// ============================================================================
// CORS AND RESPONSE HELPERS
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// ============================================================================
// MAPBOX API - ROUTE GENERATION
// ============================================================================

async function generateMapboxRoute(
  intent: ParsedIntent,
  mapboxToken: string
): Promise<MapboxRoute> {
  // Build coordinates array: start -> waypoints -> end
  const coords: Location[] = [intent.start];
  if (intent.waypoints && intent.waypoints.length > 0) {
    coords.push(...intent.waypoints);
  }
  coords.push(intent.end);

  // Mapbox expects lng,lat format (longitude first!)
  const coordsString = coords.map(c => `${c.lng},${c.lat}`).join(';');

  const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coordsString}?geometries=geojson&overview=full&steps=true&access_token=${mapboxToken}`;

  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Mapbox API error: ${error}`);
  }

  const data: MapboxResponse = await response.json();

  if (!data.routes || data.routes.length === 0) {
    throw new Error('No routes found from Mapbox');
  }

  return data.routes[0];
}

// ============================================================================
// ELEVATION API - ENRICHMENT
// ============================================================================

async function enrichWithElevation(
  geometry: RouteGeometry
): Promise<number[]> {
  try {
    // Sample every 10th coordinate to reduce API calls
    const sampledCoords = geometry.coordinates.filter((_, i) => i % 10 === 0);

    const response = await fetch('https://api.open-elevation.com/api/v1/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locations: sampledCoords.map(([lng, lat]) => ({
          latitude: lat,
          longitude: lng,
        })),
      }),
    });

    if (!response.ok) {
      console.warn('Elevation API failed, continuing without elevation data');
      return [];
    }

    const data: ElevationResponse = await response.json();
    return data.results.map(r => r.elevation || 0);
  } catch (error) {
    console.warn('Elevation enrichment failed:', error);
    return [];
  }
}

// ============================================================================
// STATISTICS CALCULATION
// ============================================================================

function calculateStats(
  mapboxRoute: MapboxRoute,
  elevation: number[]
): RouteStats {
  // Distance: Mapbox returns meters, convert to miles
  const distance_miles = mapboxRoute.distance * 0.000621371;

  // Calculate elevation gain from elevation array (in meters, convert to feet)
  let elevation_gain_feet = 0;
  if (elevation.length > 1) {
    for (let i = 1; i < elevation.length; i++) {
      const gain = elevation[i] - elevation[i - 1];
      if (gain > 0) {
        elevation_gain_feet += gain;
      }
    }
    elevation_gain_feet *= 3.28084; // meters to feet
  }

  // Count turns (maneuvers that aren't "depart" or "arrive")
  let num_turns = 0;
  for (const leg of mapboxRoute.legs) {
    for (const step of leg.steps) {
      const type = step.maneuver.type;
      if (type !== 'depart' && type !== 'arrive') {
        num_turns++;
      }
    }
  }

  // Duration: Mapbox returns seconds, convert to minutes
  const duration_minutes = mapboxRoute.duration / 60;

  return {
    distance_miles: Math.round(distance_miles * 100) / 100,
    elevation_gain_feet: Math.round(elevation_gain_feet),
    num_turns,
    duration_minutes: Math.round(duration_minutes),
  };
}

// ============================================================================
// GPX GENERATION
// ============================================================================

function generateGPX(route: RouteData): string {
  const trackpoints = route.geometry.coordinates
    .map(([lng, lat], i) => {
      // Use elevation data if available (sampled every 10 points)
      const elevationIndex = Math.floor(i / 10);
      const elevation = route.elevation && route.elevation[elevationIndex]
        ? route.elevation[elevationIndex]
        : undefined;

      const eleTag = elevation !== undefined ? `<ele>${elevation}</ele>` : '';

      return `    <trkpt lat="${lat}" lon="${lng}">
      ${eleTag}
    </trkpt>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Route Runner API" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(route.name)}</name>
    <time>${route.createdAt}</time>
  </metadata>
  <trk>
    <name>${escapeXml(route.name)}</name>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================================
// DISTANCE CALCULATION AND WAYPOINT GENERATION
// ============================================================================

function estimateRouteDistance(points: Location[]): number {
  // Uses Haversine formula to calculate distance between coordinates
  let totalMiles = 0;

  for (let i = 1; i < points.length; i++) {
    const lat1 = points[i - 1].lat * Math.PI / 180;
    const lat2 = points[i].lat * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLng = (points[i].lng - points[i - 1].lng) * Math.PI / 180;

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const km = 6371 * c; // Earth radius in km
    totalMiles += km * 0.621371; // Convert to miles
  }

  return Math.round(totalMiles * 100) / 100; // Round to 2 decimal places
}

function generateAdditionalWaypoints(
  start: Location,
  end: Location,
  targetMiles: number,
  currentMiles: number
): Location[] {
  const additionalWaypoints: Location[] = [];
  const shortage = targetMiles - currentMiles;

  if (shortage <= 0) {
    return additionalWaypoints; // No waypoints needed
  }

  // Create a more subtle zigzag pattern that's more likely to follow streets
  const numWaypoints = Math.max(2, Math.ceil(shortage / 0.5));

  console.log(`🎯 Need ${shortage.toFixed(2)} more miles, generating ${numWaypoints} waypoints`);

  const latDiff = end.lat - start.lat;
  const lngDiff = end.lng - start.lng;

  // Create alternating offsets perpendicular to the main route
  for (let i = 0; i < numWaypoints; i++) {
    const t = (i + 1) / (numWaypoints + 1);

    // Smaller offset that's more likely to stay on roads
    // Alternate sides for zigzag pattern
    const offsetScale = (shortage * 0.004) * (i % 2 === 0 ? 1 : -1);

    additionalWaypoints.push({
      lat: start.lat + latDiff * t + lngDiff * offsetScale,
      lng: start.lng + lngDiff * t - latDiff * offsetScale
    });
  }

  return additionalWaypoints;
}

// ============================================================================
// ROUTE GENERATION ORCHESTRATOR
// ============================================================================

async function generateRoute(
  request: GenerateRouteRequest,
  env: Env
): Promise<RouteData> {
  // 0. Resolve nearby locations (landmarks & destinations) near the user's position
  const locationResult = await resolveLocations(
    request.query,
    request.location,
    env.MAPBOX_TOKEN
  );

  const locationContext = formatLocationsForPrompt(locationResult.locations);
  if (locationResult.locations.length > 0) {
    console.log('📍 Nearby locations:', JSON.stringify(locationResult.locations, null, 2));
  }
  if (locationResult.mentions.length > 0) {
    console.log('📝 Location mentions:', JSON.stringify(locationResult.mentions, null, 2));
  }

  // 1. Select AI Provider and Parse Intent
  const modelSelector = new ModelSelector(env);
  const provider = modelSelector.getProvider(request.query);

  let intent = await provider.parseIntent(
    request.query,
    request.location,
    locationContext || undefined
  );

  console.log('📋 Parsed intent:', JSON.stringify(intent, null, 2));

  // 2. Validate and extend route if distance target is specified
  if (intent.distance_miles && intent.distance_miles > 0) {
    const coords = [intent.start, ...(intent.waypoints || []), intent.end];
    const estimatedMiles = estimateRouteDistance(coords);

    console.log(`📏 Target distance: ${intent.distance_miles} miles`);
    console.log(`📏 Estimated distance from waypoints: ${estimatedMiles} miles`);

    // If route is too short (< 80% of target), add waypoints
    const threshold = intent.distance_miles * 0.8;
    if (estimatedMiles < threshold) {
      console.log(`⚠️  Route is too short! ${estimatedMiles} < ${threshold} (80% of target)`);

      const additionalWaypoints = generateAdditionalWaypoints(
        intent.start,
        intent.end,
        intent.distance_miles,
        estimatedMiles
      );

      if (additionalWaypoints.length > 0) {
        // Insert additional waypoints in the middle of the route
        const originalWaypoints = intent.waypoints || [];
        intent.waypoints = [...originalWaypoints, ...additionalWaypoints];
      }
    }
  }

  // 3. Generate route with Mapbox
  let mapboxRoute = await generateMapboxRoute(intent, env.MAPBOX_TOKEN);

  // Calculate initial stats without elevation to check distance accuracy
  let stats = calculateStats(mapboxRoute, []);

  // ==========================================================================
  // ACCURACY IMPROVEMENT: ITERATIVE FEEDBACK LOOP
  // ==========================================================================
  if (intent.distance_miles) {
    const errorMargin = Math.abs(stats.distance_miles - intent.distance_miles) / intent.distance_miles;

    // If error is > 15%, try to self-correct once
    if (errorMargin > 0.15) {
      console.warn(`⚠️ Route accuracy low (${(errorMargin * 100).toFixed(1)}% off). Attempting self-correction...`);

      const feedbackQuery = `
        ORIGINAL REQUEST: ${request.query}
        PREVIOUS ATTEMPT STATS: ${stats.distance_miles} miles.
        TARGET: ${intent.distance_miles} miles.
        ERROR: The route was too ${stats.distance_miles < intent.distance_miles ? 'short' : 'long'}.
        INSTRUCTION: Please adjust the waypoints to get closer to ${intent.distance_miles} miles. 
        If it was too short, extend the loop further out. If too long, cut it shorter.
      `;

      try {
        const newIntent = await provider.parseIntent(
          feedbackQuery,
          request.location,
          locationContext || undefined
        );

        // Merge new waypoints but keep original start/end if they were correct
        intent.waypoints = newIntent.waypoints;

        console.log('🔄 Retrying with new intent...');
        mapboxRoute = await generateMapboxRoute(intent, env.MAPBOX_TOKEN);
        // Recalculate stats for the new route (still without elevation)
        stats = calculateStats(mapboxRoute, []);
        console.log(`✅ Retry result: ${stats.distance_miles} miles`);
      } catch (e) {
        console.error('❌ Self-correction failed:', e);
        // Continue with original route if retry fails
      }
    }
  }

  // 4. Enrich with elevation and generate name in parallel
  // We pass the current stats (with 0 elevation) to generateName to avoid waiting
  const [elevation, name] = await Promise.all([
    enrichWithElevation(mapboxRoute.geometry),
    provider.generateName(request.query, stats)
  ]);

  // 5. Finalize stats with actual elevation data
  stats = calculateStats(mapboxRoute, elevation);

  // 8. Create route data object
  const sessionId = request.sessionId || crypto.randomUUID();
  const routeId = crypto.randomUUID();

  const routeData: RouteData = {
    sessionId,
    routeId,
    geometry: mapboxRoute.geometry,
    stats,
    originalQuery: request.query,
    name,
    elevation,
    createdAt: new Date().toISOString(),
  };

  // 9. Store in KV with 24 hour expiration
  const kvKey = `route:${sessionId}:${routeId}`;
  await env.SESSIONS.put(kvKey, JSON.stringify(routeData), {
    expirationTtl: 86400, // 24 hours in seconds
  });

  return routeData;
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

async function handleGenerateRoute(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body: GenerateRouteRequest = await request.json();

    if (!body.query || !body.location || !body.location.lat || !body.location.lng) {
      return errorResponse('Missing required fields: query, location.lat, location.lng');
    }

    const routeData = await generateRoute(body, env);

    return jsonResponse({
      sessionId: routeData.sessionId,
      routeId: routeData.routeId,
      name: routeData.name,
      geometry: routeData.geometry,
      stats: routeData.stats,
    });
  } catch (error: any) {
    console.error('Error generating route:', error);
    return errorResponse(error.message || 'Failed to generate route', 500);
  }
}

async function handleGetRoute(
  sessionId: string,
  routeId: string,
  env: Env
): Promise<Response> {
  try {
    const kvKey = `route:${sessionId}:${routeId}`;
    const data = await env.SESSIONS.get(kvKey);

    if (!data) {
      return errorResponse('Route not found', 404);
    }

    const routeData: RouteData = JSON.parse(data);
    return jsonResponse(routeData);
  } catch (error: any) {
    console.error('Error fetching route:', error);
    return errorResponse(error.message || 'Failed to fetch route', 500);
  }
}

async function handleGetGPX(
  sessionId: string,
  routeId: string,
  env: Env
): Promise<Response> {
  try {
    const kvKey = `route:${sessionId}:${routeId}`;
    const data = await env.SESSIONS.get(kvKey);

    if (!data) {
      return errorResponse('Route not found', 404);
    }

    const routeData: RouteData = JSON.parse(data);
    const gpx = generateGPX(routeData);

    return new Response(gpx, {
      status: 200,
      headers: {
        'Content-Type': 'application/gpx+xml',
        'Content-Disposition': `attachment; filename="route-${routeId}.gpx"`,
        ...CORS_HEADERS,
      },
    });
  } catch (error: any) {
    console.error('Error generating GPX:', error);
    return errorResponse(error.message || 'Failed to generate GPX', 500);
  }
}

// ============================================================================
// MAIN FETCH HANDLER
// ============================================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Route handling
    if (request.method === 'POST' && path === '/api/generate-route') {
      return handleGenerateRoute(request, env);
    }

    // GET /api/route/:sessionId/:routeId/gpx
    const gpxMatch = path.match(/^\/api\/route\/([^\/]+)\/([^\/]+)\/gpx$/);
    if (request.method === 'GET' && gpxMatch) {
      const [, sessionId, routeId] = gpxMatch;
      return handleGetGPX(sessionId, routeId, env);
    }

    // GET /api/route/:sessionId/:routeId
    const routeMatch = path.match(/^\/api\/route\/([^\/]+)\/([^\/]+)$/);
    if (request.method === 'GET' && routeMatch) {
      const [, sessionId, routeId] = routeMatch;
      return handleGetRoute(sessionId, routeId, env);
    }

    return errorResponse('Not found', 404);
  },
};
