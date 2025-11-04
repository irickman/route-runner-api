import { formatLocationsForPrompt, resolveLocations } from './agents/landmarkAgent';
import { Location } from './types';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface Env {
  SESSIONS: KVNamespace;
  ANTHROPIC_API_KEY: string;
  MAPBOX_TOKEN: string;
}

interface GenerateRouteRequest {
  query: string;
  location: Location;
  sessionId?: string;
}

interface ParsedIntent {
  start: Location;
  waypoints?: Location[];
  end: Location;
  distance_miles?: number;
  max_elevation_gain_feet?: number;
  preferences?: string[];
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

interface ClaudeResponse {
  content: Array<{
    text: string;
  }>;
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
// CLAUDE API - INTENT PARSING
// ============================================================================

const CLAUDE_SYSTEM_PROMPT = `You are a running route planner. You help parse natural language queries into structured route data.

You will receive:
- The user's location.
- Optionally, a "Nearby locations" section listing places the Location Agent found within 25 miles of the user. Each line is formatted as:
  Name — type — latitude, longitude — purpose=landmark/destination/perimeter — extra notes (if provided).
- Purpose describes how the user referenced the place (destination = potential start/end or turnaround, perimeter = outline to trace, landmark = mid-route waypoint context).

CRITICAL: When a user specifies a distance (e.g., "10 mile run"), the total geodesic length from start → waypoints → end MUST be within ±10% of that distance. If your draft is outside that band, adjust the coordinates and re-check before returning JSON.

Waypoint guidance:
- Keep successive waypoints roughly 0.4-0.7 miles apart; never exceed 1.0 mile between points.
- Provide at least 1 waypoint per mile when possible and cap the list at 50 waypoints to support ultra distances.
- Add distance with gentle zigzags or compact loops instead of far-flung detours.

Loops / round trips:
- Start and end coordinates must match exactly.
- Push waypoints outward so the halfway point is about distance_miles / 2, then return to the start.

Out-and-back routes:
- The furthest waypoint should be approximately distance_miles / 2 from the start.
- The route should retrace its path from that turnaround point.

"Run around <destination>" (stadium, body of water, neighborhood, etc.):
- Treat the request as a perimeter loop hugging the outer edge of the destination.
- If the Location Agent provides perimeter_points or a bounding box, shape waypoints along that outline before returning to the start.
- If no perimeter data is available, approximate the perimeter by spacing waypoints around the feature while staying on plausible running paths.

Elevation preferences:
- "Flat"/"easy" → set max_elevation_gain_feet ≤ 150 and favor low-lying terrain.
- "Hilly"/"challenging" → set max_elevation_gain_feet ≥ 300 and include climbs.
- If no elevation preference is stated, leave max_elevation_gain_feet null.

EXAMPLE ROUTES (for reference):

Example 1: "8.5 mile run around Lake Union"
- Type: Perimeter loop around landmark
- Start/End: Same coordinates (loop closure)
- Sampled waypoints (12 total, ~0.7 mi spacing):
  {"start": {"lat": 47.6107, "lng": -122.3356}, "waypoints": [{"lat": 47.6259, "lng": -122.3385}, {"lat": 47.6433, "lng": -122.3268}, {"lat": 47.6513, "lng": -122.3304}, {"lat": 47.6442, "lng": -122.3446}, {"lat": 47.6226, "lng": -122.3383}], "end": {"lat": 47.6107, "lng": -122.3356}, "distance_miles": 8.5}

Example 2: "12.5 mile loop with less than 800 feet of elevation gain"
- Type: Distance + elevation constraint
- Start/End: Same coordinates (loop closure)
- Sampled waypoints (18 total, ~0.7 mi spacing):
  {"start": {"lat": 47.6758, "lng": -122.2691}, "waypoints": [{"lat": 47.6671, "lng": -122.3021}, {"lat": 47.6873, "lng": -122.3123}, {"lat": 47.7139, "lng": -122.3125}, {"lat": 47.7211, "lng": -122.3020}, {"lat": 47.7136, "lng": -122.2774}], "end": {"lat": 47.6793, "lng": -122.2654}, "distance_miles": 12.5, "max_elevation_gain_feet": 800}

Example 3: "4 mile lollipop loop around Lake Waneka"
- Type: Out-and-back with loop at turnaround
- Pattern: Approach stick (1 mi) → lake perimeter loop (2 mi) → return via same stick (1 mi)
- Sampled waypoints (6 total, densely packed around lake):
  {"start": {"lat": 39.9886, "lng": -105.0886}, "waypoints": [{"lat": 39.9942, "lng": -105.1056}, {"lat": 39.9973, "lng": -105.1123}, {"lat": 39.9931, "lng": -105.1129}, {"lat": 39.9942, "lng": -105.1065}], "end": {"lat": 39.9886, "lng": -105.0886}, "distance_miles": 4.0}

Example 4: "7 mile run through Carkeek Park ending at Golden Gardens"
- Type: Point-to-point with landmark waypoint
- Start ≠ End (not a loop)
- Sampled waypoints (10 total, route forced through Carkeek Park):
  {"start": {"lat": 47.6869, "lng": -122.3364}, "waypoints": [{"lat": 47.6979, "lng": -122.3581}, {"lat": 47.7089, "lng": -122.3660}, {"lat": 47.7110, "lng": -122.3796}, {"lat": 47.6948, "lng": -122.3789}], "end": {"lat": 47.6833, "lng": -122.4029}, "distance_miles": 7.0}

Example 5: "21 mile run through Rock Creek Park, National Mall, Anacostia River Trail, and Rachel Carson Greenway"
- Type: Multi-landmark tour with loop closure
- Start/End: Same coordinates (returns to start after hitting all 4 landmarks)
- Sampled waypoints (35 total, ~0.6 mi spacing to hit all landmarks):
  {"start": {"lat": 38.9268, "lng": -77.0272}, "waypoints": [{"lat": 38.9046, "lng": -77.0564}, {"lat": 38.8898, "lng": -77.0060}, {"lat": 38.9085, "lng": -76.9535}, {"lat": 38.9319, "lng": -76.9389}, {"lat": 38.9496, "lng": -76.9676}], "end": {"lat": 38.9268, "lng": -77.0272}, "distance_miles": 21.0}

Before returning JSON:
1. Estimate the total distance using the Haversine formula across your coordinates.
2. If the distance is outside ±10% of the target, adjust waypoint placement and re-check.
3. Ensure coordinates remain plausible for running (no water crossings without bridges, avoid restricted zones).

Parse the user's query and return ONLY valid JSON with this structure:
{
  "start": {"lat": number, "lng": number},
  "waypoints": [{"lat": number, "lng": number}],
  "end": {"lat": number, "lng": number},
  "distance_miles": number,
  "max_elevation_gain_feet": number | null,
  "preferences": ["scenic", "flat", "challenging", etc]
}

Rules:
- If no start location is specified, use the provided user location.
- For loops/round trips, start and end must be the same coordinate.
- Extract distance and elevation preferences from the query.
- Respond with ONLY the JSON object—no markdown or commentary.`;

async function parseIntentWithClaude(
  query: string,
  userLocation: Location,
  apiKey: string,
  locationContext?: string
): Promise<ParsedIntent> {
  const messageSections = [
    `User location: (${userLocation.lat}, ${userLocation.lng})`,
  ];

  if (locationContext && locationContext.trim().length > 0) {
    messageSections.push(locationContext.trim());
  }

  messageSections.push(`Query: ${query}`);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: CLAUDE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: messageSections.join('\n\n'),
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${error}`);
  }

  const data = await response.json() as ClaudeResponse;
  const content = data.content[0].text;

  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = content.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return parsed;
  } catch (e) {
    throw new Error(`Failed to parse Claude response as JSON: ${jsonStr}`);
  }
}

async function generateRouteName(
  query: string,
  stats: RouteStats,
  apiKey: string
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: `Generate a fun, creative 2-word name for this running route. The name should be catchy and evocative.

Route details:
- Description: ${query}
- Distance: ${stats.distance_miles} miles
- Elevation gain: ${stats.elevation_gain_feet} feet

Respond with ONLY the 2-word name, nothing else. Examples: "Sunset Sprint", "Harbor Loop", "Hill Warrior"`,
        },
      ],
    }),
  });

  if (!response.ok) {
    // If name generation fails, fall back to a generic name
    console.warn('Failed to generate route name, using fallback');
    return 'Adventure Run';
  }

  const data = await response.json() as ClaudeResponse;
  const name = data.content[0].text.trim().replace(/['"]/g, '');

  // Ensure it's actually 2 words, otherwise use fallback
  const wordCount = name.split(/\s+/).length;
  if (wordCount !== 2) {
    return 'Adventure Run';
  }

  return name;
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

  // Calculate number of waypoints needed (one per 0.5-0.75 miles of shortage)
  const numWaypoints = Math.max(1, Math.ceil(shortage / 0.6));

  console.log(`🎯 Need ${shortage.toFixed(2)} more miles, generating ${numWaypoints} waypoints`);

  // Calculate midpoint between start and end
  const midLat = (start.lat + end.lat) / 2;
  const midLng = (start.lng + end.lng) / 2;

  // Create a perpendicular offset to extend the route
  // This creates a detour that adds distance without going too far off course
  const latDiff = end.lat - start.lat;
  const lngDiff = end.lng - start.lng;

  // Perpendicular vector (rotate 90 degrees)
  const perpLat = -lngDiff;
  const perpLng = latDiff;

  // Normalize and scale based on shortage
  const magnitude = Math.sqrt(perpLat * perpLat + perpLng * perpLng);
  const scaleFactor = (shortage * 0.01) / (magnitude || 1); // Scale based on shortage

  // Generate waypoints in a pattern to add distance
  for (let i = 0; i < numWaypoints; i++) {
    const t = (i + 1) / (numWaypoints + 1); // Position along the route (0 to 1)
    const offsetMultiplier = Math.sin(t * Math.PI); // Create a smooth arc

    additionalWaypoints.push({
      lat: midLat + perpLat * scaleFactor * offsetMultiplier,
      lng: midLng + perpLng * scaleFactor * offsetMultiplier
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

  // 1. Parse intent with Claude
  let intent = await parseIntentWithClaude(
    request.query,
    request.location,
    env.ANTHROPIC_API_KEY,
    locationContext || undefined
  );

  console.log('📋 Parsed intent:', JSON.stringify(intent, null, 2));

  // 2. Validate and extend route if distance target is specified
  if (intent.distance_miles && intent.distance_miles > 0) {
    const coords = [intent.start, ...(intent.waypoints || []), intent.end];
    const estimatedMiles = estimateRouteDistance(coords);

    console.log(`📏 Target distance: ${intent.distance_miles} miles`);
    console.log(`📏 Estimated distance from waypoints: ${estimatedMiles} miles`);
    console.log(`📍 Current waypoints: ${intent.waypoints?.length || 0}`);

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

        const newEstimate = estimateRouteDistance([
          intent.start,
          ...intent.waypoints,
          intent.end
        ]);

        console.log(`✅ Added ${additionalWaypoints.length} waypoints`);
        console.log(`📏 New estimated distance: ${newEstimate} miles`);
      }
    } else {
      console.log(`✅ Route distance looks good: ${estimatedMiles} miles (>= ${threshold})`);
    }
  }

  // 3. Generate route with Mapbox
  const mapboxRoute = await generateMapboxRoute(intent, env.MAPBOX_TOKEN);

  // 4. Enrich with elevation data
  const elevation = await enrichWithElevation(mapboxRoute.geometry);

  // 5. Calculate statistics
  const stats = calculateStats(mapboxRoute, elevation);

  console.log(`📊 Final route stats: ${stats.distance_miles} miles, ${stats.elevation_gain_feet} ft gain, ${stats.num_turns} turns`);

  // 6. Log distance accuracy if target was specified
  if (intent.distance_miles) {
    const accuracy = (stats.distance_miles / intent.distance_miles) * 100;
    console.log(`🎯 Distance accuracy: ${accuracy.toFixed(1)}% (target: ${intent.distance_miles}, actual: ${stats.distance_miles})`);

    if (stats.distance_miles < intent.distance_miles * 0.8) {
      console.warn(`⚠️  WARNING: Final route is still ${stats.distance_miles} miles, target was ${intent.distance_miles} miles`);
    }
  }

  // 7. Generate creative route name
  const name = await generateRouteName(request.query, stats, env.ANTHROPIC_API_KEY);

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
