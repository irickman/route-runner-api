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

CRITICAL RULES:

1. DISTANCE ACCURACY: When a user specifies a distance (e.g., "10 mile run"), the total geodesic length from start → waypoints → end MUST be within ±10% of that distance. Calculate using Haversine formula and verify before returning JSON.

2. ONE-WAY vs LOOPS:
   - "One way" / "point to point" / "ending at" = start.lat,lng ≠ end.lat,lng (different locations)
   - "Loop" / "round trip" / "back to start" = start.lat,lng === end.lat,lng (exactly same)

3. "AROUND" A LANDMARK (perimeter routes):
   - When user says "around <place>" (e.g., "around Green Lake"), this means tracing the PERIMETER
   - Use perimeter_points from the Location Agent if available
   - If no perimeter_points, create 8-12 waypoints that form a loop AROUND the feature
   - Waypoints should be evenly distributed around the perimeter at approximately equal distances
   - For "run around X then continue to Y": First create perimeter waypoints around X, THEN add waypoints continuing toward Y

4. MULTI-SEGMENT ROUTES:
   - "Run around X and continue to Y" = perimeter loop at X (waypoints circling X), then continue with waypoints toward Y
   - "Run around X then Y" = perimeter at X, then perimeter at Y
   - Ensure each segment has adequate waypoints (8-12 for perimeters, 1 per 0.5-0.7 mi for straight segments)

5. WAYPOINT SPACING:
   - Keep successive waypoints 0.4-0.7 miles apart for straight segments
   - For perimeter loops, space waypoints evenly around the feature (closer together, ~0.3-0.5 mi)
   - Never exceed 1.0 mile between points
   - Cap at 50 waypoints for ultra distances

6. TRAIL/PATH NAMES:
   - "Continue on [trail name]" or "along [trail name]" = add waypoints following that trail
   - Use Location Agent data if the trail appears in nearby locations
   - Space waypoints along the trail to maintain target distance

EXAMPLE ROUTES:

Example 1: "8.5 mile run around Lake Union"
- Type: Perimeter loop around landmark
- Start/End: Same coordinates (loop closure)
- Sampled waypoints (12 total, evenly spaced around perimeter):
  {"start": {"lat": 47.6107, "lng": -122.3356}, "waypoints": [{"lat": 47.6259, "lng": -122.3385}, {"lat": 47.6433, "lng": -122.3268}, {"lat": 47.6513, "lng": -122.3304}, {"lat": 47.6442, "lng": -122.3446}, {"lat": 47.6226, "lng": -122.3383}], "end": {"lat": 47.6107, "lng": -122.3356}, "distance_miles": 8.5}

Example 2: "10 mile one way run around Green Lake and continue on Burke Gilman Trail ending at Laurelhurst Elementary"
- Type: Perimeter loop THEN point-to-point continuation
- Start ≠ End (one way, not returning)
- First segment: waypoints circling Green Lake (~3 mi)
- Second segment: waypoints along Burke Gilman Trail to final destination (~7 mi)
- Sampled waypoints (15 total):
  {"start": {"lat": 47.6790, "lng": -122.3415}, "waypoints": [{"lat": 47.6820, "lng": -122.3380}, {"lat": 47.6845, "lng": -122.3310}, {"lat": 47.6820, "lng": -122.3250}, {"lat": 47.6780, "lng": -122.3245}, {"lat": 47.6750, "lng": -122.3285}, {"lat": 47.6760, "lng": -122.3360}, {"lat": 47.6850, "lng": -122.3200}, {"lat": 47.6910, "lng": -122.3080}, {"lat": 47.6970, "lng": -122.2950}, {"lat": 47.7000, "lng": -122.2820}, {"lat": 47.6950, "lng": -122.2720}, {"lat": 47.6900, "lng": -122.2650}, {"lat": 47.6840, "lng": -122.2590}], "end": {"lat": 47.6810, "lng": -122.2530}, "distance_miles": 10.0}

Example 3: "7 mile run through Carkeek Park ending at Golden Gardens"
- Type: Point-to-point with landmark waypoint
- Start ≠ End (not a loop)
- Route must pass through Carkeek Park
- Sampled waypoints (10 total, route forced through Carkeek Park):
  {"start": {"lat": 47.6869, "lng": -122.3364}, "waypoints": [{"lat": 47.6979, "lng": -122.3581}, {"lat": 47.7089, "lng": -122.3660}, {"lat": 47.7110, "lng": -122.3796}, {"lat": 47.6948, "lng": -122.3789}], "end": {"lat": 47.6833, "lng": -122.4029}, "distance_miles": 7.0}

Before returning JSON:
1. Count your waypoints and estimate the total distance using the Haversine formula.
2. Verify the distance is within ±10% of the target.
3. For "around X then to Y" routes: ensure waypoints circle X before continuing to Y.
4. For "one way" routes: ensure start ≠ end.
5. Ensure coordinates remain plausible for running (follow roads/trails, no water crossings without bridges).

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
- For one-way routes, start and end must be different coordinates.
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
      model: 'claude-haiku-4-5-20251001',
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
      model: 'claude-haiku-4-5-20251001',
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
