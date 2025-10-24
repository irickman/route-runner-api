// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface Env {
  SESSIONS: KVNamespace;
  ANTHROPIC_API_KEY: string;
  MAPBOX_TOKEN: string;
}

interface Location {
  lat: number;
  lng: number;
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

const SEATTLE_LANDMARKS = {
  'space needle': { lat: 47.6205, lng: -122.3493 },
  'kerry park': { lat: 47.6295, lng: -122.3598 },
  'pike place market': { lat: 47.6097, lng: -122.3425 },
  'green lake': { lat: 47.6808, lng: -122.3290 },
};

const CLAUDE_SYSTEM_PROMPT = `You are a running route planner for Seattle. You help parse natural language queries into structured route data.

Known Seattle landmarks:
- Space Needle: (47.6205, -122.3493)
- Kerry Park: (47.6295, -122.3598)
- Pike Place Market: (47.6097, -122.3425)
- Green Lake: (47.6808, -122.3290)

Parse the user's query and return ONLY valid JSON with this structure:
{
  "start": {"lat": number, "lng": number},
  "waypoints": [{"lat": number, "lng": number}],
  "end": {"lat": number, "lng": number},
  "distance_miles": number,
  "max_elevation_gain_feet": number,
  "preferences": ["scenic", "flat", "challenging", etc]
}

Rules:
- If no start location is specified, use the provided user location
- If it's a loop/round trip, start and end should be the same
- Extract distance preferences (e.g., "5 mile run" -> distance_miles: 5)
- Extract elevation preferences (e.g., "easy/flat" -> max_elevation_gain_feet: 100)
- Return ONLY the JSON object, no markdown or explanations`;

async function parseIntentWithClaude(
  query: string,
  userLocation: Location,
  apiKey: string
): Promise<ParsedIntent> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      system: CLAUDE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `User location: (${userLocation.lat}, ${userLocation.lng})\nQuery: ${query}`,
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
      model: 'claude-3-5-haiku-20241022',
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
// ROUTE GENERATION ORCHESTRATOR
// ============================================================================

async function generateRoute(
  request: GenerateRouteRequest,
  env: Env
): Promise<RouteData> {
  // 1. Parse intent with Claude
  const intent = await parseIntentWithClaude(
    request.query,
    request.location,
    env.ANTHROPIC_API_KEY
  );

  // 2. Generate route with Mapbox
  const mapboxRoute = await generateMapboxRoute(intent, env.MAPBOX_TOKEN);

  // 3. Enrich with elevation data
  const elevation = await enrichWithElevation(mapboxRoute.geometry);

  // 4. Calculate statistics
  const stats = calculateStats(mapboxRoute, elevation);

  // 5. Generate creative route name
  const name = await generateRouteName(request.query, stats, env.ANTHROPIC_API_KEY);

  // 6. Create route data object
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

  // 7. Store in KV with 24 hour expiration
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
